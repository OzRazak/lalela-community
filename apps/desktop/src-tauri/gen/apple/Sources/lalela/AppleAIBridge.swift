// Lalela's in-process Apple-Intelligence bridge (iOS).
//
// iOS App Store apps cannot spawn child processes, so the out-of-process NDJSON
// Swift helpers used on macOS (`lalela-apple-llm`, `lalela-apple-asr`) can't run
// here. Instead this file exposes a tiny hand-rolled C ABI that the Rust side
// (src/apple_bridge.rs) calls in-process, carrying the EXACT SAME JSON request /
// reply objects those helpers speak — one request in, one reply out:
//
//   {"op":"ping"}                          -> {"ok":true,"pong":true}
//   {"op":"status","cap":"llm"}            -> {"ok":true,"available":bool,"reason":?}
//   {"op":"status","cap":"asr"}            -> {"ok":true,"available":bool,"reason":?}
//   {"op":"generate", …}                   -> {"ok":false,"error":"not implemented","code":"other"}
//   {"op":"begin"|"feed"|"finish", …}      -> {"ok":false,"error":"not implemented","code":"other"}
//
// Phase 3 (this file) implements only `ping` and the two `status` capabilities;
// the generate/begin/feed/finish ops are stubs that Phases 4 (synthesis) and 5
// (transcription) fill in with FoundationModels / SpeechTranscriber — the same
// semantics as the macOS helpers, just reached through this bridge.
//
// Everything that touches the iOS-26-only frameworks is behind `#available(iOS
// 26.0, *)`; below that the bridge answers `available:false` with a "Requires
// iOS 26 or later" reason. FoundationModels/Speech are WEAK-linked (see
// project.yml) so the app still loads on iOS 14–25 — their symbols are only ever
// referenced from inside the availability guards below, never at load time.

import Foundation
import FoundationModels
import Speech
// AVFoundation (AVAudioConverter/PCMBuffer/Format) + CoreMedia (CMTime) drive the
// Phase-5 ASR window conversion. Both exist since iOS 4, but project.yml weak-links
// them alongside FoundationModels/Speech; every reference is behind an iOS-26 guard.
import AVFoundation
import CoreMedia

// The C-exported symbols live at file scope. `@_cdecl` gives them the exact C
// names Rust's `extern "C"` block declares; the Swift function names are free.

/// Take a JSON request string, return a malloc'd JSON reply string. The caller
/// (Rust) copies the reply out and frees it via `lalela_apple_ai_free`. Returns
/// NULL only on catastrophic allocation failure.
@_cdecl("lalela_apple_ai_request")
public func appleAiRequest(_ req: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let input = String(cString: req)
    let reply = AppleAIBridge.handle(input)
    // strdup mallocs a NUL-terminated copy; Rust owns it and frees via appleAiFree.
    return strdup(reply)
}

/// Free a reply string previously returned by `lalela_apple_ai_request`.
@_cdecl("lalela_apple_ai_free")
public func appleAiFree(_ p: UnsafeMutablePointer<CChar>?) {
    if let p = p { free(p) }
}

/// One JSON request in, one JSON reply string out. No stored state (each request
/// is self-contained); Phases 4/5 add resident per-session state as needed.
enum AppleAIBridge {
    struct Request: Decodable {
        var op: String
        // "llm" | "asr" — which capability a `status` op is asking about.
        var cap: String?
        // Synthesis prompt fields for the `generate` op (Phase 4).
        var system: String?
        var user: String?
        // Transcription fields for the begin/feed/finish ops (Phase 5): which audio
        // source ("Me"/"Others"), an optional locale hint, a base64 f32le 16 kHz
        // mono PCM window, and its meeting-relative start in ms.
        var stream: String?
        var locale: String?
        var pcm: String?
        var offset_ms: Int?
    }

    /// The union of reply fields across ops. Synthesized Encodable omits nil
    /// optionals, so each reply carries only the fields its op sets — matching
    /// the macOS helpers' reply shape exactly.
    struct Reply: Encodable {
        var ok: Bool
        var pong: Bool?
        var available: Bool?
        var reason: String?
        var content: String?
        var error: String?
        var code: String?
        // Set by the ASR ops (Phase 5): `begin` reports whether it had to install
        // speech assets; `feed`/`finish` carry the transcribed segments.
        var downloaded: Bool?
        var segments: [Seg]?
    }

