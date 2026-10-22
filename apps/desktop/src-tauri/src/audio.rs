//! Microphone capture helpers (Phase 1). System-audio capture is added in Phase 2.

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{Device, SupportedStreamConfig};

/// Pick the default input device and its default config.
pub fn default_input() -> Result<(Device, SupportedStreamConfig), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no input (microphone) device found".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("no default input config: {e}"))?;
    Ok((device, config))
}

/// Downmix an interleaved frame buffer to mono by averaging channels.
pub fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let sum: f32 = interleaved[base..base + channels].iter().sum();
        mono.push(sum / channels as f32);
    }
    mono
}

/// Downmix an interleaved MICROPHONE buffer to mono, averaging only the
/// channels that carry signal.
///
/// Windows laptop mic arrays (Intel SST / Realtek DMIC) commonly expose a
/// 2- or 4-channel shared-mode format where only some channels are live — the
/// rest are digital zeros or an echo-reference slot. A plain average divides
/// the real signal by the channel count (−6 dB for 2 live of 4), which on an
/// already-quiet raw DMIC (no AGC) pushed every window under the silence gate:
/// mic in use, spinner forever, no transcript (Store cert failure 2026-09-24).
///
/// A channel counts as live when its RMS is at least 10 % of the loudest
/// channel's in this buffer (energy ≥ 1 %). Correlated live channels average
/// at unity gain, exactly like `downmix_to_mono` on a healthy stereo mic.
pub fn downmix_mic_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut energy = vec![0.0f64; channels];
    for f in 0..frames {
        let base = f * channels;
        for (c, e) in energy.iter_mut().enumerate() {
            let s = interleaved[base + c] as f64;
            *e += s * s;
        }
    }
    let max_e = energy.iter().cloned().fold(0.0f64, f64::max);
    if max_e <= 0.0 {
        return downmix_to_mono(interleaved, channels);
    }
    let live: Vec<usize> = (0..channels)
        .filter(|c| energy[*c] >= max_e * 0.01)
        .collect();
    let n = live.len() as f32; // ≥ 1: the loudest channel always qualifies
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let sum: f32 = live.iter().map(|c| interleaved[base + c]).sum();
        mono.push(sum / n);
    }
    mono
}

/// 30 ms analysis frames at 16 kHz for the quiet-speech gate.
const GATE_FRAME: usize = 480;
/// A frame must reach at least this RMS (≈ −64 dBFS) to count as voiced. Raw
/// DMIC arrays (≈ −26 dBFS @ 94 dB SPL) put conversational speech at ~0.001–
/// 0.004 RMS when Windows applies no input gain.
const QUIET_SPEECH_MIN_RMS: f32 = 0.0006;
/// …and stand this far above the window's noise floor (≈ +9.5 dB).
const QUIET_SPEECH_CONTRAST: f32 = 3.0;
/// …for at least this many frames (300 ms) — clicks and taps don't qualify.
const QUIET_SPEECH_MIN_FRAMES: usize = 10;

/// Should this 16 kHz window be sent to the speech engine?
///
/// Passes anything at or above `silence_rms` (the historical fixed gate, so
/// loud/AGC'd input — every Mac — behaves exactly as before). Below it, a raw
/// laptop mic can still carry perfectly good speech, so the window also passes
/// when it has ≥ 300 ms of frames that are both above an absolute floor and
/// ~10 dB above the window's own noise floor (10th-percentile frame). Steady
/// room/fan noise has no such contrast and digital silence has no level, so
/// both stay gated (Whisper hallucinates filler on them).
pub fn has_speech(samples_16k: &[f32], silence_rms: f32) -> bool {
    if rms(samples_16k) >= silence_rms {
        return true;
    }
    let mut frames: Vec<f32> = samples_16k.chunks_exact(GATE_FRAME).map(rms).collect();
    if frames.len() < QUIET_SPEECH_MIN_FRAMES {
        return false;
    }
    let voiced_at = |floor: f32| QUIET_SPEECH_MIN_RMS.max(floor * QUIET_SPEECH_CONTRAST);
    let mut sorted = frames.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10];
    let threshold = voiced_at(floor);
    frames.retain(|f| *f >= threshold);
    frames.len() >= QUIET_SPEECH_MIN_FRAMES
}

