/// CoreAudio introspection for the input device capture opens.
///
/// `CaptureEngine` normally leaves its input node on the system *default*
/// input device. The one exception is `InputRouting`: when the default is a
/// Bluetooth headset and the built-in microphone is usable, the engine pins
/// the built-in microphone with `AUAudioUnit.setDeviceID`. `current(pinned:)`
/// therefore describes the pinned device when there is one and the default
/// otherwise — the device `engine.start()` actually opened. Queried after
/// `engine.start()` returns, not at `prepareIdle()` time, so a route change
/// between prepare and start (AirPods waking up, a USB mic plugged in) is
/// reflected rather than stale.
///
/// The description is diagnostic only, for the `timing` summary line
/// (`docs/report-latency-ux-2026-08-22.md` §W3). Every property read is
/// independently best-effort: a device that cannot be described at all
/// yields `nil`, never a thrown error — this must not be able to turn a
/// successful `start()` into a failed one.
///
/// Deliberately does not query the device's name or UID: `main.log` gets
/// pasted into public GitHub issues, and a Bluetooth UID embeds the device's
/// MAC address while a name is often personal ("Sam's AirPods"). The
/// transport bucket and nominal sample rate answer the diagnostic question
/// without that risk.
import AudioToolbox
import CaptureCore
import CoreAudio
import Foundation
import IOKit

enum InputDeviceInfo {
    static func current(pinned: AudioDeviceID?) -> CaptureDeviceInfo? {
        guard let device = pinned ?? defaultInputDevice() else { return nil }
        return CaptureDeviceInfo(
            transport: transportBucket(device),
            sampleRateHz: nominalSampleRate(device)
        )
    }

    /// The device capture should pin, or `nil` to follow the system default.
    /// See `InputRouting` for why and when.
    static func captureTarget(preferBuiltInMic: Bool) -> AudioDeviceID? {
        guard preferBuiltInMic else { return nil }
        let builtIn = builtInInputDevice()
        let useBuiltIn = InputRouting.shouldUseBuiltIn(
            preferBuiltInMic: preferBuiltInMic,
            defaultInputTransport: defaultInputDevice().flatMap(transportBucket),
            hasBuiltInInput: builtIn != nil,
            lidClosed: isLidClosed()
        )
        return useBuiltIn ? builtIn : nil
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

    /// The first live built-in device with at least one input stream — on a
    /// MacBook, "MacBook Pro Microphone". The speakers are a separate
    /// output-only device, so the input-stream check is what tells them apart.
    private static func builtInInputDevice() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0
        else { return nil }
        var devices = [AudioDeviceID](
            repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr
        else { return nil }
        return devices.first { device in
            transportBucket(device) == "built_in" && hasInputStreams(device) && isAlive(device)
        }
    }

    private static func hasInputStreams(_ device: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        let status = AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size)
        return status == noErr && size > 0
    }

    private static func isAlive(_ device: AudioDeviceID) -> Bool {
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &alive)
        return status == noErr && alive != 0
    }

    /// `AppleClamshellState` on `IOPMrootDomain`: `true` when a laptop's lid
    /// is shut. A read failure (a desktop Mac has no such property) is "open".
    private static func isLidClosed() -> Bool {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard service != 0 else { return false }
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(
            service, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0
        )?.takeRetainedValue()
        return (value as? Bool) ?? false
    }
}