    /// Decode, dispatch, encode. Never throws to the C boundary — any failure
    /// becomes an `{"ok":false,…}` reply.
    static func handle(_ json: String) -> String {
        guard let data = json.data(using: .utf8),
              let req = try? JSONDecoder().decode(Request.self, from: data) else {
            return encode(Reply(ok: false, error: "bad request", code: "other"))
        }

        let reply: Reply
        switch req.op {
        case "ping":
            reply = Reply(ok: true, pong: true)
        case "status":
            reply = status(cap: req.cap)
        case "generate":
            // Phase 4 — synthesis via Foundation Models. Gated at the call site
            // (mirrors the macOS helper); below iOS 26 the frameworks are absent.
            if #available(iOS 26.0, *) {
                reply = generate(system: req.system ?? "", user: req.user ?? "")
            } else {
                reply = Reply(ok: false, error: "Requires iOS 26 or later", code: "other")
            }
        case "begin", "feed", "finish":
            // Phase 5 — transcription via SpeechAnalyzer/SpeechTranscriber. The
            // resident per-recording session (ASRRunner) is created lazily inside
            // the guard; below iOS 26 the Speech 26 API is absent.
            if #available(iOS 26.0, *) {
                reply = runASR(op: req.op, req: req)
            } else {
                reply = Reply(ok: false, error: "Requires iOS 26 or later")
            }
        default:
            reply = Reply(ok: false, error: "unknown op: \(req.op)", code: "other")
        }
        return encode(reply)
    }

    private static func encode(_ reply: Reply) -> String {
        if let data = try? JSONEncoder().encode(reply),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return #"{"ok":false,"error":"encode failed","code":"other"}"#
    }

    // MARK: - status

    /// Availability of a capability, for the Settings card + picker gating on
    /// iOS. Below iOS 26 the frameworks are absent, so both caps report
    /// unavailable with the same "Requires iOS 26 or later" reason the macOS
    /// helpers use for old-OS builds. An unknown/missing `cap` defaults to llm.
    static func status(cap: String?) -> Reply {
        guard #available(iOS 26.0, *) else {
            return Reply(ok: true, available: false, reason: "Requires iOS 26 or later")
        }
        if cap == "asr" {
            return asrStatus()
        }
        // "llm" or unspecified.
        let (available, reason) = llmAvailability()
        return Reply(ok: true, available: available, reason: reason)
    }

    // MARK: - generate (synthesis)

    /// Synthesise one response through Apple's on-device Foundation Models —
    /// same contract as the macOS `lalela-apple-llm` helper's `generate`, just
    /// reached through the bridge. A **fresh** `LanguageModelSession` per call:
    /// sessions accumulate context across turns, which would blow the small
    /// (~4k-token) window; all map-reduce chunking lives on the Rust side
    /// (`src/apple_llm.rs`), so this does exactly one generation per request.
    ///
    /// Bridges the async `respond(to:)` to this synchronous C-ABI call with a
    /// semaphore + Task (the same pattern the status ops use). Safe because Rust
    /// always invokes the bridge off the main thread (`spawn_blocking`), so the
    /// continuation — which lands on the main queue — still runs while we wait.
    /// `exceededContextWindowSize` maps to `code:"context_exceeded"` (the Rust
    /// map-reduce fallback keys off it); every other failure is `code:"other"`.
    @available(iOS 26.0, *)
    private static func generate(system: String, user: String) -> Reply {
        let session = LanguageModelSession(instructions: system)
        let sem = DispatchSemaphore(value: 0)
        var reply = Reply(ok: false, error: "no result", code: "other")
        Task {
            defer { sem.signal() }
            do {
                let response = try await session.respond(to: user)
                reply = Reply(ok: true, content: response.content)
            } catch let err as LanguageModelSession.GenerationError {
                if case .exceededContextWindowSize = err {
                    reply = Reply(ok: false, error: "context window exceeded", code: "context_exceeded")
                } else {
                    reply = Reply(ok: false, error: String(describing: err), code: "other")
                }
            } catch {
                reply = Reply(ok: false, error: error.localizedDescription, code: "other")
            }
        }
        sem.wait()
        return reply
    }

    /// Probe Apple's on-device Foundation Models — same reason mapping as the
    /// macOS `lalela-apple-llm` helper (worded for iOS Settings).
    @available(iOS 26.0, *)
    private static func llmAvailability() -> (Bool, String?) {
        switch SystemLanguageModel.default.availability {
        case .available:
            return (true, nil)
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible:
                return (false, "This device doesn't support Apple Intelligence")
            case .appleIntelligenceNotEnabled:
                return (false, "Turn on Apple Intelligence: Settings → Apple Intelligence & Siri, then switch on the toggle at the top. A multi-GB on-device model downloads afterward (needs Wi-Fi and free storage). If no toggle appears, set Siri to a supported language (e.g. English) and try again.")
            case .modelNotReady:
                return (false, "Apple Intelligence is on — its on-device model is still downloading. This becomes available once it finishes.")
            @unknown default:
                return (false, "Apple Intelligence isn't available")
            }
        @unknown default:
            return (false, "Apple Intelligence isn't available")
        }
    }

    /// Probe Apple Speech (SpeechTranscriber) availability + a usable locale —
    /// same checks as the macOS `lalela-apple-asr` helper's `status`. Bridges the
    /// async `supportedLocale` lookup to this synchronous call via a semaphore +
    /// Task (the same pattern the macOS helpers use); safe because Rust invokes
    /// this off the main thread, so a main-queue continuation still runs.
    @available(iOS 26.0, *)
    private static func asrStatus() -> Reply {
        guard SpeechTranscriber.isAvailable else {
            return Reply(ok: true, available: false,
                         reason: "Apple's speech recognizer isn't available on this device")
        }
        let sem = DispatchSemaphore(value: 0)
        var hasLocale = false
        Task {
            defer { sem.signal() }
            hasLocale = await resolveLocale(nil) != nil
        }
        sem.wait()
        guard hasLocale else {
            return Reply(ok: true, available: false,
                         reason: "No supported speech language is installed")
        }
        return Reply(ok: true, available: true)
    }

    /// Prefer the requested locale, then the device locale, then en_US — the
    /// first SpeechTranscriber supports wins (mirrors the macOS helper).
    @available(iOS 26.0, *)
    private static func resolveLocale(_ requested: String?) async -> Locale? {
        let candidates = [requested, Locale.current.identifier, "en_US"].compactMap { $0 }
        for id in candidates {
            if let loc = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) {
                return loc
            }
        }
        return nil
    }

    // MARK: - transcription (begin / feed / finish)

    /// Drive one ASR op against the resident per-recording session, bridging its
    /// async work to this synchronous C-ABI call with a semaphore + Task — the
    /// SAME pattern `generate`/`status` use, and the SAME semantics as the macOS
    /// `lalela-apple-asr` helper's `Runner`. Safe because Rust always calls the
    /// bridge OFF the main thread (the recording worker thread), so the Speech
    /// continuations — which land on the main queue — still run while we wait.
    @available(iOS 26.0, *)
    private static func runASR(op: String, req: Request) -> Reply {
        let runner = sharedASRRunner()
        let sem = DispatchSemaphore(value: 0)
        var reply = Reply(ok: false, error: "no result")
        Task {
            defer { sem.signal() }
            switch op {
            case "begin":
                reply = await runner.begin(stream: req.stream ?? "default", locale: req.locale)
            case "feed":
                reply = await runner.feed(stream: req.stream ?? "default", pcm: req.pcm,
                                          offsetMs: req.offset_ms ?? 0)
            default: // "finish" — named stream, or all streams when omitted.
                reply = await runner.finish(stream: req.stream)
            }
        }
        sem.wait()
        return reply
    }
}