/// Boost a quiet window toward a healthy level before transcription (peak →
/// 0.5, at most +30 dB). Loud windows (peak ≥ 0.25) are left untouched, so
/// input that already transcribes well is byte-identical to before.
pub fn normalize_quiet(samples: &mut [f32]) {
    const TARGET_PEAK: f32 = 0.5;
    const MAX_GAIN: f32 = 30.0;
    let p = peak(samples);
    if p <= 0.0 || p >= 0.25 {
        return;
    }
    let gain = (TARGET_PEAK / p).min(MAX_GAIN);
    for s in samples.iter_mut() {
        *s = (*s * gain).clamp(-1.0, 1.0);
    }
}

/// Root-mean-square energy of a buffer (0.0 = silence). Used to skip silent
/// windows so Whisper doesn't hallucinate filler ("you", "[Silence]", etc.).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sum_sq / samples.len() as f64).sqrt() as f32
}

/// Resample mono f32 audio from `in_rate` to 16 kHz using linear interpolation.
/// Good enough for speech; a higher-quality resampler can replace this later.
pub fn resample_to_16k(input: &[f32], in_rate: u32) -> Vec<f32> {
    let out_rate = crate::transcribe::WHISPER_RATE;
    if in_rate == out_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = out_rate as f64 / in_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

// --- Multi-channel → mono folding (used by the Windows WASAPI loopback tap) ---
//
// A plain average over N channels is wrong for surround endpoints. The CORSAIR
// HS70 headset on the test PC reports a 7.1 shared mix (8 ch, mask 0x63F) even
// though every app plays stereo into it: the six surround channels are digital
// silence, so `sum / 8` attenuates real audio by 12 dB. That pushed whole
// windows below `recording::SILENCE_RMS` (0.006) and the system source was
// skipped as "silence" — audible audio, empty transcript.
//
// Instead, weight each channel by what it is, using the endpoint's
// `dwChannelMask`. WASAPI orders channels by ascending mask bit, so the k-th
// set bit is interleaved channel k.

/// `KSAUDIO_SPEAKER_*` mask bits, in WASAPI channel order.
const SPEAKER_BITS: [(u32, f32); 11] = [
    (0x1, 0.5),    // FRONT_LEFT
    (0x2, 0.5),    // FRONT_RIGHT
    (0x4, 0.5),    // FRONT_CENTER — dialogue lives here in a 5.1/7.1 mix
    (0x8, 0.0),    // LOW_FREQUENCY — LFE carries no speech; never fold it in
    (0x10, 0.25),  // BACK_LEFT
    (0x20, 0.25),  // BACK_RIGHT
    (0x40, 0.25),  // FRONT_LEFT_OF_CENTER
    (0x80, 0.25),  // FRONT_RIGHT_OF_CENTER
    (0x100, 0.25), // BACK_CENTER
    (0x200, 0.25), // SIDE_LEFT
    (0x400, 0.25), // SIDE_RIGHT
];

/// Per-channel mono-fold weights for an `channels`-wide interleaved stream with
/// the given WASAPI `channel_mask` (0 = unknown).
///
/// Calibrated so stereo content in a wider mix comes out at unity: FL and FR at
/// 0.5 each sum to 1.0. When the mask is missing or doesn't describe exactly
/// `channels` speakers, fall back to the first two channels (FL/FR by
/// convention) rather than averaging — averaging is the bug this exists to fix.
pub fn downmix_weights(channels: usize, channel_mask: u32) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    if channels == 1 {
        return vec![1.0];
    }
    if channel_mask != 0 && channel_mask.count_ones() as usize == channels {
        let mut weights = Vec::with_capacity(channels);
        for (bit, w) in SPEAKER_BITS {
            if channel_mask & bit != 0 {
                weights.push(w);
            }
        }
        // Bits above the table (TOP_*, etc.) are unknown positions: mute them.
        while weights.len() < channels {
            weights.push(0.0);
        }
        // A mask of only muted speakers (LFE-only, all-unknown) would yield
        // permanent silence — prefer the fallback to that.
        if weights.iter().any(|w| *w > 0.0) {
            return weights;
        }
    }
    let mut weights = vec![0.0; channels];
    weights[0] = 0.5;
    weights[1] = 0.5;
    weights
}

