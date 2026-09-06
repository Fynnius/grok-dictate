/// Tier 2 of the ladder: synthetic keyboard events carrying Unicode.
///
/// `CGEventKeyboardSetUnicodeString` on a key event with virtual key 0. The
/// string rides on the event rather than being derived from a keycode, so this
/// is layout-independent — it types `ü` correctly on QWERTZ, QWERTY and Dvorak
/// alike, which is exactly the trap  describes for keycode-based
/// approaches. It works essentially anywhere a keyboard works, including the
/// Electron apps and terminals where the AX tier gives up (§4.6, §5.8).
///
/// `CGEvent.post` reports "posted", never "landed": a fast app can drop
/// characters mid-injection with no error anywhere. That is why the contract
/// marks this tier's `ok` as untrustworthy and why the HUD shows the full
/// transcript. **This tier reports `.succeeded`, never `.confirmed`** — "typed,
/// unconfirmed" is the strongest honest thing it can say about itself.
///
/// **Two BUG-1 defences were removed on 2026-09-06, and it is worth knowing
/// why**, because both were written against real incidents and neither was
/// wrong to try:
///
///   - **the pacing rule** slowed long text down, reasoning from the 2026-08-09
///     `cmux` drop that "the variable is how many events arrive back to back".
///     That was a defensible inference and it appears to be the wrong
///     diagnosis. xterm.js with the kitty keyboard protocol calls
///     `preventDefault()` on the synthetic keydown, cancelling Chromium's
///     native `insertText` before the glyph reaches the PTY — protocol-level
///     interception that no spacing addresses. The rule taxed 39 % of
///     dictations at ~0.9 ms per character and fixed nothing.
///   - **the length check** read the focused element's `kAXNumberOfCharacters`
///     around the injection. It shipped *off*, because in the very application
///     the incident happened in that attribute is permanently `0` — so it
///     produced 7 false "not inserted" alarms over text that was on screen, and
///     0 true positives.
///
/// What replaced both is the paste tier: it bypasses the keydown path entirely
/// and comes with a read receipt from the operating system. Long text and
/// terminals route there now, and this tier is the fallback for everything
/// else. `docs/report-insertion-2026-09-06.md` §3 has the evidence.
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
///    It lives in `ModifierSettle` since the paste tier arrived, because the
///    ⌘V chord needs exactly the same wait and for a sharper version of the
///    same reason.

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

    func typeText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        guard let source = CGEventSource(stateID: .privateState) else {
            return .failed(reason: "could not create a private CGEventSource")
        }

        ModifierSettle.wait(timeout: settings.modifierSettleTimeout, log: log)

        let chunks = TextChunker.chunks(of: text)
        let route = UnicodePostRouting.route(processId: app.processId)
        let targetPid: pid_t?
        switch route {
        case let .pid(pid):
            targetPid = pid
            log(
                .info,
                "posting Unicode events to pid \(pid) (\(app.name ?? app.bundleId ?? "unknown"))"
            )
        case .globalTap:
            targetPid = nil
            log(.info, "posting Unicode events on the global tap — no live target pid")
        }

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

            // Private source + cleared flags stay on both routes (retry is
            // Ctrl+Cmd+V; an injected `a` carrying Cmd is ⌘A).
            if let pid = targetPid {
                keyDown.postToPid(pid)
                keyUp.postToPid(pid)
            } else {
                // The HID level, where Espanso, cliclick and Karabiner put
                // their events and what reaches the widest set of apps. The
                // session-tap alternative was an environment knob for one
                // measurement session in August and was never needed.
                keyDown.post(tap: .cghidEventTap)
                keyUp.post(tap: .cghidEventTap)
            }
        }

        log(
            .info,
            "posted \(chunks.count) Unicode chunk(s) totalling \(text.utf16.count) UTF-16 units"
        )

        // "Posted", which is all this tier can ever honestly claim. The app
        // presents it as "typed, unconfirmed" and keeps the full transcript, so
        // a partial injection stays recoverable with ⌃⌘V.
        return .succeeded
    }
}

/// Used when `GROK_DICTATE_HELPER_DRY_RUN` is set: the ladder runs, the frames
/// and their correlation are exercised for real, and nothing is typed anywhere.
/// Both tiers fail, so the reported outcome is `tier:"none", ok:false` — an
/// honest "nothing happened" rather than a fake success.
final class DryRunInserter: PasteInserting, AccessibilityInserting, UnicodeInserting {
    private static let reason =
        "dry run — insertion is disabled by GROK_DICTATE_HELPER_DRY_RUN"

    func paste(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        .failed(reason: Self.reason)
    }
    func insertSelectedText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        .failed(reason: Self.reason)
    }
    /// `.unknown` routes to typing, which under a dry run types nothing. The
    /// point of the mode is that no pasteboard is published either.
    func focusSignature(of app: FrontmostAppInfo) -> FocusSignature { .unknown }
    func typeText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        .failed(reason: Self.reason)
    }
}
