/// Mute the default output device while recording, restore when it ends.
///
/// Prefer hardware mute over volume-to-zero: the two restore differently, and
/// volume-to-zero loses the original level if anything goes wrong between.
/// Devices that expose no mute fall back to volume.
///
/// **Do not clobber the user.** If they unmute or change volume during the
/// recording, the snapshot no longer matches and restore is a no-op.
///
/// **Crash-proof.** A lock file records the snapshot. `unmute()` on launch
/// restores a previous process that died muted. `HelperApp.shutdown` and the
/// SIGTERM path also restore. SIGKILL cannot run code; the next launch and
/// the app's defensive `unmute_output` on helper-ready cover it.
///
/// **Restore the device we muted.** The default output changing mid-recording
/// must not drop the lock and walk away — that left the original device muted.
/// Policy lives in `HelperCore.OutputMuteRestore`; this file only talks to
/// CoreAudio.
///
/// Idea from FluidVoice's restore-if-still-ours pattern (clipboard, not
/// audio); reimplemented against CoreAudio. No source copied.

import AudioToolbox
import CoreAudio
import Foundation
import HelperCore

final class SystemOutputMute: OutputMuting, @unchecked Sendable {
    private let log: (LogLevel, String) -> Void
    private let lockURL: URL
    private var snapshot: OutputMuteSnapshot?

    init(log: @escaping (LogLevel, String) -> Void, lockURL: URL? = nil) {
        self.log = log
        self.lockURL =
            lockURL
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Grok Dictate", isDirectory: true)
            .appendingPathComponent("output-mute.lock")
    }

    func mute() {
        guard snapshot == nil, loadLock() == nil else {
            // Already muted by us, or a previous process left a lock — do not
            // stack a second snapshot over the first. Unmute first (helper
            // launch already tries) so a retryLater lock can still clear.
            return
        }
        guard let device = defaultOutputDevice() else {
            log(.warn, "mute_output: no default output device")
            return
        }
        guard let uid = coreAudioUID(device) else {
            log(.warn, "mute_output: default output has no UID")
            return
        }
        if let muted = getMute(device) {
            if muted {
                // User already muted. Do not claim this; restore would unmute them.
                log(.info, "mute_output: output is already muted; leaving it alone")
                return
            }
            if setMute(device, true) {
                snapshot = OutputMuteSnapshot(
                    deviceUID: uid, method: .mute, previousMute: false, previousVolume: nil)
                persist()
                log(.info, "mute_output: hardware mute on \(uid)")
                return
            }
        }
        if let volume = getVolume(device) {
            if setVolume(device, 0) {
                snapshot = OutputMuteSnapshot(
                    deviceUID: uid, method: .volume, previousMute: nil, previousVolume: volume)
                persist()
                log(.info, "mute_output: volume to 0 on \(uid) (no hardware mute)")
                return
            }
        }
        log(.warn, "mute_output: device \(uid) exposes neither mute nor volume")
    }

    func unmute() {
        let stored = snapshot ?? loadLock()
        guard let stored else { return }

        let device = findDevice(uid: stored.deviceUID)
        let decision = OutputMuteRestore.decide(
            snapshot: stored,
            snapshottedDeviceExists: device != nil,
            currentMute: device.flatMap(getMute),
            currentVolume: device.flatMap(getVolume)
        )

        var applied = false
        switch decision {
        case let .restore(toRestore):
            if let device {
                applied = apply(toRestore, to: device)
                if applied {
                    log(
                        .info,
                        "unmute_output: restored \(toRestore.method.rawValue) on \(toRestore.deviceUID)"
                    )
                } else {
                    log(
                        .warn,
                        "unmute_output: CoreAudio restore failed on \(toRestore.deviceUID); keeping lock"
                    )
                }
            }
        case let .abandon(reason):
            log(.info, "unmute_output: \(reason)")
        case let .retryLater(reason):
            log(.warn, "unmute_output: \(reason); keeping lock")
        }

        if OutputMuteRestore.dropLock(after: decision, applySucceeded: applied) {
            snapshot = nil
            clearLock()
        }
    }

    private func apply(_ snapshot: OutputMuteSnapshot, to device: AudioDeviceID) -> Bool {
        switch snapshot.method {
        case .mute:
            return setMute(device, snapshot.previousMute ?? false)
        case .volume:
            guard let previous = snapshot.previousVolume else { return false }
            return setVolume(device, previous)
        }
    }

    // MARK: - lock file

    private func persist() {
        guard let snapshot else { return }
        do {
            try FileManager.default.createDirectory(
                at: lockURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: lockURL, options: .atomic)
        } catch {
            log(.warn, "mute_output: could not write lock file — \(error.localizedDescription)")
        }
    }

    private func loadLock() -> OutputMuteSnapshot? {
        guard let data = try? Data(contentsOf: lockURL) else { return nil }
        return try? JSONDecoder().decode(OutputMuteSnapshot.self, from: data)
    }

    private func clearLock() {
        try? FileManager.default.removeItem(at: lockURL)
    }
}

// MARK: - CoreAudio

private func defaultOutputDevice() -> AudioDeviceID? {
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
    return status == noErr ? device : nil
}

/// Stable CoreAudio device UID (`BuiltInSpeakerDevice`, not the session-local
/// numeric `AudioDeviceID`). Needed so a default-output change can still find
/// the device we muted.
private func coreAudioUID(_ device: AudioDeviceID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid)
    guard status == noErr, let uid else { return nil }
    // GetPropertyData copies the CFString into our slot without transferring
    // +1; unretained is the matching take.
    return uid.takeUnretainedValue() as String
}

private func findDevice(uid: String) -> AudioDeviceID? {
    allDevices().first { coreAudioUID($0) == uid }
}

private func allDevices() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else {
        return []
    }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    guard count > 0 else { return [] }
    var devices = [AudioDeviceID](repeating: 0, count: count)
    let status = AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices)
    return status == noErr ? devices : []
}

private func getMute(_ device: AudioDeviceID) -> Bool? {
    var muted: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &muted)
    return status == noErr ? muted != 0 : nil
}

private func setMute(_ device: AudioDeviceID, _ mute: Bool) -> Bool {
    var muted: UInt32 = mute ? 1 : 0
    let size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    return AudioObjectSetPropertyData(device, &address, 0, nil, size, &muted) == noErr
}

private func getVolume(_ device: AudioDeviceID) -> Float? {
    var volume: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &volume)
    return status == noErr ? volume : nil
}

private func setVolume(_ device: AudioDeviceID, _ volume: Float) -> Bool {
    var value = Float32(volume)
    let size = UInt32(MemoryLayout<Float32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    return AudioObjectSetPropertyData(device, &address, 0, nil, size, &value) == noErr
}
