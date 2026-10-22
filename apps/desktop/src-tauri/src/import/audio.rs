//! Audio-file import decode path (Intelligence Layer, Slice 7).
//!
//! Turns an external recording (MP3/M4A/MP4/WAV/FLAC/OGG/AAC/MKV/WebM) into
//! 16 kHz mono f32 PCM — the exact shape the live-recording pipeline feeds to
//! `AsrEngine` and the diarizer — so an imported file runs the REAL pipeline,
//! not a lookalike. Decoding is pure-Rust symphonia; there is no ffmpeg. WMA
//! and Opus-in-WebM/OGG are not decodable yet (they need an ffmpeg sidecar —
//! licensing call pending) and fail with a clear message instead.
//!
//! Peak RAM is capped by resampling to 16 kHz *while* decoding: only the 16 k
//! mono buffer accumulates (≈115 MB/hour), never the native-rate stream.

use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::transcribe::WHISPER_RATE;

/// Extensions the audio-import path accepts (video containers included —
/// only their audio track is used).
pub const AUDIO_EXTENSIONS: &[&str] =
    &["mp3", "m4a", "mp4", "wav", "flac", "ogg", "aac", "mkv", "webm"];

pub fn is_audio_extension(ext: &str) -> bool {
    AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

/// A decoded recording, ready for the transcription pipeline.
#[derive(Debug)]
pub struct DecodedAudio {
    /// 16 kHz mono f32 PCM (whisper/diarizer input shape).
    pub samples_16k: Vec<f32>,
    /// Duration derived from the decoded samples (provenance).
    pub duration_ms: i64,
    /// The file's native sample rate (provenance).
    pub source_sample_rate: u32,
}

/// Decode a media file's default audio track to 16 kHz mono PCM.
pub fn decode_audio_file(path: &Path) -> Result<DecodedAudio, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !is_audio_extension(&ext) {
        return Err(format!(
            "unsupported audio type \".{ext}\" — import {}",
            AUDIO_EXTENSIONS.join(", ").to_uppercase()
        ));
    }

    let file = std::fs::File::open(path).map_err(|e| format!("could not open file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(&ext);
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("could not read \"{ext}\" audio: {e}"))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "the file contains no decodable audio track".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder for this audio codec: {e}"))?;

    let mut samples_16k: Vec<f32> = Vec::new();
    let mut resampler: Option<StreamingResampler> = None;
    let mut source_rate = 0u32;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // End of stream (symphonia reports it as an IO error).
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("error reading audio: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                if source_rate == 0 {
                    source_rate = spec.rate;
                    resampler = Some(StreamingResampler::new(spec.rate));
                }
                let needs_new = sample_buf
                    .as_ref()
                    .map(|b| b.capacity() < decoded.capacity() * spec.channels.count())
                    .unwrap_or(true);
                if needs_new {
                    sample_buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
                }
                let buf = sample_buf.as_mut().unwrap();
                buf.copy_interleaved_ref(decoded);
                let mono = crate::audio::downmix_to_mono(buf.samples(), spec.channels.count());
                resampler.as_mut().unwrap().push(&mono, &mut samples_16k);
            }
            // A corrupt packet mid-file is recoverable — skip it.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("error decoding audio: {e}")),
        }
    }

    if samples_16k.is_empty() || source_rate == 0 {
        return Err("no audio could be decoded from this file — it may be corrupt or use an unsupported codec (WMA and Opus are not supported yet)".to_string());
    }
    let duration_ms = (samples_16k.len() as i64 * 1000) / WHISPER_RATE as i64;
    Ok(DecodedAudio { samples_16k, duration_ms, source_sample_rate: source_rate })
}

/// Linear-interpolation resampler to 16 kHz that works chunk-by-chunk,
/// carrying one sample across chunk boundaries — same math as
/// `audio::resample_to_16k` without needing the whole stream in memory.
pub struct StreamingResampler {
    in_rate: u32,
    /// Next output sample's position, in input samples, measured from the
    /// start of the current virtual view ([carry] + chunk).
    pos: f64,
    prev: f32,
    has_prev: bool,
}

impl StreamingResampler {
    pub fn new(in_rate: u32) -> Self {
        Self { in_rate, pos: 0.0, prev: 0.0, has_prev: false }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        if self.in_rate == WHISPER_RATE {
            out.extend_from_slice(input);
            return;
        }
        let step = self.in_rate as f64 / WHISPER_RATE as f64;
        let carry = self.has_prev as usize;
        let vlen = input.len() + carry;
        let get = |i: usize| -> f32 {
            if i < carry {
                self.prev
            } else {
                input[i - carry]
            }
        };
        while (self.pos.floor() as usize) + 1 < vlen {
            let idx = self.pos.floor() as usize;
            let frac = (self.pos - idx as f64) as f32;
            let a = get(idx);
            let b = get(idx + 1);
            out.push(a + (b - a) * frac);
            self.pos += step;
        }
        // Keep the final sample so the first output of the next chunk can
        // interpolate across the boundary.
        self.prev = get(vlen - 1);
        self.has_prev = true;
        self.pos -= (vlen - 1) as f64;
    }
}

/// Split a 16 kHz buffer into ~`target_secs` transcription windows, cutting
/// each window at the quietest 100 ms inside its final `search_secs` so words
/// aren't sliced mid-syllable. Spans are contiguous and cover the buffer.
pub fn chunk_spans(samples: &[f32], target_secs: usize, search_secs: usize) -> Vec<(usize, usize)> {
    const RATE: usize = WHISPER_RATE as usize;
    const HOP: usize = RATE / 10; // 100 ms
    let target = target_secs * RATE;
    let search = search_secs.min(target_secs / 2) * RATE;
    let mut spans = Vec::new();
    let mut start = 0usize;
    while start < samples.len() {
        let ideal_end = start + target;
        if ideal_end >= samples.len() {
            spans.push((start, samples.len()));
            break;
        }
        let from = ideal_end - search;
        let mut best = ideal_end;
        let mut best_rms = f32::MAX;
        let mut at = from;
        while at + HOP <= ideal_end {
            let r = crate::audio::rms(&samples[at..at + HOP]);
            if r < best_rms {
                best_rms = r;
                best = at + HOP / 2;
            }
            at += HOP;
        }
        // Never produce a degenerate chunk.
        let end = best.max(start + RATE);
        spans.push((start, end));
        start = end;
    }
    spans
}