// ===========================================================================
// Phase 5 — Apple Speech (SpeechAnalyzer/SpeechTranscriber) ASR session state.
//
// The macOS path runs the identical logic in an out-of-process helper
// (`swift/lalela-apple-asr.swift`); in-process on iOS the SAME classes hold the
// resident per-recording analyzer(s) between begin/feed/finish bridge calls.
// One recording at a time (like the macOS helper's single process): the session
// is created lazily on the first `begin` and its streams are drained on `finish`.
// ===========================================================================

/// The one resident ASR session, type-erased at file scope so its iOS-26-only
/// concrete type is only ever NAMED inside `#available` guards (so the bridge
/// still loads on iOS 14–25). Access is serialized in practice — the Rust
/// recording worker drives begin/feed/finish one at a time, each C call blocking
/// on its own semaphore until the Task completes — so the lock only guards the
/// lazy creation of the singleton, never an `await`.
private nonisolated(unsafe) var asrRunnerBox: AnyObject?
private let asrRunnerLock = NSLock()

@available(iOS 26.0, *)
private func sharedASRRunner() -> ASRRunner {
    asrRunnerLock.lock()
    defer { asrRunnerLock.unlock() }
    if let existing = asrRunnerBox as? ASRRunner { return existing }
    let created = ASRRunner()
    asrRunnerBox = created
    return created
}

