// Lalela meeting-window resolver + capturer (Intelligence Layer, Slice 4).
//
// Modes (one-shot; prints a single JSON line or writes a file, then exits):
//
//   (default)                 meeting-app/browser windows — the auto-detect
//                             capture candidates:
//                             {"windows":[{"id":123,"app":"Zoom","title":"…","width":1512,"height":945,"meeting":true}]}
//   --all                     EVERY pickable window of every app (manual
//                             picker), tagged `meeting` so the UI can surface
//                             conferencing windows first.
//   --capture <id> <dest>     screenshot ONE window to <dest> as JPEG.
//   --watch <id>              hold a live SCStream on ONE window and serve
//                             frames on demand: prints "READY", then answers
//                             each "shoot <dest>" stdin line with "ok" or
//                             "err <why>"; exits on stdin EOF or "quit".
//                             One-shot screenshots cannot photograph a window
//                             living in a fullscreen Space (SCScreenshotManager
//                             error −3811); a persistent stream can — it is
//                             what conferencing apps use for window sharing.
//
// Windows are enumerated through ScreenCaptureKit (SCShareableContent), which
// sees windows on EVERY Space — CGWindowList's onScreenOnly option only sees
// the active Space, which made the picker blind to fullscreen apps and other
// desktops (and to everything outside the active Stage Manager set). Capture
// uses SCScreenshotManager with a desktopIndependentWindow filter for the same
// reason: `screencapture -l` can only shoot windows composited on the active
// Space. Both need the Screen Recording permission the capture feature already
// requires; if SCShareableContent fails (permission missing), enumeration
// falls back to the legacy CGWindowList path so auto-detect still works on the
// active Space, exactly as before.

import Foundation
import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import ScreenCaptureKit

// MARK: - Classification

/// Conferencing/browser label for a bundle id, or nil for any other app.
/// Prefix matching so helper processes count too — Teams meeting windows are
/// owned by `com.microsoft.teams2.helper` (WebView), not the main app process.
func meetingLabel(_ bundleId: String?) -> String? {
    guard let b = bundleId else { return nil }
    if b.hasPrefix("us.zoom.") { return "Zoom" }
    if b.hasPrefix("com.microsoft.teams") { return "Microsoft Teams" }
    if b.hasPrefix("com.cisco.webex") { return "Webex" }
    switch b {
    case "com.google.Chrome", "com.google.Chrome.beta", "com.apple.Safari",
         "com.microsoft.edgemac", "company.thebrowser.Browser",
         "com.brave.Browser", "org.mozilla.firefox":
        return "Browser"
    default:
        return nil
    }
}

/// Never a meaningful capture target: our own app, system chrome, and the
/// invisible XPC service windows (save panels, AutoFill) every app carries.
func isJunkBundle(_ bundleId: String?) -> Bool {
    guard let b = bundleId else { return true }
    if b == "digital.auxo.lalela" { return true }
    let junkPrefixes = [
        "com.apple.appkit.xpc.", "com.apple.SafariPlatformSupport",
        "com.apple.WindowManager", "com.apple.loginwindow",
        "com.apple.Spotlight", "com.apple.dock", "com.apple.controlcenter",
        "com.apple.notificationcenterui", "com.apple.wallpaper",
        "com.apple.systemuiserver", "com.apple.coreautha", "com.apple.ScreenSaver",
    ]
    return junkPrefixes.contains { b.hasPrefix($0) }
}

// MARK: - JSON

