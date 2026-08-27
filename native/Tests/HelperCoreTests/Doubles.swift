/// Test doubles shared across the suite.
///
/// `SpyPasteboard` is the important one: it is the instrument that turns
///  hard product requirement — the clipboard is never written
/// except on an explicit user click — into something a test can fail on.

import Foundation

@testable import HelperCore

final class SpyOutputMute: OutputMuting, @unchecked Sendable {
    private(set) var calls: [String] = []
    func mute() { calls.append("mute") }
    func unmute() { calls.append("unmute") }
}

final class SpyPasteboard: PasteboardWriting {
    private(set) var writes: [String] = []

    func write(_ text: String) {
        writes.append(text)
    }
}

final class StubAccessibilityInserter: AccessibilityInserting {
    var result: TierAttempt
    private(set) var calls: [String] = []
    /// The app the ladder handed over — asserted so the tier cannot quietly
    /// act on a different application than the target check approved.
    private(set) var targets: [FrontmostAppInfo] = []

    init(result: TierAttempt) {
        self.result = result
    }

    func insertSelectedText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        calls.append(text)
        targets.append(app)
        return result
    }
}

final class StubUnicodeInserter: UnicodeInserting {
    var result: TierAttempt
    private(set) var calls: [String] = []
    /// The app the ladder handed over. Asserted for the same reason the AX
    /// stub's is: since BUG-1 this tier reads the target's text length back, and
    /// verifying a *different* application than the one that was typed into
    /// would be worse than not verifying at all.
    private(set) var targets: [FrontmostAppInfo] = []

    init(result: TierAttempt) {
        self.result = result
    }

    func typeText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        calls.append(text)
        targets.append(app)
        return result
    }
}

final class StubFrontmost: FrontmostAppProviding {
    var frontmostApp: FrontmostAppInfo

    init(bundleId: String?, name: String? = nil, processId: Int32? = 4242) {
        frontmostApp = FrontmostAppInfo(bundleId: bundleId, name: name, processId: processId)
    }
}

final class FakeTapHandle: EventTapHandle {
    private(set) var isEnabled: Bool
    private(set) var setEnabledCalls: [Bool] = []

    init(isEnabled: Bool) {
        self.isEnabled = isEnabled
    }

    func setEnabled(_ enabled: Bool) {
        setEnabledCalls.append(enabled)
        isEnabled = enabled
    }

    /// Simulate macOS switching the tap off behind our back.
    func disableExternally() {
        isEnabled = false
    }
}

/// Collects emitted frames so a test can assert on the wire, not on internals.
final class FrameRecorder {
    private(set) var frames: [HelperFrame] = []

    func emit(_ frame: HelperFrame) {
        frames.append(frame)
    }

    var logMessages: [String] {
        frames.compactMap {
            if case let .log(_, message) = $0 { return message }
            return nil
        }
    }

    func insertResults()
        -> [(
            id: String, tier: InsertTier, ok: Bool, verified: Bool?, error: String?,
            reason: InsertDeclineReason?
        )]
    {
        frames.compactMap {
            if case let .insertResult(id, tier, ok, verified, error, reason, _, _) = $0 {
                return (id, tier, ok, verified, error, reason)
            }
            return nil
        }
    }
}

extension Data {
    var bytes: [UInt8] { [UInt8](self) }
}

extension String {
    var utf8Bytes: [UInt8] { [UInt8](self.utf8) }
}