/// One finalized transcript segment (bridge reply shape). `speaker` is set only
/// on `finish` replies, where several streams drain together — matching the
/// macOS helper's `Seg` exactly.
struct Seg: Encodable {
    var t0_ms: Int
    var t1_ms: Int
    var text: String
    var speaker: String? = nil
}

/// Thread-safe sink the per-stream results task appends finalized segments to.
@available(iOS 26.0, *)
actor ASRCollector {
    private var segs: [Seg] = []
    func append(_ s: Seg) { segs.append(s) }
    func count() -> Int { segs.count }
    func drain() -> [Seg] {
        let out = segs
        segs.removeAll(keepingCapacity: true)
        return out
    }
}

/// One resident SpeechAnalyzer stream for a single audio source. Ported verbatim
/// from the macOS helper's `TranscriptionStream` — the persistent analyzer, the
/// mandatory AVAudioConverter per window, the bounded `settle()`, and the
/// finish-after-end-of-input drain are the exact same contracts.
@available(iOS 26.0, *)
final class ASRStream {
    private let analyzer: SpeechAnalyzer
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let inputFormat: AVAudioFormat
    private let bestFormat: AVAudioFormat
    private let converter: AVAudioConverter
    private let collector: ASRCollector
    private let resultsTask: Task<Void, Never>

    private init(analyzer: SpeechAnalyzer,
                 continuation: AsyncStream<AnalyzerInput>.Continuation,
                 inputFormat: AVAudioFormat,
                 bestFormat: AVAudioFormat,
                 converter: AVAudioConverter,
                 collector: ASRCollector,
                 resultsTask: Task<Void, Never>) {
        self.analyzer = analyzer
        self.continuation = continuation
        self.inputFormat = inputFormat
        self.bestFormat = bestFormat
        self.converter = converter
        self.collector = collector
        self.resultsTask = resultsTask
    }

    static func make(locale: Locale) async throws -> (ASRStream, Bool) {
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
            throw ASRError.msg("no bestAvailableAudioFormat")
        }
        // Rust always sends 16 kHz mono f32; the analyzer SIGTRAPs (uncatchable,
        // and in-process that kills the APP) on any format other than `best`, so
        // we convert every window and refuse to feed if the converter can't be
        // built. This guard is the single most important line in the file.
        guard let inputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else {
            throw ASRError.msg("could not build input format")
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: best) else {
            throw ASRError.msg("no converter \(inputFormat) -> \(best)")
        }

        let (istream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = ASRCollector()
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
        let stream = ASRStream(
            analyzer: analyzer, continuation: continuation, inputFormat: inputFormat,
            bestFormat: best, converter: converter, collector: collector, resultsTask: resultsTask)
        return (stream, downloaded)
    }

    /// Convert an f32 16 kHz mono window to the analyzer's best format. Any other
    /// buffer format traps the analyzer — this is the one hard contract.
    private func converted(_ buf: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let ratio = bestFormat.sampleRate / inputFormat.sampleRate
        let cap = AVAudioFrameCount((Double(buf.frameLength) * ratio).rounded(.up))
        guard let out = AVAudioPCMBuffer(pcmFormat: bestFormat, frameCapacity: max(cap, 1)) else {
            throw ASRError.msg("could not allocate converted buffer")
        }
        try converter.convert(to: out, from: buf)
        // Belt-and-braces: never hand the analyzer a buffer whose format isn't
        // exactly `best` (the only format it tolerates without trapping).
        guard out.format == bestFormat else {
            throw ASRError.msg("converted buffer format mismatch")
        }
        return out
    }

