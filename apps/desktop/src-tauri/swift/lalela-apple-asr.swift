// Lalela's Apple-Speech transcription helper.
//
// Hosts Apple's on-device SpeechAnalyzer / SpeechTranscriber (macOS 26+,
// Apple-Intelligence hardware) as an optional ASR engine. Runs as a resident
// child process of the main app while a recording is live; protocol is
// newline-delimited JSON on stdin/stdout — one request object per line, one
// reply object per line:
//
//   {"op":"status"}
//     -> {"ok":true,"available":true}
//     -> {"ok":true,"available":false,"reason":"<human string>"}
//   {"op":"begin","stream":"Me","locale":"en_US"?}    (installs assets if needed)
//     -> {"ok":true,"downloaded":false}
//   {"op":"feed","stream":"Me","offset_ms":0,"pcm":"<base64 f32le 16k mono>"}
//     -> {"ok":true,"segments":[{"t0_ms":…,"t1_ms":…,"text":"…"}]}
//   {"op":"finish","stream":"Me"?}                    (stream omitted = all)
//     -> {"ok":true,"segments":[{…,"speaker":"Me"}]}  (tail segments carry their
//        stream name — several streams can drain in one reply)
//
// SESSION semantics: one recording = one resident helper. Each audio source
// (mic "Me", system "Others") gets its OWN persistent SpeechAnalyzer stream,
// keyed by `stream`, so the analyzer keeps cross-window context per source and
// the two sources never contaminate each other. `offset_ms` places each window
// on the MEETING timeline via AnalyzerInput.bufferStartTime, so returned segment
// times are already meeting-relative — the Rust side uses them as-is even when
// recording.rs skipped silent windows (a gap in offset_ms is handled fine).
//
// Diagnostics (if any) go to stderr. Built by build.rs with `-parse-as-library`
// (required by @main). Older toolchains without the Speech 26 API fail to
// compile there — build.rs then leaves LALELA_APPLE_ASR_BIN empty and the
// feature is simply absent (graceful).

import Foundation
import Speech
import AVFoundation
import CoreMedia

struct Request: Decodable {
    var op: String
    var stream: String?
    var locale: String?
    var pcm: String?
    var offset_ms: Int?
}

struct Seg: Encodable {
    var t0_ms: Int
    var t1_ms: Int
    var text: String
    // Stream name, set only on `finish` replies: the all-streams finish drains
    // "Me" and "Others" together, so the Rust side can't infer the speaker from
    // the request like it does for `feed` (where this stays nil and is omitted).
    var speaker: String? = nil
}

struct Reply: Encodable {
    var ok: Bool
    // Synthesized Encodable omits nil optionals, so each reply carries only the
    // fields its op needs.
    var available: Bool?
    var reason: String?
    var downloaded: Bool?
    var segments: [Seg]?
    var error: String?
}

enum HelperError: Error { case msg(String) }

@main
struct AppleASRHelper {
    static func main() {
        // A stdio request/reply protocol deadlocks if a reply lingers in the
        // stdout buffer while the parent blocks reading a line — make stdout
        // unbuffered. (Replies also go out via FileHandle, bypassing the buffer,
        // but keep this as belt-and-braces.)
        setvbuf(stdout, nil, _IONBF, 0)

        // The stdin request loop blocks on readLine, but Speech's async APIs
        // deliver their continuations on the MAIN queue — so the read loop runs
        // on a background thread and the main thread services the queue via
        // dispatchMain(). (Blocking the main thread on readLine instead
        // deadlocks: begin/feed/status never resume.)
        Thread.detachNewThread { serveLoop() }
        dispatchMain()
    }

