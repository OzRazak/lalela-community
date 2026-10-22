// Lalela system-audio helper.
//
// Captures the Mac's system audio output using the Core Audio process-tap API
// (macOS 14.2+) and streams it to stdout for the Rust backend to transcribe.
//
// Protocol on stdout:
//   1. One header line:  "LALELA_AUDIO <sampleRate> <channels>\n"
//   2. Then raw little-endian Float32 interleaved PCM frames, forever.
// Diagnostics go to stderr. Send SIGINT/SIGTERM to stop and clean up.
//
// Requires the NSAudioCaptureUsageDescription Info.plist key and the user
// granting audio-recording permission to the host app.

import AudioToolbox
import CoreAudio
import Darwin
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("lalela-systemaudio: \(message)\n".utf8))
    exit(1)
}

// If the host app dies, writes to the pipe raise SIGPIPE, whose default action
// kills this process WITHOUT running `atexit` — leaving an orphaned tap inside
// coreaudiod (which is exactly what wedges it). Ignore the signal and treat a
// failed write as "parent is gone": exit(0) runs the cleanup handler.
signal(SIGPIPE, SIG_IGN)

/// Write all of `data` to stdout, returning false when the pipe is closed.
func writeAll(_ data: Data) -> Bool {
    var ok = true
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        var off = 0
        while off < raw.count {
            let n = write(1, raw.baseAddress!.advanced(by: off), raw.count - off)
            if n <= 0 {
                ok = false
                return
            }
            off += n
        }
    }
    return ok
}

// ---- Create a global tap of all system output ----
let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.muteBehavior = .unmuted
tapDescription.isPrivate = true
tapDescription.isMixdown = true

var tapID = AudioObjectID(kAudioObjectUnknown)
if AudioHardwareCreateProcessTap(tapDescription, &tapID) != noErr || tapID == kAudioObjectUnknown {
    fail("AudioHardwareCreateProcessTap failed (is audio-capture permission granted?)")
}

// ---- Read the tap's stream format ----
var asbd = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var formatAddr = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
if AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &asbdSize, &asbd) != noErr {
    fail("could not read tap format")
}
let sampleRate = Int(asbd.mSampleRate)
let channels = Int(asbd.mChannelsPerFrame)

// ---- Create a private aggregate device backed by the tap ----
let aggUID = UUID().uuidString
let aggDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "Lalela System Capture",
    kAudioAggregateDeviceUIDKey as String: aggUID,
    kAudioAggregateDeviceIsPrivateKey as String: true,
    kAudioAggregateDeviceIsStackedKey as String: false,
    kAudioAggregateDeviceTapAutoStartKey as String: true,
    kAudioAggregateDeviceTapListKey as String: [
        [
            kAudioSubTapUIDKey as String: tapDescription.uuid.uuidString,
            kAudioSubTapDriftCompensationKey as String: true,
        ]
    ],
]

var aggID = AudioObjectID(kAudioObjectUnknown)
if AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &aggID) != noErr {
    fail("AudioHardwareCreateAggregateDevice failed")
}

// ---- Emit the header so Rust knows how to interpret the stream ----
if !writeAll(Data("LALELA_AUDIO \(sampleRate) \(channels)\n".utf8)) {
    exit(0) // parent already gone — atexit cleanup tears the tap down
}
FileHandle.standardError.write(Data("lalela-systemaudio: capturing \(sampleRate) Hz, \(channels) ch\n".utf8))

// ---- Buffer audio in the IO callback; flush on a writer thread (RT-safe) ----
let pending = NSMutableData()
let lock = NSLock()

let writer = Thread {
    while true {
        lock.lock()
        let chunk: Data?
        if pending.length > 0 {
            chunk = Data(bytes: pending.bytes, count: pending.length)
            pending.length = 0
        } else {
            chunk = nil
        }
        lock.unlock()
        if let chunk {
            if !writeAll(chunk) { exit(0) } // pipe closed: parent died — clean up
        } else {
            usleep(10_000)
        }
    }
}
writer.start()

// Belt and braces for a parent that dies without closing the pipe promptly:
// once this process is reparented to launchd, tear the tap down and leave.
let parentWatch = Thread {
    while true {
        if getppid() == 1 { exit(0) }
        sleep(1)
    }
}
parentWatch.start()

var procID: AudioDeviceIOProcID?
let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) {
    (_, inInputData, _, _, _) in
    let bufferList = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: inInputData))
    // The aggregate's first buffer is the mixed tap output.
    if let buffer = bufferList.first, let mData = buffer.mData {
        lock.lock()
        pending.append(mData, length: Int(buffer.mDataByteSize))
        lock.unlock()
    }
}
if ioStatus != noErr {
    fail("AudioDeviceCreateIOProcIDWithBlock failed")
}

if AudioDeviceStart(aggID, procID) != noErr {
    fail("AudioDeviceStart failed")
}

// ---- Clean shutdown on signal ----
func cleanup() {
    if let procID {
        AudioDeviceStop(aggID, procID)
        AudioDeviceDestroyIOProcID(aggID, procID)
    }
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
}

for sig in [SIGINT, SIGTERM] {
    signal(sig) { _ in
        // Minimal async-signal handling: stop device and exit.
        exit(0)
    }
}
atexit { cleanup() }

RunLoop.main.run()
