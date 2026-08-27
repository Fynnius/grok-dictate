/// Pure restore decision for system-output mute.
///
/// The executable (`OutputMute.swift`) talks to CoreAudio. This file decides
/// *which* device to restore, whether the lock may be dropped, and whether
/// to wait — so the policy is `swift test`able with no hardware.
///
/// The load-bearing rule: **restore the device we muted**, not whatever is
/// default now. A default-output change mid-recording used to drop the lock
/// and return, leaving the original device muted with nothing to retry.

public struct OutputMuteSnapshot: Codable, Equatable, Sendable {
    public var deviceUID: String
    public var method: OutputMuteMethod
    public var previousMute: Bool?
    public var previousVolume: Float?

    public init(
        deviceUID: String,
        method: OutputMuteMethod,
        previousMute: Bool? = nil,
        previousVolume: Float? = nil
    ) {
        self.deviceUID = deviceUID
        self.method = method
        self.previousMute = previousMute
        self.previousVolume = previousVolume
    }
}

public enum OutputMuteMethod: String, Codable, Sendable {
    case mute
    case volume
}

public enum OutputMuteRestoreDecision: Equatable, Sendable {
    /// Apply the snapshot to this UID (the device we muted), then drop the lock.
    case restore(OutputMuteSnapshot)
    /// User already changed that device. Drop the lock; do not clobber.
    case abandon(reason: String)
    /// The snapshotted device is gone or unreadable. Keep the lock and try
    /// again on the next unmute / helper launch.
    case retryLater(reason: String)
}

public enum OutputMuteRestore {
    /// Below this, volume is treated as still "we set it to zero".
    ///
    /// **Chosen, not measured.** Hardware mute is preferred; this is the
    /// volume-to-zero fallback's "still ours" check. 0.001 is well under any
    /// user-audible level and above a denormal leftover.
    public static let stillZeroVolume: Float = 0.001

    /// Decide what unmute should do.
    ///
    /// `snapshottedDeviceExists` is whether a device with `snapshot.deviceUID`
    /// is still in the system — not whether it is the current default.
    /// `currentMute` / `currentVolume` are read from **that** device.
    public static func decide(
        snapshot: OutputMuteSnapshot,
        snapshottedDeviceExists: Bool,
        currentMute: Bool?,
        currentVolume: Float?
    ) -> OutputMuteRestoreDecision {
        guard snapshottedDeviceExists else {
            // A previous build stored a numeric AudioDeviceID as the "UID".
            // Those ids are not stable and cannot be looked up. Dropping that
            // lock is better than pinning mute() off forever; a real CoreAudio
            // UID that vanished is AirPods unplugged and must be retried.
            if isLegacyNumericID(snapshot.deviceUID) {
                return .abandon(reason: "legacy numeric device id; cannot restore")
            }
            return .retryLater(reason: "snapshotted device \(snapshot.deviceUID) is not present")
        }

        switch snapshot.method {
        case .mute:
            guard let currentlyMuted = currentMute else {
                return .retryLater(reason: "snapshotted device exposes no mute now")
            }
            if currentlyMuted == false {
                return .abandon(reason: "user already unmuted")
            }
            return .restore(snapshot)

        case .volume:
            guard let volume = currentVolume else {
                return .retryLater(reason: "snapshotted device exposes no volume now")
            }
            if volume > stillZeroVolume {
                return .abandon(reason: "user changed volume")
            }
            return .restore(snapshot)
        }
    }

    /// True after a successful CoreAudio apply, or an abandon. False on
    /// retryLater **and** on a restore whose apply failed — the lock stays.
    public static func dropLock(after decision: OutputMuteRestoreDecision, applySucceeded: Bool)
        -> Bool
    {
        switch decision {
        case .restore:
            return applySucceeded
        case .abandon:
            return true
        case .retryLater:
            return false
        }
    }

    /// Numeric AudioDeviceID strings from the first mute build. Real device
    /// UIDs are names like `BuiltInSpeakerDevice`, not a bare decimal.
    public static func isLegacyNumericID(_ uid: String) -> Bool {
        !uid.isEmpty && uid.allSatisfy(\.isNumber)
    }
}