    /// Feed one window of 16 kHz mono f32 at `startMs` on the MEETING timeline,
    /// then return the segments finalized so far. No per-window `finalize(through:)`
    /// (it blocks); the analyzer emits finals naturally and the tail surfaces on a
    /// later feed or at finish, always at its correct meeting time because
    /// bufferStartTime placed the audio — so Rust needs no timestamp math.
    func feed(_ samples: [Float], startMs: Int) async throws -> [Seg] {
        // Empty windows never reach here (recording.rs skips near-silent ones),
        // but refuse to build/feed a zero-length buffer defensively — in-process
        // any framework misstep kills the app.
        if samples.isEmpty { return await collector.drain() }
        guard let inBuf = AVAudioPCMBuffer(
            pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count)) else {
            throw ASRError.msg("could not allocate input buffer")
        }
        inBuf.frameLength = AVAudioFrameCount(samples.count)
        if let dst = inBuf.floatChannelData?[0] {
            samples.withUnsafeBufferPointer { src in
                dst.update(from: src.baseAddress!, count: samples.count)
            }
        } else {
            throw ASRError.msg("input buffer had no float channel")
        }
        let bufferStart = CMTime(value: Int64(startMs), timescale: 1000)
        continuation.yield(AnalyzerInput(buffer: try converted(inBuf), bufferStartTime: bufferStart))
        try await settle()
        return await collector.drain()
    }

    /// Wait long enough for this window's finished sentences to land (a floor,
    /// since transcription runs far faster than real time), then drain once the
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

enum ASRError: Error { case msg(String) }

/// The resident session: one persistent `ASRStream` per audio source, keyed by
/// stream name ("Me"/"Others"). Mirrors the macOS helper's `Runner` (a class
/// driven serially, one op at a time — here by the recording worker thread, each
/// bridge call blocking on its semaphore until its Task completes). Because this
/// singleton PERSISTS across recordings (unlike the macOS per-recording process),
/// `begin` on an already-existing stream tears the stale one down and starts
/// fresh, so a prior recording's leftover analyzer never bleeds in.
@available(iOS 26.0, *)
final class ASRRunner {
    private var streams: [String: ASRStream] = [:]

    func begin(stream name: String, locale localeId: String?) async -> AppleAIBridge.Reply {
        guard SpeechTranscriber.isAvailable else {
            return AppleAIBridge.Reply(ok: false, error: "Apple's speech recognizer isn't available")
        }
        guard let locale = await resolveLocale(localeId) else {
            return AppleAIBridge.Reply(ok: false, error: "no supported speech locale")
        }
        // Self-heal: drain+drop any stale stream from a prior recording this
        // singleton outlived, so we always start this source's analyzer clean.
        if let stale = streams.removeValue(forKey: name) {
            _ = try? await stale.finish()
        }
        do {
            let (stream, downloaded) = try await ASRStream.make(locale: locale)
            streams[name] = stream
            return AppleAIBridge.Reply(ok: true, downloaded: downloaded)
        } catch {
            return AppleAIBridge.Reply(ok: false, error: "begin failed: \(error)")
        }
    }

    func feed(stream name: String, pcm: String?, offsetMs: Int) async -> AppleAIBridge.Reply {
        guard let stream = streams[name] else {
            return AppleAIBridge.Reply(ok: false, error: "feed before begin for stream \"\(name)\"")
        }
        guard let pcm, let bytes = Data(base64Encoded: pcm) else {
            return AppleAIBridge.Reply(ok: false, error: "missing or invalid pcm")
        }
        let samples = bytes.withUnsafeBytes { raw -> [Float] in
            Array(raw.bindMemory(to: Float32.self))
        }
        do {
            let segs = try await stream.feed(samples, startMs: offsetMs)
            return AppleAIBridge.Reply(ok: true, segments: segs)
        } catch {
            return AppleAIBridge.Reply(ok: false, error: "feed failed: \(error)")
        }
    }

    func finish(stream name: String?) async -> AppleAIBridge.Reply {
        // Named stream, or all streams when omitted (recording teardown / reset).
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
        return AppleAIBridge.Reply(ok: true, segments: out)
    }

    /// Prefer the requested locale, then the device locale, then en_US.
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
