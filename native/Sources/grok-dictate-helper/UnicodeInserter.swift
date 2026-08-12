/// Tier 2 of the ladder: synthetic keyboard events carrying Unicode.
///
/// `CGEventKeyboardSetUnicodeString` on a key event with virtual key 0. The
/// string rides on the event rather than being derived from a keycode, so this
/// is layout-independent — it types `ü` correctly on QWERTZ, QWERTY and Dvorak
/// alike, which is exactly the trap  describes for keycode-based
/// approaches. It works essentially anywhere a keyboard works, including the
/// Electron apps and terminals where the AX tier gives up (§4.6, §5.8).
///
/// It reports "posted", never "landed". : a fast app can drop
/// characters mid-injection with no error anywhere. That is why the contract
/// marks this tier's `ok` as untrustworthy and why the HUD shows the full
/// transcript.
///
/// **Two details here are load-bearing and easy to get wrong.**
///
/// 1. `CGEventSource(stateID: .privateState)` plus explicitly cleared flags.
///    A source built from `.hidSystemState` inherits the *physically held*
///    modifiers. The retry hotkey is Ctrl+Cmd+V, so at the
///    moment a retry insertion starts, Ctrl and Cmd are almost always still
///    down — and an injected `a` carrying Cmd is not the letter a, it is
///    ⌘A "select all", followed by every subsequent character replacing the
///    selection. The private state starts empty and the flags are zeroed on
///    every event so this cannot happen.
/// 2. The bounded wait for real modifiers to clear, for the same reason from
///    the other side: some applications read `NSEvent.modifierFlags` (global
///    hardware state) rather than the flags on the event they were handed.
///    Waiting a few tens of milliseconds for the user's fingers to leave the
///    keys costs nothing perceptible and removes that whole class of misfire.

import CoreGraphics
import Foundation
import HelperCore

final class UnicodeInserter: UnicodeInserting {
    private let settings: Settings
    private let log: (LogLevel, String) -> Void

    init(settings: Settings, log: @escaping (LogLevel, String) -> Void) {
        self.settings = settings
        self.log = log
    }

    func typeText(_ text: String) -> TierAttempt {
        guard let source = CGEventSource(stateID: .privateState) else {
            return .failed(reason: "could not create a private CGEventSource")
        }

        waitForModifiersToClear()

        let chunks = TextChunker.chunks(of: text, maxUTF16Units: settings.injectChunkUnits)
        for (index, chunk) in chunks.enumerated() {
            var units = Array(chunk.utf16)
            guard
                let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else {
                return .failed(
                    reason:
                        "could not create a keyboard event after \(index) of \(chunks.count) chunks"
                )
            }

            // Detail 1 above. Belt and braces on top of `.privateState`.
            keyDown.flags = []
            keyUp.flags = []

            keyDown.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            keyUp.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)

            keyDown.post(tap: settings.injectTap)
            keyUp.post(tap: settings.injectTap)

            if index < chunks.count - 1, settings.injectDelay > 0 {
                Thread.sleep(forTimeInterval: settings.injectDelay)
            }
        }

        log(
            .info,
            "posted \(chunks.count) Unicode chunk(s) totalling \(text.utf16.count) UTF-16 units"
        )
        return .succeeded
    }

    /// Poll until no chord modifier is physically held, or the timeout expires.
    ///
    /// Fn is deliberately not waited on: the state machine queues a `ptt_down`
    /// that arrives while inserting rather than dropping it
    /// (`contracts/state-machine.md` §5), so the user legitimately holds Fn
    /// during an insert — and Fn alone triggers nothing in the target app.
    private func waitForModifiersToClear() {
        guard settings.modifierSettleTimeout > 0 else { return }
        let step: TimeInterval = 0.01
        var waited: TimeInterval = 0
        while waited < settings.modifierSettleTimeout, heldChordModifiers().isEmpty == false {
            Thread.sleep(forTimeInterval: step)
            waited += step
        }
        let stillHeld = heldChordModifiers()
        if !stillHeld.isEmpty {
            log(
                .warn,
                "injecting while \(stillHeld.joined(separator: "+")) is still held — "
                    + "if characters come out as shortcuts, let go of the keys sooner"
            )
        } else if waited > 0 {
            log(.info, "waited \(Int(waited * 1000)) ms for held modifiers to clear before injecting")
        }
    }

    private func heldChordModifiers() -> [String] {
        let flags = CGEventSource.flagsState(.combinedSessionState)
        var held: [String] = []
        if flags.contains(.maskShift) { held.append("Shift") }
        if flags.contains(.maskControl) { held.append("Control") }
        if flags.contains(.maskAlternate) { held.append("Option") }
        if flags.contains(.maskCommand) { held.append("Command") }
        return held
    }
}

/// Used when `GROK_DICTATE_HELPER_DRY_RUN` is set: the ladder runs, the frames
/// and their correlation are exercised for real, and nothing is typed anywhere.
/// Both tiers fail, so the reported outcome is `tier:"none", ok:false` — an
/// honest "nothing happened" rather than a fake success.
final class DryRunInserter: AccessibilityInserting, UnicodeInserting {
    private static let reason =
        "dry run — insertion is disabled by GROK_DICTATE_HELPER_DRY_RUN"

    func insertSelectedText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        .failed(reason: Self.reason)
    }
    func typeText(_ text: String) -> TierAttempt { .failed(reason: Self.reason) }
}
