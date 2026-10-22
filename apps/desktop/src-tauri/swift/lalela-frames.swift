// Lalela video-frame helper (video import, visual understanding).
//
// One-shot CLI, two modes:
//
//   lalela-frames extract <video> <outdir> <interval_secs>
//       Renders one JPEG per <interval_secs> of the video into <outdir> as
//       frame-<t_ms>.jpg (bounded), prints "OK <count>". The Rust side
//       dedupes them to distinct slides with the same dhash logic the live
//       screenshare sampler uses.
//
//   lalela-frames ocr <image> [<image>…]
//       Runs Apple Vision text recognition (on-device, no network) over each
//       image and prints one JSON line per image:
//         {"path":"…","text":"line1\nline2"}
//
// AVFoundation reads mp4/mov natively; mkv/webm are not supported by the OS
// decoder — extract just finds no track and exits 1, and the import carries
// on audio-only. Diagnostics go to stderr.

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("lalela-frames: \(msg)\n".utf8))
    exit(1)
}

func jsonString(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    out += "\""
    return out
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: lalela-frames extract|ocr …") }

switch args[1] {
case "extract":
    guard args.count >= 5, let interval = Double(args[4]), interval > 0 else {
        fail("usage: lalela-frames extract <video> <outdir> <interval_secs>")
    }
    let videoURL = URL(fileURLWithPath: args[2])
    let outDir = URL(fileURLWithPath: args[3])
    try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

    let asset = AVURLAsset(url: videoURL)
    // Synchronous properties are fine for a one-shot CLI; a video with no
    // visual track (or an unreadable container like mkv/webm) exits 1 and the
    // caller falls back to audio-only.
    guard !asset.tracks(withMediaType: .video).isEmpty else {
        fail("no video track (or unsupported container)")
    }
    let duration = asset.duration.seconds
    guard duration.isFinite, duration > 0 else { fail("could not read duration") }

    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: 1920, height: 1920)
    // Loose tolerance lets the generator snap to nearby keyframes — much
    // faster, and slide decks change far slower than the tolerance.
    gen.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
    gen.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)

    // Bounded: at most ~720 samples (1 h at 5 s) no matter the duration.
    let maxFrames = 720
    var times: [Double] = []
    var t = 0.0
    while t < duration && times.count < maxFrames {
        times.append(t)
        t += interval
    }

    var written = 0
    for secs in times {
        let time = CMTime(seconds: secs, preferredTimescale: 600)
        guard let cg = try? gen.copyCGImage(at: time, actualTime: nil) else { continue }
        let tMs = Int(secs * 1000)
        let dest = outDir.appendingPathComponent("frame-\(tMs).jpg")
        guard
            let sink = CGImageDestinationCreateWithURL(
                dest as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { continue }
        CGImageDestinationAddImage(sink, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        if CGImageDestinationFinalize(sink) { written += 1 }
    }
    print("OK \(written)")

case "ocr":
    guard args.count >= 3 else { fail("usage: lalela-frames ocr <image> [<image>…]") }
    for path in args.dropFirst(2) {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path))
        var text = ""
        if (try? handler.perform([request])) != nil {
            let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            text = lines.joined(separator: "\n")
        }
        print("{\"path\":\(jsonString(path)),\"text\":\(jsonString(text))}")
    }

default:
    fail("unknown mode \(args[1])")
}
