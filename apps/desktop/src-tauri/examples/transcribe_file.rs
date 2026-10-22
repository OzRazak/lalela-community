//! Self-test: transcribe a WAV file using Lalela's real transcription code,
//! so the engine can be verified without a microphone or GUI.
//!
//! Usage: cargo run --example transcribe_file -- <model.bin> <audio.wav>

use lalela_lib::audio::{downmix_to_mono, resample_to_16k};
use lalela_lib::transcribe::Transcriber;

fn main() {
    let mut args = std::env::args().skip(1);
    let model = args.next().expect("usage: transcribe_file <model.bin> <audio.wav>");
    let wav = args.next().expect("usage: transcribe_file <model.bin> <audio.wav>");

    let mut reader = hound::WavReader::open(&wav).expect("open wav");
    let spec = reader.spec();
    eprintln!(
        "wav: {} Hz, {} ch, {} bits, {:?}",
        spec.sample_rate, spec.channels, spec.bits_per_sample, spec.sample_format
    );

    // Read samples as f32 interleaved.
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / max)
                .collect()
        }
    };

    let mono = downmix_to_mono(&interleaved, spec.channels as usize);
    let audio16k = resample_to_16k(&mono, spec.sample_rate);
    eprintln!("samples (16k mono): {}", audio16k.len());

    let transcriber = Transcriber::new(&model).expect("load model");
    let segments = transcriber
        .transcribe(&audio16k, 0, "Test", None)
        .expect("transcribe");

    println!("\n===== TRANSCRIPT =====");
    for seg in &segments {
        println!("[{:>6}ms] {}: {}", seg.t0_ms, seg.speaker, seg.text);
    }
    println!("===== {} segment(s) =====", segments.len());
}