    static func serveLoop() {
        guard #available(macOS 26.0, *) else {
            // Compiled on a 26 SDK but running on an older OS: answer availability
            // honestly, error every real op, never crash.
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                if let data = trimmed.data(using: .utf8),
                   let req = try? JSONDecoder().decode(Request.self, from: data),
                   req.op == "status" {
                    emit(Reply(ok: true, available: false, reason: "Requires macOS 26 or later"))
                } else {
                    emit(Reply(ok: false, error: "Requires macOS 26 or later"))
                }
            }
            exit(0)
        }

        // One request served fully on the cooperative pool per line (a Task
        // awaited on a semaphore), so replies stay ordered — same stdio bridge
        // as lalela-apple-llm.
        let runner = Runner()
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let req = try? JSONDecoder().decode(Request.self, from: data) else {
                emit(Reply(ok: false, error: "bad request"))
                continue
            }
            let sem = DispatchSemaphore(value: 0)
            var reply = Reply(ok: false, error: "no result")
            Task {
                reply = await runner.handle(req)
                sem.signal()
            }
            sem.wait()
            emit(reply)
        }
        exit(0)
    }

    /// One JSON reply per line, written unbuffered.
    static func emit(_ reply: Reply) {
        let data = (try? JSONEncoder().encode(reply))
            ?? Data(#"{"ok":false,"error":"encode failed"}"#.utf8)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

/// Thread-safe sink the per-stream results task appends finalized segments to.
@available(macOS 26.0, *)
actor Collector {
    private var segs: [Seg] = []
    func append(_ s: Seg) { segs.append(s) }
    func count() -> Int { segs.count }
    func drain() -> [Seg] {
        let out = segs
        segs.removeAll(keepingCapacity: true)
        return out
    }
}

/// One resident SpeechAnalyzer stream for a single audio source.
@available(macOS 26.0, *)
final class TranscriptionStream {
    private let analyzer: SpeechAnalyzer
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let inputFormat: AVAudioFormat
    private let bestFormat: AVAudioFormat
    private let converter: AVAudioConverter
    private let collector: Collector
    private let resultsTask: Task<Void, Never>

    private init(analyzer: SpeechAnalyzer,
                 continuation: AsyncStream<AnalyzerInput>.Continuation,
                 inputFormat: AVAudioFormat,
                 bestFormat: AVAudioFormat,
                 converter: AVAudioConverter,
                 collector: Collector,
                 resultsTask: Task<Void, Never>) {
        self.analyzer = analyzer
        self.continuation = continuation
        self.inputFormat = inputFormat
        self.bestFormat = bestFormat
        self.converter = converter
        self.collector = collector
        self.resultsTask = resultsTask
    }

    static func make(locale: Locale) async throws -> (TranscriptionStream, Bool) {
        // Final results only (reportingOptions []), each carrying an audio time
        // range — matches the window-batch AsrEngine Segment{t0_ms,t1_ms,text}.
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange])

        var downloaded = false
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await req.downloadAndInstall()
            downloaded = true
        }

        guard let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw HelperError.msg("no bestAvailableAudioFormat")
        }
        // Rust always sends 16 kHz mono f32; the analyzer traps on any format
        // other than `best` (Int16 16 kHz today), so we convert every window.
        guard let inputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else {
            throw HelperError.msg("could not build input format")
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: best) else {
            throw HelperError.msg("no converter \(inputFormat) -> \(best)")
        }

        let (istream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = Collector()
        let resultsTask = Task {
            // Drains finalized results for this stream's lifetime; ends when the
            // input finishes. Ranges are meeting time (bufferStartTime-seeded).
            do {
                for try await result in transcriber.results {
                    let t0 = Int((result.range.start.seconds * 1000).rounded())
                    let t1 = Int((result.range.end.seconds * 1000).rounded())
                    let text = String(result.text.characters)
                    await collector.append(Seg(t0_ms: t0, t1_ms: t1, text: text))
                }
            } catch {
                // Stream ended or errored — nothing more to collect.
            }
        }

        try await analyzer.start(inputSequence: istream)
        let stream = TranscriptionStream(
            analyzer: analyzer, continuation: continuation, inputFormat: inputFormat,
            bestFormat: best, converter: converter, collector: collector, resultsTask: resultsTask)
        return (stream, downloaded)
    }

    /// Convert an f32 16 kHz mono window to the analyzer's best format. The
    /// analyzer SIGTRAPs (uncatchable) on any other buffer format — this is the
    /// one hard contract from the spike.
    private func converted(_ buf: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let ratio = bestFormat.sampleRate / inputFormat.sampleRate
        let cap = AVAudioFrameCount((Double(buf.frameLength) * ratio).rounded(.up))
        guard let out = AVAudioPCMBuffer(pcmFormat: bestFormat, frameCapacity: max(cap, 1)) else {
            throw HelperError.msg("could not allocate converted buffer")
        }
        try converter.convert(to: out, from: buf)
        return out
    }

    /// Feed one window of 16 kHz mono f32 samples starting at `startMs` on the
    /// MEETING timeline, then return the segments finalized so far (their ranges
    /// are in meeting time, because bufferStartTime seeds the analyzer's clock).
    ///
    /// We do NOT call `finalize(through:)` per window: it blocks until audio
    /// arrives past the boundary, so a per-window call hangs. Instead the
    /// analyzer emits finals naturally as sentences complete; a segment whose
    /// tail lands near a window edge simply surfaces on the next feed (or at
    /// finish) — still at its correct meeting time, since bufferStartTime placed
    /// the audio. This is also why the Rust side needs no timestamp math and why
    /// skipped silent windows (a gap in startMs) don't misplace anything.
    func feed(_ samples: [Float], startMs: Int) async throws -> [Seg] {
        guard let inBuf = AVAudioPCMBuffer(
            pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(max(samples.count, 1))) else {
            throw HelperError.msg("could not allocate input buffer")
        }
        inBuf.frameLength = AVAudioFrameCount(samples.count)
        if samples.count > 0, let dst = inBuf.floatChannelData?[0] {
            samples.withUnsafeBufferPointer { src in
                dst.update(from: src.baseAddress!, count: samples.count)
            }
        }
        let bufferStart = CMTime(value: Int64(startMs), timescale: 1000)
        continuation.yield(AnalyzerInput(buffer: try converted(inBuf), bufferStartTime: bufferStart))
        try await settle()
        return await collector.drain()
    }

    /// The analyzer finalizes results on a background task; wait long enough for
    /// this window's finished sentences to land (a floor, since transcription
    /// runs ~38× real time an 8 s window is done in ~200 ms), then drain once the
    /// burst settles. Bounded so a quiet window returns promptly.
    private func settle() async throws {
        try await Task.sleep(nanoseconds: 300_000_000) // 300 ms floor
        var last = await collector.count()
        var stable = 0
        for _ in 0..<150 {                             // hard cap ~1.5 s more
            try await Task.sleep(nanoseconds: 10_000_000) // 10 ms
            let now = await collector.count()
            if now == last {
                stable += 1
                if stable >= 8 { break }               // ~80 ms with no growth
            } else {
                stable = 0
                last = now
            }
        }
    }

    /// Finalize and end the stream, returning any remaining segments. The input
    /// stream must be finished FIRST — `finalizeAndFinishThroughEndOfInput` waits
    /// for end-of-input, so calling it before `continuation.finish()` hangs.
    func finish() async throws -> [Seg] {
        continuation.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        _ = await resultsTask.value
        return await collector.drain()
    }
}