/// Fold an interleaved buffer to mono with per-channel `weights`, clamping to
/// [-1, 1] so a dense surround mix can't overshoot into Whisper.
pub fn downmix_to_mono_weighted(interleaved: &[f32], weights: &[f32]) -> Vec<f32> {
    let channels = weights.len();
    if channels == 0 {
        return Vec::new();
    }
    if channels == 1 {
        return interleaved.iter().map(|s| s * weights[0]).collect();
    }
    let frames = interleaved.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let mut sum = 0.0f32;
        for (c, w) in weights.iter().enumerate() {
            sum += interleaved[base + c] * w;
        }
        mono.push(sum.clamp(-1.0, 1.0));
    }
    mono
}

/// Peak absolute sample in a buffer (0.0 = digital silence).
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 7.1 mask reported by the CORSAIR HS70 endpoint on the Windows test PC.
    const MASK_7POINT1: u32 = 0x63F;

    #[test]
    fn seven_one_mask_maps_to_eight_weights_with_muted_lfe() {
        let w = downmix_weights(8, MASK_7POINT1);
        // FL, FR, FC, LFE, BL, BR, SL, SR
        assert_eq!(w, vec![0.5, 0.5, 0.5, 0.0, 0.25, 0.25, 0.25, 0.25]);
    }

    /// The regression this whole change exists for: stereo content sitting in a
    /// 7.1 mix must come out at full level, not 1/4 of it.
    #[test]
    fn stereo_content_in_a_seven_one_mix_keeps_unity_gain() {
        let w = downmix_weights(8, MASK_7POINT1);
        let mut frame = vec![0.0f32; 8];
        frame[0] = 0.8;
        frame[1] = 0.8;
        let mono = downmix_to_mono_weighted(&frame, &w);
        assert_eq!(mono.len(), 1);
        assert!((mono[0] - 0.8).abs() < 1e-6, "got {}", mono[0]);
        // The old plain average is what dropped below the silence gate.
        let averaged = downmix_to_mono(&frame, 8);
        assert!(averaged[0] < 0.25);
    }

    #[test]
    fn lfe_is_never_folded_in() {
        let w = downmix_weights(8, MASK_7POINT1);
        let mut frame = vec![0.0f32; 8];
        frame[3] = 1.0; // LFE only
        assert_eq!(downmix_to_mono_weighted(&frame, &w), vec![0.0]);
    }

    #[test]
    fn plain_stereo_mask_averages_the_pair() {
        let w = downmix_weights(2, 0x3);
        assert_eq!(w, vec![0.5, 0.5]);
        assert_eq!(
            downmix_to_mono_weighted(&[1.0, 1.0, 1.0, -1.0], &w),
            vec![1.0, 0.0]
        );
    }

    #[test]
    fn unknown_mask_falls_back_to_the_front_pair() {
        let w = downmix_weights(6, 0);
        assert_eq!(w, vec![0.5, 0.5, 0.0, 0.0, 0.0, 0.0]);
        // Mask that doesn't match the channel count is equally untrustworthy.
        assert_eq!(downmix_weights(4, MASK_7POINT1), vec![0.5, 0.5, 0.0, 0.0]);
    }

    #[test]
    fn mono_endpoint_passes_through() {
        assert_eq!(downmix_weights(1, 0x4), vec![1.0]);
        assert_eq!(
            downmix_to_mono_weighted(&[0.3, -0.4], &[1.0]),
            vec![0.3, -0.4]
        );
    }

    #[test]
    fn dense_surround_content_is_clamped_not_wrapped() {
        let w = downmix_weights(8, MASK_7POINT1);
        let frame = vec![1.0f32; 8];
        assert_eq!(downmix_to_mono_weighted(&frame, &w), vec![1.0]);
    }

    #[test]
    fn peak_reports_the_largest_magnitude() {
        assert_eq!(peak(&[]), 0.0);
        assert_eq!(peak(&[0.1, -0.7, 0.4]), 0.7);
    }

    // --- Store cert failure 2026-09-24: quiet multi-channel laptop mic ---

    /// Deterministic pseudo-noise in [-amp, amp] (no rand dependency).
    fn noise(n: usize, amp: f32, seed: u32) -> Vec<f32> {
        let mut x = seed.max(1);
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                ((x as f32 / u32::MAX as f32) * 2.0 - 1.0) * amp
            })
            .collect()
    }

    /// 8 s at 16 kHz of "speech": 200 ms voiced bursts (tone at `amp`) with
    /// 100 ms gaps, over a faint noise floor — the cadence of real talk.
    fn quiet_speech(amp: f32) -> Vec<f32> {
        let n = 16_000 * 8;
        let floor = noise(n, 0.0004, 7);
        (0..n)
            .map(|i| {
                let voiced = (i % 4_800) < 3_200;
                let tone = if voiced {
                    (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / 16_000.0).sin() * amp
                } else {
                    0.0
                };
                tone + floor[i]
            })
            .collect()
    }

    const GATE: f32 = 0.006; // recording.rs SILENCE_RMS

    #[test]
    fn quiet_laptop_speech_passes_the_gate_even_below_the_fixed_rms() {
        let s = quiet_speech(0.006); // window RMS ≈ 0.0035, well under 0.006
        assert!(rms(&s) < GATE, "fixture must be below the old gate");
        assert!(has_speech(&s, GATE));
    }

    #[test]
    fn steady_noise_and_digital_silence_stay_gated() {
        let n = 16_000 * 8;
        assert!(!has_speech(&vec![0.0; n], GATE));
        assert!(!has_speech(&noise(n, 0.005, 3), GATE)); // fan hiss, RMS ≈ 0.003
        assert!(!has_speech(&noise(n, 0.0005, 9), GATE));
    }

    #[test]
    fn a_single_click_is_not_speech() {
        let mut s = noise(16_000 * 8, 0.0004, 5);
        for v in s.iter_mut().skip(40_000).take(160) {
            *v = 0.05; // 10 ms tap (window RMS stays under the fixed gate)
        }
        assert!(!has_speech(&s, GATE));
    }

    #[test]
    fn loud_input_passes_exactly_as_before() {
        assert!(has_speech(&vec![0.01; 1_000], GATE)); // too short for frames, still passes
        assert!(!has_speech(&vec![0.001; 1_000], GATE));
    }

    #[test]
    fn mic_downmix_ignores_dead_channels() {
        // 4-ch array, speech on ch0+ch1 only (ch2/3 digital zero).
        let speech = quiet_speech(0.012);
        let mut inter = Vec::with_capacity(speech.len() * 4);
        for s in &speech {
            inter.extend_from_slice(&[*s, *s, 0.0, 0.0]);
        }
        let old = downmix_to_mono(&inter, 4);
        let new = downmix_mic_to_mono(&inter, 4);
        // The bug: plain averaging halves the level and drops under the gate.
        assert!(rms(&old) < GATE);
        assert!((rms(&new) - rms(&speech)).abs() < 1e-5);
        assert!(rms(&new) >= GATE);
    }

    #[test]
    fn mic_downmix_matches_plain_average_when_all_channels_live() {
        let inter = [0.2f32, 0.4, -0.1, -0.3, 0.0, 0.2];
        assert_eq!(downmix_mic_to_mono(&inter, 2), downmix_to_mono(&inter, 2));
        assert_eq!(downmix_mic_to_mono(&[0.0; 8], 4), vec![0.0; 2]);
        assert_eq!(downmix_mic_to_mono(&[0.3, -0.2], 1), vec![0.3, -0.2]);
    }

    #[test]
    fn normalize_boosts_quiet_windows_and_leaves_loud_ones_alone() {
        let mut q = vec![0.01f32, -0.02, 0.005];
        normalize_quiet(&mut q);
        assert!((peak(&q) - 0.5).abs() < 1e-6); // 0.02 * 25
        let mut tiny = vec![0.001f32, -0.002];
        normalize_quiet(&mut tiny);
        assert!((peak(&tiny) - 0.06).abs() < 1e-6, "gain capped at 30x");
        let mut m = vec![0.1f32, -0.1];
        normalize_quiet(&mut m);
        assert!((peak(&m) - 0.5).abs() < 1e-6);
        let mut loud = vec![0.3f32, -0.6];
        normalize_quiet(&mut loud);
        assert_eq!(loud, vec![0.3, -0.6]);
        let mut zero = vec![0.0f32; 4];
        normalize_quiet(&mut zero);
        assert_eq!(zero, vec![0.0; 4]);
    }
}