func jsonString(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
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

func entry(id: Int, app: String, title: String, width: Int, height: Int, meeting: Bool) -> String {
    "{\"id\":\(id),\"app\":\(jsonString(app)),\"title\":\(jsonString(title)),"
        + "\"width\":\(width),\"height\":\(height),\"meeting\":\(meeting)}"
}

func emit(_ entries: [String]) {
    print("{\"windows\":[\(entries.joined(separator: ","))]}")
}

// MARK: - Legacy enumeration (no Screen Recording permission)

/// CGWindowList fallback — active Space only, window titles absent without
/// the Screen Recording permission. This was the pre-SCK behaviour.
func legacyEntries(listAll: Bool) -> [String] {
    var meetingPids: [pid_t: String] = [:]
    for app in NSWorkspace.shared.runningApplications {
        if let label = meetingLabel(app.bundleIdentifier) {
            meetingPids[app.processIdentifier] = label
        }
    }
    let systemOwners: Set<String> = [
        "Lalela", "Window Server", "Dock", "Control Center", "Notification Center",
        "Spotlight", "WindowManager", "Wallpaper", "SystemUIServer", "coreautha",
    ]
    var entries: [String] = []
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return entries
    }
    for info in list {
        guard
            let pid = info[kCGWindowOwnerPID as String] as? pid_t,
            let windowId = info[kCGWindowNumber as String] as? Int,
            let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
            let bounds = info[kCGWindowBounds as String] as? [String: Any],
            let width = bounds["Width"] as? Double,
            let height = bounds["Height"] as? Double
        else { continue }
        let ownerName = info[kCGWindowOwnerName as String] as? String ?? ""
        let isMeeting = meetingPids[pid] != nil
        if !listAll && !isMeeting { continue }
        if listAll && systemOwners.contains(ownerName) { continue }
        let minW = isMeeting ? 400.0 : 200.0
        let minH = isMeeting ? 300.0 : 200.0
        if width < minW || height < minH { continue }
        let label = meetingPids[pid] ?? (ownerName.isEmpty ? "App" : ownerName)
        let title = info[kCGWindowName as String] as? String ?? ""
        entries.append(entry(
            id: windowId, app: label, title: title,
            width: Int(width), height: Int(height), meeting: isMeeting))
    }
    return entries
}

// MARK: - SCK enumeration (all Spaces)

func sckEntries(_ content: SCShareableContent, listAll: Bool) -> [String] {
    var entries: [String] = []
    for w in content.windows {
        guard w.windowLayer == 0 else { continue }
        let width = Int(w.frame.width)
        let height = Int(w.frame.height)
        let bundleId = w.owningApplication?.bundleIdentifier
        let label = meetingLabel(bundleId)
        let isMeeting = label != nil
        if !listAll && !isMeeting { continue }
        if listAll && isJunkBundle(bundleId) { continue }
        let minW = isMeeting ? 400 : 200
        let minH = isMeeting ? 300 : 200
        if width < minW || height < minH { continue }
        let title = w.title ?? ""
        // Apps keep invisible off-Space service windows around (Electron/WebView
        // buffers, hidden AppKit windows — typically small and titleless). A
        // real window that merely lives on another Space is either titled or
        // meeting-window sized, so require that of anything not on screen.
        if !w.isOnScreen && title.isEmpty && (width < 900 || height < 600) { continue }
        let appName = w.owningApplication?.applicationName ?? ""
        entries.append(entry(
            id: Int(w.windowID), app: label ?? (appName.isEmpty ? "App" : appName),
            title: title, width: width, height: height, meeting: isMeeting))
    }
    return entries
}

// MARK: - Main

_ = CGMainDisplayID() // force the CGS connection SCScreenshotManager needs in a CLI process

let args = CommandLine.arguments
let listAll = args.contains("--all")

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

// MARK: - Watch mode (persistent stream)

/// Keeps the newest complete frame from the stream and encodes it on demand.
final class FrameStore: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    private var stopped = false
    private let ciContext = CIContext()

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
            let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
            let status = atts.first?[.status] as? Int,
            status == SCFrameStatus.complete.rawValue,
            let pb = CMSampleBufferGetImageBuffer(sb)
        else { return }
        lock.lock()
        latest = pb
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    /// Write the newest frame to `path` as JPEG. Returns nil on success or a
    /// short reason ("stopped" = window gone, caller should give up).
    func snapshot(to path: String) -> String? {
        var frame: CVPixelBuffer?
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            lock.lock()
            let s = stopped
            frame = latest
            lock.unlock()
            if s { return "stopped" }
            if frame != nil { break }
            usleep(50_000) // stream just started — first frame is on its way
        }
        guard let frame else { return "no frame" }
        let ci = CIImage(cvPixelBuffer: frame)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return "cgimage failed" }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            return "jpeg encode failed"
        }
        do { try data.write(to: URL(fileURLWithPath: path)) } catch { return "write failed" }
        return nil
    }
}