@available(macOS 26.0, *)
final class Runner {
    private var streams: [String: TranscriptionStream] = [:]

    func handle(_ req: Request) async -> Reply {
        switch req.op {
        case "status":
            return await status()
        case "begin":
            return await begin(stream: req.stream ?? "default", locale: req.locale)
        case "feed":
            return await feed(stream: req.stream ?? "default", pcm: req.pcm, offsetMs: req.offset_ms ?? 0)
        case "finish":
            return await finish(stream: req.stream)
        default:
            return Reply(ok: false, error: "unknown op: \(req.op)")
        }
    }

    private func status() async -> Reply {
        guard SpeechTranscriber.isAvailable else {
            return Reply(ok: true, available: false, reason: "Apple's speech recognizer isn't available on this Mac")
        }
        guard await resolveLocale(nil) != nil else {
            return Reply(ok: true, available: false, reason: "No supported speech language is installed")
        }
        return Reply(ok: true, available: true)
    }

    private func begin(stream name: String, locale localeId: String?) async -> Reply {
        if streams[name] != nil {
            return Reply(ok: true, downloaded: false) // idempotent
        }
        guard SpeechTranscriber.isAvailable else {
            return Reply(ok: false, error: "Apple's speech recognizer isn't available")
        }
        guard let locale = await resolveLocale(localeId) else {
            return Reply(ok: false, error: "no supported speech locale")
        }
        do {
            let (stream, downloaded) = try await TranscriptionStream.make(locale: locale)
            streams[name] = stream
            return Reply(ok: true, downloaded: downloaded)
        } catch {
            return Reply(ok: false, error: "begin failed: \(error)")
        }
    }

    private func feed(stream name: String, pcm: String?, offsetMs: Int) async -> Reply {
        guard let stream = streams[name] else {
            return Reply(ok: false, error: "feed before begin for stream \"\(name)\"")
        }
        guard let pcm, let bytes = Data(base64Encoded: pcm) else {
            return Reply(ok: false, error: "missing or invalid pcm")
        }
        let samples = bytes.withUnsafeBytes { raw -> [Float] in
            Array(raw.bindMemory(to: Float32.self))
        }
        do {
            let segs = try await stream.feed(samples, startMs: offsetMs)
            return Reply(ok: true, segments: segs)
        } catch {
            return Reply(ok: false, error: "feed failed: \(error)")
        }
    }

    private func finish(stream name: String?) async -> Reply {
        // Named stream, or all streams when omitted (recording teardown).
        let names = name.map { [$0] } ?? Array(streams.keys)
        var out: [Seg] = []
        for n in names {
            guard let stream = streams.removeValue(forKey: n) else { continue }
            if let segs = try? await stream.finish() {
                // Tag each tail segment with its stream so the caller can label
                // speakers when several streams drain in one reply.
                out.append(contentsOf: segs.map {
                    Seg(t0_ms: $0.t0_ms, t1_ms: $0.t1_ms, text: $0.text, speaker: n)
                })
            }
        }
        return Reply(ok: true, segments: out)
    }

    /// Prefer the requested locale, then the machine's current locale, then
    /// en_US — the first that SpeechTranscriber supports wins.
    private func resolveLocale(_ requested: String?) async -> Locale? {
        let candidates = [requested, Locale.current.identifier, "en_US"].compactMap { $0 }
        for id in candidates {
            if let loc = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) {
                return loc
            }
        }
        return nil
    }
}
