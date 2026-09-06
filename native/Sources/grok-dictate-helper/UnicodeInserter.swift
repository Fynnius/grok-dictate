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
/// transcript — and, since BUG-1 turned that theoretical warning into 60.3 s of
/// lost dictation in `cmux`, why the tier no longer stops at "posted":
///
///   - it **paces itself by length** (`InjectionPacer`), because the burst that
///     was dropped was 38 events in 245 ms and the three that landed the same
///     day were 3–4 events each;
///   - it **measures the target's text length** around the injection
///     (`InjectionVerifier`, `UnicodeWriteVerification`) and reports landed, did
///     not land, or cannot tell.
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

        let pacing = InjectionPacer.pacing(
            forUTF16Count: text.utf16.count,
            baseline: settings.injectionBaseline
        )
        let chunks = TextChunker.chunks(of: text, maxUTF16Units: pacing.chunkUnits)
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

        // Measured after the modifier wait and immediately before the first
        // event, so the "before" length is the state the injection is about to
        // act on. Half a second of waiting for the user's fingers to leave ⌃⌘V
        // is long enough for a terminal to print something on its own.
        let preparation = settings.verifyUnicodeWrites
            ? InjectionVerifier.prepare(for: app)
            : .notPossible("GROK_DICTATE_INJECT_VERIFY is off")

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
                keyDown.post(tap: settings.injectTap)
                keyUp.post(tap: settings.injectTap)
            }

            if index < chunks.count - 1, pacing.interChunkDelay > 0 {
                Thread.sleep(forTimeInterval: pacing.interChunkDelay)
            }
        }

        log(
            .info,
            "posted \(chunks.count) Unicode chunk(s) totalling \(text.utf16.count) UTF-16 units "
                + "at \(pacing.summary)"
                + (pacing.isPacedForLength ? " — slowed down because the text is long" : "")
        )

        return verdict(for: preparation, typedUTF16Units: text.utf16.count, into: app)
    }

    /// Turn what the target's text length did into what the tier reports.
    ///
    /// Three outcomes, and the middle one is the honest new state the whole
    /// contract change exists for: `ok: true` with `verified: null` — "typed,
    /// unconfirmed". It is what every target that exposes no readable length
    /// gets, and it is strictly more truthful than the green pill BUG-1 shipped.
    private func verdict(
        for preparation: InjectionVerifier.Preparation,
        typedUTF16Units typed: Int,
        into app: FrontmostAppInfo
    ) -> TierAttempt {
        let measurement: InjectionVerifier.Measurement
        switch preparation {
        case let .ready(prepared):
            measurement = prepared
        case let .notPossible(reason):
            // Said out loud on every insert, not once at start-up: whether a
            // target can be measured is a fact about *that* target, and "why is
            // this app never verified?" is otherwise unanswerable from a log.
            log(.info, "the injection could not be verified — \(reason)")
            return .succeeded
        }

        let target = app.name ?? app.bundleId ?? "the frontmost application"
        switch InjectionVerifier.confirm(measurement, typedUTF16Units: typed) {
        case let .landed(growth):
            log(
                .info,
                "confirmed the injection landed in \(target) — \(measurement.source.description) "
                    + "grew by \(growth)"
            )
            return .confirmed

        case let .unverifiable(evidence):
            log(.info, "the injection into \(target) could not be confirmed — \(evidence)")
            return .succeeded

        case let .didNotLand(evidence):
            // A warning, not an info line, for the same reason the AX tier's
            // discarded-write log is one: this is a diagnosis of the other
            // application, and it is the line somebody will be looking for when
            // they ask why the pill went red. The incident it comes from left
            // no trace at all in any log.
            log(
                .warn,
                "\(target) dropped the injected text — \(evidence). It was typed as synthetic key "
                    + "events, which report no error when an app discards them"
            )
            return .notLanded(reason: evidence)
        }
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
