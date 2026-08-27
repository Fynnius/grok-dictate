import Testing

@testable import HelperCore

@Suite("Output mute restore")
struct OutputMuteRestoreTests {
    private let speakers = OutputMuteSnapshot(
        deviceUID: "BuiltInSpeakerDevice",
        method: .mute,
        previousMute: false
    )

    @Test("restores the snapshotted device even when it is no longer the default")
    func restoresOriginalWhenDefaultChanged() {
        // The bug: unmute compared the numeric default-output id, dropped the
        // lock, and returned — speakers stayed muted, headphones now default.
        let decision = OutputMuteRestore.decide(
            snapshot: speakers,
            snapshottedDeviceExists: true,
            currentMute: true,
            currentVolume: nil
        )
        #expect(decision == .restore(speakers))
        #expect(OutputMuteRestore.dropLock(after: decision, applySucceeded: true))
        // Apply failed: lock stays so a later unmute can retry.
        #expect(OutputMuteRestore.dropLock(after: decision, applySucceeded: false) == false)
    }

    @Test("keeps the lock when the muted device has vanished")
    func missingDeviceRetries() {
        let decision = OutputMuteRestore.decide(
            snapshot: speakers,
            snapshottedDeviceExists: false,
            currentMute: nil,
            currentVolume: nil
        )
        #expect(decision == .retryLater(reason: "snapshotted device BuiltInSpeakerDevice is not present"))
        #expect(OutputMuteRestore.dropLock(after: decision, applySucceeded: true) == false)
    }

    @Test("does not unmute a user who already unmuted")
    func doesNotClobberUnmute() {
        let decision = OutputMuteRestore.decide(
            snapshot: speakers,
            snapshottedDeviceExists: true,
            currentMute: false,
            currentVolume: nil
        )
        #expect(decision == .abandon(reason: "user already unmuted"))
        #expect(OutputMuteRestore.dropLock(after: decision, applySucceeded: false))
    }

    @Test("does not stamp volume over a user who turned it up")
    func doesNotClobberVolume() {
        let snapshot = OutputMuteSnapshot(
            deviceUID: "BuiltInSpeakerDevice",
            method: .volume,
            previousVolume: 0.42
        )
        let decision = OutputMuteRestore.decide(
            snapshot: snapshot,
            snapshottedDeviceExists: true,
            currentMute: nil,
            currentVolume: 0.5
        )
        #expect(decision == .abandon(reason: "user changed volume"))
    }

    @Test("restores volume when it is still at zero")
    func restoresVolumeWhenStillOurs() {
        let snapshot = OutputMuteSnapshot(
            deviceUID: "BuiltInSpeakerDevice",
            method: .volume,
            previousVolume: 0.42
        )
        let decision = OutputMuteRestore.decide(
            snapshot: snapshot,
            snapshottedDeviceExists: true,
            currentMute: nil,
            currentVolume: 0
        )
        #expect(decision == .restore(snapshot))
    }

    @Test("drops a leftover lock from the numeric-id build rather than retrying forever")
    func legacyNumericIDAbandons() {
        let snapshot = OutputMuteSnapshot(deviceUID: "87", method: .mute, previousMute: false)
        let decision = OutputMuteRestore.decide(
            snapshot: snapshot,
            snapshottedDeviceExists: false,
            currentMute: nil,
            currentVolume: nil
        )
        #expect(decision == .abandon(reason: "legacy numeric device id; cannot restore"))
        #expect(OutputMuteRestore.dropLock(after: decision, applySucceeded: false))
    }

    @Test("a vanished real UID is retried, not abandoned")
    func realUIDMissingRetries() {
        #expect(OutputMuteRestore.isLegacyNumericID("BuiltInSpeakerDevice") == false)
        #expect(OutputMuteRestore.isLegacyNumericID("87"))
        #expect(OutputMuteRestore.isLegacyNumericID("") == false)
    }
}
