//! Self-test for diarization: run Lalela's Diarizer on a WAV and print speaker turns.
//! Usage: cargo run --example diarize_file -- <seg.onnx> <emb.onnx> <audio.wav>

use lalela_lib::audio::{downmix_to_mono, resample_to_16k};
use lalela_lib::diarize::Diarizer;

fn main() {
    let mut args = std::env::args().skip(1);
    let seg = args.next().expect("seg model");
    let emb = args.next().expect("emb model");
    let wav = args.next().expect("wav");

    let mut reader = hound::WavReader::open(&wav).expect("open wav");
    let spec = reader.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.unwrap() as f32 / max).collect()
        }
    };
    let mono = downmix_to_mono(&interleaved, spec.channels as usize);
    let audio16k = resample_to_16k(&mono, spec.sample_rate);
    eprintln!("samples (16k mono): {}", audio16k.len());

    let mut d = Diarizer::new(&seg, &emb).expect("diarizer");
    let turns = d.compute(audio16k).expect("compute");

    let mut ids: Vec<i32> = turns.iter().map(|t| t.speaker).collect();
    ids.sort_unstable();
    ids.dedup();

    println!("\n===== DIARIZATION =====");
    for t in &turns {
        println!("[{:6.2}s - {:6.2}s] Speaker {}", t.start, t.end, t.speaker + 1);
    }
    println!("===== {} turns, {} distinct speakers =====", turns.len(), ids.len());
}
