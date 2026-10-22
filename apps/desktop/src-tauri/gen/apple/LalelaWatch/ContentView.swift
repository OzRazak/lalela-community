import SwiftUI

/// Lalela's brand yellow (#FFD200) — the one accent the discreet recorder uses.
private let lalelaYellow = Color(red: 1.0, green: 0.82, blue: 0.0)

struct ContentView: View {
    @EnvironmentObject private var recorder: WatchRecorder

    var body: some View {
        VStack(spacing: 8) {
            switch recorder.phase {
            case .idle:
                idle
            case .recording, .paused:
                active
            }

            if let err = recorder.errorText {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }

            if recorder.pendingCount > 0 {
                // While idle the count doubles as a "Sync now" nudge — tap to
                // re-hand held recordings to the phone. During a recording it is
                // just a status badge (no tap target to avoid mis-taps).
                if recorder.phase == .idle {
                    Button(action: recorder.syncNow) {
                        PendingBadge(count: recorder.pendingCount, actionable: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Sync \(recorder.pendingCount) recordings to iPhone now")
                } else {
                    PendingBadge(count: recorder.pendingCount)
                }
            }
        }
        .padding(.horizontal, 6)
    }

    // MARK: - Idle

    private var idle: some View {
        VStack(spacing: 10) {
            Text("Lalela")
                .font(.headline)
            Button(action: recorder.start) {
                ZStack {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 96, height: 96)
                    Image(systemName: "mic.fill")
                        .font(.system(size: 34, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Start recording")
            Text("Tap to record")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Recording / paused

    private var active: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                Circle()
                    .fill(recorder.phase == .recording ? Color.red : Color.orange)
                    .frame(width: 10, height: 10)
                    .opacity(recorder.phase == .recording ? 1 : 0.6)
                Text(recorder.phase == .recording ? "Recording" : "Paused")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(timeString(recorder.elapsed))
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(lalelaYellow)

            HStack(spacing: 14) {
                // Pause / resume
                Button(action: recorder.toggle) {
                    Image(systemName: recorder.phase == .recording ? "pause.fill" : "play.fill")
                        .font(.system(size: 22, weight: .bold))
                        .frame(width: 54, height: 54)
                }
                .buttonStyle(.borderedProminent)
                .tint(lalelaYellow)
                .accessibilityLabel(recorder.phase == .recording ? "Pause" : "Resume")

                // Stop
                Button(action: recorder.stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 22, weight: .bold))
                        .frame(width: 54, height: 54)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .accessibilityLabel("Stop and sync")
            }
        }
    }

    private func timeString(_ t: TimeInterval) -> String {
        let total = Int(t)
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%02d:%02d", m, s)
    }
}

private struct PendingBadge: View {
    let count: Int
    /// When true (idle "Sync now" tap target) the label invites a tap and takes
    /// the brand accent; otherwise it is a quiet status badge.
    var actionable: Bool = false
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 10, weight: .semibold))
            Text(actionable ? "Sync \(count) now" : "\(count) to sync")
                .font(.caption2)
        }
        .foregroundStyle(actionable ? lalelaYellow : .secondary)
        .padding(.top, 2)
    }
}
