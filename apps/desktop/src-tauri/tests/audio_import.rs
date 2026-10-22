//! Audio-import decode tests (Intelligence Layer, Slice 7).
//!
//! Fixtures are one 2-second 440 Hz stereo tone at 44.1 kHz in three codecs
//! (WAV / FLAC / AAC-in-M4A) — decoding must downmix + resample every one of
//! them to the same 16 kHz mono shape the live pipeline uses. ASR quality on
//! real speech is the gold set's job, not this file's.

use std::path::PathBuf;

use lalela_lib::audio::resample_to_16k;
use lalela_lib::import::audio::{
    chunk_spans, decode_audio_file, is_audio_extension, StreamingResampler,
};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/audio")
        .join(name)
}

/// The fixture is exactly 2 s → 32 000 samples at 16 kHz. Lossy codecs pad
/// edges (encoder delay), so allow ±10 %.
fn assert_decoded_shape(name: &str) {
    let decoded = decode_audio_file(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    let n = decoded.samples_16k.len() as i64;
    assert!(
        (n - 32_000).abs() < 3_200,
        "{name}: expected ~32000 samples at 16 kHz, got {n}"
    );
    assert!(
        (decoded.duration_ms - 2_000).abs() < 200,
        "{name}: expected ~2000 ms, got {}",
        decoded.duration_ms
    );
    assert_eq!(decoded.source_sample_rate, 44_100, "{name}: source rate");
    // A 440 Hz tone at 40 % amplitude must survive decode with real energy.
    let rms = lalela_lib::audio::rms(&decoded.samples_16k);
    assert!(rms > 0.1, "{name}: decoded audio is near-silent (rms {rms})");
}

#[test]
fn decodes_wav_to_16k_mono() {
    assert_decoded_shape("tone.wav");
}

#[test]
fn decodes_flac_to_16k_mono() {
    assert_decoded_shape("tone.flac");
}

#[test]
fn decodes_m4a_aac_to_16k_mono() {
    assert_decoded_shape("tone.m4a");
}

#[test]
fn unsupported_extension_fails_clearly() {
    let dir = std::env::temp_dir().join("lalela-audio-import-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("clip.wma");
    std::fs::write(&path, b"not really audio").unwrap();
    let err = decode_audio_file(&path).unwrap_err();
    assert!(
        err.contains("unsupported audio type"),
        "error should name the problem, got: {err}"
    );
    assert!(!is_audio_extension("wma"));
}

#[test]
fn corrupt_file_fails_without_panicking() {
    let dir = std::env::temp_dir().join("lalela-audio-import-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("garbage.mp3");
    std::fs::write(&path, vec![0x5a; 4096]).unwrap();
    assert!(decode_audio_file(&path).is_err());
}

/// The chunked resampler must produce what the whole-buffer resampler
/// produces, regardless of how the input is sliced into pushes.
#[test]
fn streaming_resampler_matches_batch_resampler() {
    let in_rate = 44_100u32;
    let input: Vec<f32> = (0..in_rate as usize * 3)
        .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / in_rate as f32).sin())
        .collect();
    let batch = resample_to_16k(&input, in_rate);

    for chunk_size in [512usize, 1_000, 4_096, 44_100] {
        let mut streamed = Vec::new();
        let mut rs = StreamingResampler::new(in_rate);
        for chunk in input.chunks(chunk_size) {
            rs.push(chunk, &mut streamed);
        }
        assert!(
            (streamed.len() as i64 - batch.len() as i64).abs() <= 2,
            "chunk {chunk_size}: length {} vs batch {}",
            streamed.len(),
            batch.len()
        );
        let n = streamed.len().min(batch.len());
        for i in 0..n {
            assert!(
                (streamed[i] - batch[i]).abs() < 1e-3,
                "chunk {chunk_size}: sample {i} diverged ({} vs {})",
                streamed[i],
                batch[i]
            );
        }
    }
}

#[test]
fn chunk_spans_cover_the_buffer_and_cut_at_silence() {
    const RATE: usize = 16_000;
    // 70 s of "speech" (tone) with a silent second at 28 s — the first cut
    // (target 30 s, search window 20–30 s) must land inside the silence.
    let mut samples = vec![0.5f32; 70 * RATE];
    for s in samples.iter_mut().skip(28 * RATE).take(RATE) {
        *s = 0.0;
    }
    let spans = chunk_spans(&samples, 30, 10);
    assert!(spans.len() >= 2);
    // Contiguous + complete coverage.
    assert_eq!(spans[0].0, 0);
    assert_eq!(spans.last().unwrap().1, samples.len());
    for w in spans.windows(2) {
        assert_eq!(w[0].1, w[1].0, "spans must be contiguous");
    }
    // First cut is inside the silent second.
    let cut = spans[0].1;
    assert!(
        (28 * RATE..29 * RATE).contains(&cut),
        "cut at {cut} should be inside the silence at 28–29 s"
    );
}

#[test]
fn short_audio_is_a_single_span() {
    let samples = vec![0.3f32; 5 * 16_000];
    assert_eq!(chunk_spans(&samples, 30, 10), vec![(0, samples.len())]);
}
