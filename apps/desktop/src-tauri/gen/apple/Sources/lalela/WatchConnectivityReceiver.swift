// iOS-side receiver for recordings sent from the Lalela Apple Watch app.
//
// The watch records mono 16 kHz PCM WAV and hands each finished file to the
// paired iPhone via `WCSession.transferFile`. WatchConnectivity queues those
// transfers and delivers them opportunistically in the background — even if this
// app is not running — invoking `session(_:didReceive:)` on the next launch.
//
// This receiver does exactly one thing: move each delivered file, synchronously
// (the temp URL is deleted the moment the delegate returns), into a shared
// `watch-inbox/` directory under the app's Application Support container. The
// Rust side (`watch_inbox.rs`) then discovers the file by SCANNING that
// directory on launch/foreground and imports it through whisper — there is no
// direct Swift→Rust call for ingest, only this shared drop-box.
//
// Activated from `main.mm` before the Tauri run loop starts (deferred onto the
// main queue inside `start()` so activation happens once the run loop is up).

import Foundation
import WatchConnectivity

// Rust → these are the reverse of the AppleAIBridge `@_cdecl` symbols: Rust
// EXPORTS them (`#[no_mangle] pub extern "C"` in `watch_inbox.rs`) and Swift
// calls them. They resolve at app-link time because the Rust staticlib is linked
// into this executable. `@_silgen_name` binds to the exact C symbol name.
//
// `lalela_watch_inbox_file_arrived` kicks an immediate inbox drain the moment a
// file lands (so a recording that arrives while the phone app is open appears
// without a relaunch). `lalela_watch_pending_changed` forwards the watch's
// latest "waiting to sync" count to the phone UI.
@_silgen_name("lalela_watch_inbox_file_arrived")
func lalela_watch_inbox_file_arrived()

@_silgen_name("lalela_watch_pending_changed")
func lalela_watch_pending_changed(_ count: Int32)

/// The C entry point `main.mm` calls to bring the receiver online. Safe to call
/// once at process start; a no-op on devices without a paired-session capability.
@_cdecl("lalela_watch_receiver_start")
public func lalelaWatchReceiverStart() {
    // Defer to the main queue so WCSession activates after UIApplication has a
    // run loop. Activation callbacks themselves arrive on a background queue.
    DispatchQueue.main.async {
        WatchInbox.shared.start()
    }
}

final class WatchInbox: NSObject, WCSessionDelegate {
    static let shared = WatchInbox()

    /// MUST match `INBOX_DIRNAME` in `watch_inbox.rs`. Both sides resolve the
    /// same OS Application Support directory, so the paths agree.
    private static let inboxDirName = "watch-inbox"

    func start() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// `<Application Support>/<bundle id>/watch-inbox`, created if missing.
    ///
    /// This MUST equal Tauri's `app_data_dir()/watch-inbox` on iOS, which is
    /// where `watch_inbox.rs` scans. Verified against a real simulator container:
    /// Tauri resolves `app_data_dir()` to
    /// `<container>/Library/Application Support/<CFBundleIdentifier>` (it appends
    /// the bundle id — `lalela.db` lives there), so we append
    /// `Bundle.main.bundleIdentifier` too. Deriving it from the bundle id keeps
    /// both sides in lockstep if the identifier ever changes.
    private func inboxURL() -> URL? {
        let fm = FileManager.default
        guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
              let bundleId = Bundle.main.bundleIdentifier
        else { return nil }
        let dir = support
            .appendingPathComponent(bundleId, isDirectory: true)
            .appendingPathComponent(Self.inboxDirName, isDirectory: true)
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let inbox = inboxURL() else { return }
        let fm = FileManager.default

        // Prefer the sender's suggested name (carries the timestamp Rust parses
        // into the meeting title); fall back to the temp URL's own name.
        var name = file.fileURL.lastPathComponent
        if let meta = file.metadata, let suggested = meta["name"] as? String, !suggested.isEmpty {
            name = suggested
        }
        // Guarantee a .wav extension and a unique destination.
        if (name as NSString).pathExtension.lowercased() != "wav" {
            name = (name as NSString).deletingPathExtension + ".wav"
        }
        var dest = inbox.appendingPathComponent(name)
        var counter = 1
        while fm.fileExists(atPath: dest.path) {
            let stem = (name as NSString).deletingPathExtension
            dest = inbox.appendingPathComponent("\(stem)-\(counter).wav")
            counter += 1
        }

        // Copy (not move) — WatchConnectivity owns/cleans up the temp file, and a
        // cross-volume move can fail. Must be synchronous: the temp file is gone
        // once this delegate returns.
        do {
            try fm.copyItem(at: file.fileURL, to: dest)
            // The file is on disk in the shared inbox — tell Rust to drain it now
            // rather than waiting for the next launch/foreground scan.
            lalela_watch_inbox_file_arrived()
        } catch {
            NSLog("Lalela: failed to stash watch recording: \(error.localizedDescription)")
        }
    }

    /// Latest watch "waiting to sync" count. WatchConnectivity's application
    /// context is latest-state-wins, so this is exactly the right channel for a
    /// running counter. Forward it to Rust, which emits `watch://pending`.
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        forwardPending(from: applicationContext)
    }

    private func forwardPending(from context: [String: Any]) {
        if let n = context["pendingRecordings"] as? Int {
            lalela_watch_pending_changed(Int32(n))
        } else if let n = context["pendingRecordings"] as? NSNumber {
            lalela_watch_pending_changed(n.int32Value)
        }
    }

    // Required delegate methods. Reactivate after a session hand-off so we keep
    // receiving from the (single) paired watch.
    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        // Surface any count the watch published while this app was not running —
        // `receivedApplicationContext` holds the most recent one.
        if activationState == .activated {
            forwardPending(from: session.receivedApplicationContext)
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }
}
