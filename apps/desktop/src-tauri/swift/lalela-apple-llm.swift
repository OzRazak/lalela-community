// Lalela's Apple-Intelligence synthesis helper.
//
// Hosts Apple's on-device Foundation Models LLM (macOS 26+, Apple-Intelligence
// hardware) as an optional synthesis provider. Runs as a resident child process
// of the main app; protocol is newline-delimited JSON on stdin/stdout — one
// request object per line, one reply object per line:
//
//   {"op":"status"}
//     -> {"ok":true,"available":true}
//     -> {"ok":true,"available":false,"reason":"<human string>"}
//   {"op":"generate","system":"…","user":"…"}
//     -> {"ok":true,"content":"…"}
//     -> {"ok":false,"error":"…","code":"context_exceeded"|"other"}
//
// Diagnostics (if any) go to stderr. The Rust side (src/apple_llm.rs) does the
// map-reduce chunking; this helper does one generation per request.
//
// Built by build.rs with `-parse-as-library` (required by @main). Older
// toolchains without FoundationModels simply fail to compile — build.rs then
// leaves LALELA_APPLE_LLM_BIN empty and the feature is absent (graceful).

import FoundationModels
import Foundation

struct Request: Decodable {
    var op: String
    var system: String?
    var user: String?
}

struct Reply: Encodable {
    var ok: Bool
    // Synthesized Encodable omits nil optionals, so each reply only carries the
    // fields its op needs.
    var available: Bool?
    var reason: String?
    var content: String?
    var error: String?
    var code: String?
}

@main
struct AppleLLMHelper {
    static func main() {
        // A stdio request/reply protocol deadlocks if a reply lingers in the
        // stdout buffer while the parent blocks reading a line — make stdout
        // unbuffered. (We also write replies via FileHandle, which bypasses the
        // buffer, but keep this as belt-and-braces.)
        setvbuf(stdout, nil, _IONBF, 0)

        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let req = try? JSONDecoder().decode(Request.self, from: data)
            else {
                emit(Reply(ok: false, error: "bad request", code: "other"))
                continue
            }
            switch req.op {
            case "status":
                let (available, reason) = availability()
                emit(Reply(ok: true, available: available, reason: reason))
            case "generate":
                if #available(macOS 26.0, *) {
                    emit(generate(system: req.system ?? "", user: req.user ?? ""))
                } else {
                    emit(Reply(ok: false, error: "Requires macOS 26 or later", code: "other"))
                }
            default:
                emit(Reply(ok: false, error: "unknown op: \(req.op)", code: "other"))
            }
        }
    }

    /// One JSON reply per line, written unbuffered.
    static func emit(_ reply: Reply) {
        let data = (try? JSONEncoder().encode(reply))
            ?? Data(#"{"ok":false,"error":"encode failed","code":"other"}"#.utf8)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    /// Probe whether Apple's on-device model can serve requests right now, and
    /// if not, the human-readable reason to show in Settings.
    static func availability() -> (Bool, String?) {
        if #available(macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return (true, nil)
            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible:
                    return (false, "This device doesn't support Apple Intelligence")
                case .appleIntelligenceNotEnabled:
                    return (false, "Turn on Apple Intelligence: System Settings → Apple Intelligence & Siri, then switch it on. A multi-GB on-device model downloads afterward.")
                case .modelNotReady:
                    return (false, "Apple Intelligence is on — its on-device model is still downloading. This becomes available once it finishes.")
                @unknown default:
                    return (false, "Apple Intelligence isn't available")
                }
            @unknown default:
                return (false, "Apple Intelligence isn't available")
            }
        }
        return (false, "Requires macOS 26 or later")
    }

    /// Synthesise a single response. A FRESH session per call — sessions
    /// accumulate context across turns, which would blow the small window.
    @available(macOS 26.0, *)
    static func generate(system: String, user: String) -> Reply {
        let session = LanguageModelSession(instructions: system)
        // Bridge the async API to this synchronous stdio loop: one request is
        // fully served before the next line is read.
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
}
