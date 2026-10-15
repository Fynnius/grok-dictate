/// CoreAudio introspection for the input device actually in use.
///
/// `CaptureEngine` never calls `AUAudioUnit.setDeviceID` — the engine's input
/// node always tracks the system *default* input device — so "the default
/// input device right now" and "the device `engine.start()` just opened" are
/// the same object. Queried after `engine.start()` returns successfully, not
/// at `prepareIdle()` time, so a route change between prepare and start
/// (AirPods waking up, a USB mic plugged in) is reflected rather than stale.
///
/// Diagnostic only, for the `timing` summary line
/// (`docs/report-latency-ux-2026-08-22.md` §W3 — Bluetooth HFP is the
/// suspected cause of the slow `device_open` → `first_pcm_main` holds, but
/// the log never recorded which device was open to confirm it). Every
/// property read is independently best-effort: a device that cannot be
/// described at all yields `nil` from `current()`, never a thrown error —
/// this must not be able to turn a successful `start()` into a failed one.
import AudioToolbox
import CaptureCore
import CoreAudio
import Foundation

enum InputDeviceInfo {
    static func current() -> CaptureDeviceInfo? {
        guard let device = defaultInputDevice() else { return nil }
        return CaptureDeviceInfo(
            name: stringProperty(device, selector: kAudioObjectPropertyName),
            uid: stringProperty(device, selector: kAudioDevicePropertyDeviceUID),
            transport: transportBucket(device),
            sampleRateHz: nominalSampleRate(device)
        )
    }

    private static func defaultInputDevice() -> AudioDeviceID? {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        return status == noErr && device != kAudioObjectUnknown ? device : nil
    }

    private static func stringProperty(_ device: AudioDeviceID, selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
        guard status == noErr, let value else { return nil }
        // GetPropertyData copies the CFString into our slot without
        // transferring +1; unretained is the matching take (same pattern as
        // `grok-dictate-helper/OutputMute.swift`'s `coreAudioUID`).
        return value.takeUnretainedValue() as String
    }

    private static func nominalSampleRate(_ device: AudioDeviceID) -> Double? {
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate)
        return status == noErr && rate > 0 ? rate : nil
    }

    private static func transportBucket(_ device: AudioDeviceID) -> String? {
        var transport: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport)
        guard status == noErr else { return nil }
        return CaptureDeviceTransportBucket.bucket(rawTransportType: transport)
    }
}
