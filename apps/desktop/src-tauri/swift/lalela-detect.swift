// Lalela meeting detector (Phase 8). One-shot: prints a single JSON line and exits.
//
//   {"micInUse":true,"apps":["Zoom","Browser"]}
//
// Signals (both permission-free):
//  - micInUse: Core Audio `kAudioDevicePropertyDeviceIsRunningSomewhere` on the
//    default input device — true whenever *any* process is capturing the mic.
//  - apps: known conferencing apps / browsers currently running (to name the
//    source). Pairing mic activity with a known app avoids false positives.

import Foundation
import CoreAudio
import AppKit

func defaultInputDevice() -> AudioDeviceID? {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)
    return status == noErr ? deviceID : nil
}

func micInUse() -> Bool {
    guard let device = defaultInputDevice() else { return false }
    var running = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &running)
    return status == noErr && running != 0
}

// Bundle id -> friendly label. Dedicated conferencing apps are preferred over
// browsers when naming the source on the Rust side.
let knownApps: [String: String] = [
    "us.zoom.xos": "Zoom",
    "com.microsoft.teams2": "Microsoft Teams",
    "com.microsoft.teams": "Microsoft Teams",
    "com.cisco.webexmeetingsapp": "Webex",
    "com.google.Chrome": "Browser",
    "com.google.Chrome.beta": "Browser",
    "com.apple.Safari": "Browser",
    "com.microsoft.edgemac": "Browser",
    "company.thebrowser.Browser": "Browser",
    "com.brave.Browser": "Browser",
    "org.mozilla.firefox": "Browser",
]

func runningMeetingApps() -> [String] {
    var labels = Set<String>()
    for app in NSWorkspace.shared.runningApplications {
        if let bid = app.bundleIdentifier, let label = knownApps[bid] {
            labels.insert(label)
        }
    }
    return Array(labels)
}

func jsonString(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        default: out.unicodeScalars.append(ch)
        }
    }
    out += "\""
    return out
}

let mic = micInUse()
let apps = runningMeetingApps()
let appsJson = apps.map(jsonString).joined(separator: ",")
print("{\"micInUse\":\(mic),\"apps\":[\(appsJson)]}")