if let watchIdx = args.firstIndex(of: "--watch") {
    // ---- watch mode: --watch <windowid>; long-running, driven over stdio ----
    guard args.count > watchIdx + 1, let targetId = UInt32(args[watchIdx + 1]) else {
        fail("usage: lalela-window --watch <windowid>")
    }
    let store = FrameStore()
    var stream: SCStream!
    let readyLock = NSLock()
    var ready = false
    // Startup watchdog only — once READY, the process lives until stdin closes.
    DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
        readyLock.lock()
        let ok = ready
        readyLock.unlock()
        if !ok { fail("timeout") }
    }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        guard let content else { fail("shareable content: \(error.map(String.init(describing:)) ?? "unknown")") }
        guard let win = content.windows.first(where: { $0.windowID == targetId }) else {
            fail("window \(targetId) not found")
        }
        let cfg = SCStreamConfiguration()
        cfg.width = Int(win.frame.width) * 2
        cfg.height = Int(win.frame.height) * 2
        cfg.showsCursor = false
        cfg.queueDepth = 3
        // SCK only delivers frames when content changes; this just caps the rate.
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: win), configuration: cfg, delegate: store)
        do { try stream.addStreamOutput(store, type: .screen, sampleHandlerQueue: DispatchQueue(label: "watch-frames")) }
        catch { fail("addStreamOutput: \(error)") }
        stream.startCapture { err in
            if let err { fail("start: \(err)") }
            readyLock.lock()
            ready = true
            readyLock.unlock()
            print("READY")
            fflush(stdout)
            // Command loop off the main queue — readLine blocks. stdin EOF
            // (parent died or dropped us) tears the stream down via exit.
            Thread {
                while let line = readLine(strippingNewline: true) {
                    if line == "quit" { break }
                    guard line.hasPrefix("shoot ") else { continue }
                    let path = String(line.dropFirst("shoot ".count))
                    if let why = store.snapshot(to: path) {
                        print("err \(why)")
                    } else {
                        print("ok")
                    }
                    fflush(stdout)
                }
                exit(0)
            }.start()
        }
    }
    dispatchMain()
}

if let capIdx = args.firstIndex(of: "--capture") {
    // ---- capture mode: --capture <windowid> <dest.jpg> ----
    guard args.count > capIdx + 2, let targetId = UInt32(args[capIdx + 1]) else {
        fail("usage: lalela-window --capture <windowid> <dest>")
    }
    let dest = args[capIdx + 2]
    // A hung WindowServer/SCK call must never wedge the recording loop.
    DispatchQueue.global().asyncAfter(deadline: .now() + 8) { fail("timeout") }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        guard let content else { fail("shareable content: \(error.map(String.init(describing:)) ?? "unknown")") }
        guard let win = content.windows.first(where: { $0.windowID == targetId }) else {
            fail("window \(targetId) not found")
        }
        // desktopIndependentWindow: shoots the window wherever it lives — another
        // Space, behind a fullscreen app — not just the composited desktop.
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let cfg = SCStreamConfiguration()
        cfg.width = Int(win.frame.width) * 2 // retina; downstream resizes as needed
        cfg.height = Int(win.frame.height) * 2
        cfg.showsCursor = false
        cfg.captureResolution = .best
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { image, err in
            guard let image else { fail("capture: \(err.map(String.init(describing:)) ?? "unknown")") }
            let rep = NSBitmapImageRep(cgImage: image)
            guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
                fail("jpeg encode failed")
            }
            do { try data.write(to: URL(fileURLWithPath: dest)) } catch { fail("write: \(error)") }
            exit(0)
        }
    }
    dispatchMain()
}

// ---- enumeration modes ----
// Watchdog doubles as the no-permission path: emit the legacy list so the
// picker/auto-detect degrade to active-Space behaviour instead of hanging.
DispatchQueue.global().asyncAfter(deadline: .now() + 4) {
    emit(legacyEntries(listAll: listAll))
    exit(0)
}
SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, _ in
    if let content {
        emit(sckEntries(content, listAll: listAll))
    } else {
        emit(legacyEntries(listAll: listAll))
    }
    exit(0)
}
dispatchMain()
