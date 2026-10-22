// The Lalela Apple Watch companion is a single-purpose discreet voice recorder.
// It records mono 16 kHz PCM WAV — the exact shape Lalela's transcription
// pipeline wants — and hands each finished file to the paired iPhone over
// WatchConnectivity `transferFile`, which queues and delivers it in the
// background even if the phone app is closed. Everything else (transcription,
// meetings, sync) happens on iPhone/iPad/desktop; the watch keeps no history
// beyond a pending-sync count.
//
// Background recording (verified against Apple docs): recording is started in
// the FOREGROUND via AVAudioSession(.record) + AVAudioRecorder, and because the
// watch app declares `UIBackgroundModes: [audio]` it keeps recording with the
// wrist down / screen off / app backgrounded, effectively unbounded, until the
// user pauses/stops or an audio interruption (call/Siri) ends it. This does NOT
// use WKExtendedRuntimeSession — those session types (self-care, mindfulness,
// physical-therapy, smart-alarm) cannot host microphone capture. The one hard
// rule: recording cannot be started or resumed from the background.

import AVFoundation
import Combine
import Foundation
import WatchConnectivity
import WatchKit

@MainActor
final class WatchRecorder: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case recording
        case paused
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var elapsed: TimeInterval = 0
    /// Recordings handed to WatchConnectivity that haven't finished syncing to
    /// the phone yet (plus any still waiting for the session to activate).
    @Published private(set) var pendingCount: Int = 0
    /// Non-nil when the mic was denied or a start failed — surfaced in the UI.
    @Published private(set) var errorText: String? = nil

    private var recorder: AVAudioRecorder?
    private var currentFile: URL?
    private var ticker: AnyCancellable?

    /// Files recorded but not yet submitted to WatchConnectivity (only happens
    /// before the session activates). Flushed on activation.
    private var outbox: [URL] = []

    override init() {
        super.init()
        activateSession()
        #if DEBUG
        applyPreviewStateIfRequested()
        #endif
    }

    #if DEBUG
    /// Debug-only: put the UI into a fixed visual state for headless screenshots
    /// (`SIMCTL_CHILD_LALELA_WATCH_PREVIEW=recording|paused|pending`). Compiled
    /// out of Release builds entirely, so it never ships. Touches no hardware.
    private func applyPreviewStateIfRequested() {
        switch ProcessInfo.processInfo.environment["LALELA_WATCH_PREVIEW"] {
        case "recording":
            phase = .recording
            elapsed = 754 // 12:34
        case "paused":
            phase = .paused
            elapsed = 754
        case "pending":
            pendingCount = 3
        default:
            break
        }
    }
    #endif

    // MARK: - Session

    private func activateSession() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        refreshPending()
    }

    private func refreshPending() {
        let outstanding = WCSession.isSupported()
            ? WCSession.default.outstandingFileTransfers.count : 0
        pendingCount = outstanding + outbox.count
        publishPending()
    }

    /// Mirror the pending-sync count to the phone via WatchConnectivity's
    /// application context (latest-state-wins, delivered opportunistically even
    /// when the phone app is closed). The phone forwards it to Rust, which emits
    /// `watch://pending` so the meetings screen can show "N on your Watch".
    private func publishPending() {
        guard WCSession.isSupported(),
              WCSession.default.activationState == .activated else { return }
        try? WCSession.default.updateApplicationContext(["pendingRecordings": pendingCount])
    }

    /// Watch-side "Sync now": re-hand any held recordings to WatchConnectivity
    /// and refresh the pending count. Safe to tap repeatedly; a no-op when the
    /// outbox is empty and all transfers are already queued.
    func syncNow() {
        flushOutbox()
        refreshPending()
    }

    // MARK: - Recording lifecycle

    func toggle() {
        switch phase {
        case .idle: start()
        case .recording: pause()
        case .paused: resume()
        }
    }

    func start() {
        errorText = nil
        // Request mic permission, then begin — recording MUST begin in the
        // foreground (background activation of the audio session fails).
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                guard granted else {
                    self.errorText = "Microphone access is off. Enable it in Settings."
                    return
                }
                self.beginRecording()
            }
        }
    }

    private func beginRecording() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
        } catch {
            errorText = "Couldn't start the microphone."
            return
        }

        let url = outboxDir().appendingPathComponent(Self.newFilename())
        // Linear PCM, 16 kHz mono 16-bit — decodable on iOS with hound (no AAC
        // decoder needed there) and already the pipeline's canonical rate.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        do {
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.delegate = self
            guard rec.record() else {
                errorText = "Couldn't start recording."
                return
            }
            recorder = rec
            currentFile = url
            phase = .recording
            elapsed = 0
            startTicker()
            WKInterfaceDevice.current().play(.start)
        } catch {
            errorText = "Couldn't start recording."
        }
    }

    func pause() {
        guard phase == .recording, let rec = recorder else { return }
        rec.pause()
        phase = .paused
        stopTicker()
        WKInterfaceDevice.current().play(.stop)
    }

    func resume() {
        guard phase == .paused, let rec = recorder else { return }
        // Resuming re-activates the audio session; only possible in foreground.
        try? AVAudioSession.sharedInstance().setActive(true)
        guard rec.record() else {
            errorText = "Couldn't resume recording."
            return
        }
        phase = .recording
        startTicker()
        WKInterfaceDevice.current().play(.start)
    }

    func stop() {
        guard phase != .idle, let rec = recorder else { return }
        rec.stop() // triggers audioRecorderDidFinishRecording
        recorder = nil
        phase = .idle
        stopTicker()
        elapsed = 0
        WKInterfaceDevice.current().play(.stop)
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    // MARK: - Ticker (foreground elapsed display; recording itself runs in bg)

    private func startTicker() {
        ticker = Timer.publish(every: 0.2, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                guard let self, let rec = self.recorder, rec.isRecording else { return }
                self.elapsed = rec.currentTime
            }
    }

    private func stopTicker() {
        ticker?.cancel()
        ticker = nil
    }

    // MARK: - Transfer

    private func submit(_ url: URL) {
        guard WCSession.isSupported() else {
            outbox.append(url)
            refreshPending()
            return
        }
        let session = WCSession.default
        guard session.activationState == .activated else {
            // Hold until the session activates; flushed in activationDidComplete.
            outbox.append(url)
            refreshPending()
            return
        }
        session.transferFile(url, metadata: ["name": url.lastPathComponent])
        refreshPending()
    }

    private func flushOutbox() {
        guard WCSession.isSupported(),
              WCSession.default.activationState == .activated else { return }
        let pending = outbox
        outbox.removeAll()
        for url in pending {
            WCSession.default.transferFile(url, metadata: ["name": url.lastPathComponent])
        }
        refreshPending()
    }

    // MARK: - Files

    private func outboxDir() -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("outbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// `lalela-watch-YYYYMMDD-HHMMSS.wav` — the timestamp is parsed back into the
    /// meeting title on the iPhone side (`watch_inbox.rs`).
    private static func newFilename() -> String {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyyMMdd-HHmmss"
        return "lalela-watch-\(fmt.string(from: Date())).wav"
    }
}

// MARK: - AVAudioRecorderDelegate

extension WatchRecorder: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder,
                                                     successfully flag: Bool) {
        let url = recorder.url
        Task { @MainActor in
            guard flag else {
                self.currentFile = nil
                return
            }
            self.submit(url)
            self.currentFile = nil
        }
    }
}

// MARK: - WCSessionDelegate

extension WatchRecorder: WCSessionDelegate {
    nonisolated func session(_ session: WCSession,
                             activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        Task { @MainActor in
            self.flushOutbox()
            self.refreshPending()
        }
    }

    nonisolated func session(_ session: WCSession,
                             didFinish fileTransfer: WCSessionFileTransfer,
                             error: Error?) {
        let url = fileTransfer.file.fileURL
        Task { @MainActor in
            if error == nil {
                // Delivered — drop our local copy.
                try? FileManager.default.removeItem(at: url)
            }
            self.refreshPending()
        }
    }
}
