/// Runtime knobs, read from the environment.
///
/// These were environment variables rather than constants because Phase 2 left
/// the injection chunk size and inter-chunk delay *unmeasured*, and tuning a
/// constant means a rebuild between every attempt while tuning a variable means
/// the person at the keyboard can sweep a value in one sitting.
///
/// **Four of them were removed on 2026-09-06** — `GROK_DICTATE_INJECT_CHUNK`,
/// `_INJECT_DELAY_MS`, `_INJECT_TAP` and `_INJECT_VERIFY`. The measurement
/// session they existed for concluded in August, the pacing and verification
/// they steered are gone, and what is left is a constant in `TextChunker` and
/// the HID tap. `GROK_DICTATE_AX_SKIP` went with them: it was the escape hatch
/// for an application that lies about AX writes, it was never used once, and
/// `InsertRouting` rule 3 now does the same job from what an application *does*
/// rather than from a list of the ones somebody tested.
///
/// What replaced all five is one user-visible setting, `insertMethod`, which
/// travels on the `insert` frame.

import CoreGraphics
import Foundation
import HelperCore

struct Settings {
    /// How long to wait for physically-held modifiers to be released before
    /// injecting. See `UnicodeInserter` for why this exists at all.
    let modifierSettleTimeout: TimeInterval
    let secureInputPollInterval: TimeInterval
    let tapWatchdogInterval: TimeInterval
    /// Disables both insertion tiers. Used by the TypeScript conformance test,
    /// which spawns this binary for real and must not type into whatever window
    /// the developer happens to have open while `npm test` runs.
    let dryRun: Bool
    /// Show the macOS Accessibility prompt when the process is untrusted.
    /// **Off by default** — an automated test must never be able to pop a
    /// system dialog.
    let promptForAccessibility: Bool
    /// Read the caret back after an AX write and only report success if it
    /// moved (`AXWriteVerification`). **On by default**, and the only knob here
    /// whose default is on, because switching it off restores a silent
    /// data-loss bug rather than changing a timing. It exists so the check can
    /// be bisected against a real application in one session — "is this app
    /// broken, or is my verification wrong?" is otherwise a rebuild away.
    let verifyAXWrites: Bool
    /// Skip installing the event tap. Used by the TypeScript conformance test
    /// for the same reason as `promptForAccessibility`: attempting to create a
    /// tap without Input Monitoring can raise a TCC prompt, and a test run that
    /// can put a modal on screen is a test run that can hang.
    let installTap: Bool

    static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment)
        -> Settings
    {
        Settings(
            modifierSettleTimeout: msValue(
                environment["GROK_DICTATE_MODIFIER_SETTLE_MS"],
                default: 500,
                minimum: 0,
                maximum: 5_000
            ),
            secureInputPollInterval: msValue(
                environment["GROK_DICTATE_SECURE_INPUT_POLL_MS"],
                default: 1_000,
                minimum: 100,
                maximum: 30_000
            ),
            tapWatchdogInterval: msValue(
                environment["GROK_DICTATE_TAP_WATCHDOG_MS"],
                default: 5_000,
                minimum: 500,
                maximum: 120_000
            ),
            dryRun: isTruthy(environment["GROK_DICTATE_HELPER_DRY_RUN"]),
            promptForAccessibility: isTruthy(environment["GROK_DICTATE_HELPER_PROMPT"]),
            verifyAXWrites: !isFalsy(environment["GROK_DICTATE_AX_VERIFY"]),
            installTap: !isTruthy(environment["GROK_DICTATE_HELPER_NO_TAP"])
        )
    }

    private static func isTruthy(_ raw: String?) -> Bool {
        guard let raw = raw?.lowercased() else { return false }
        return raw == "1" || raw == "true" || raw == "yes"
    }

    /// Only an explicit, recognised "off" turns a default-on setting off. An
    /// unset variable, and equally a typo in one, leaves the safe behaviour in
    /// place — the failure mode of the alternative is a machine where
    /// verification is quietly disabled and nobody knows why.
    private static func isFalsy(_ raw: String?) -> Bool {
        guard let raw = raw?.lowercased() else { return false }
        return raw == "0" || raw == "false" || raw == "no"
    }

    /// Out-of-range and unparseable values fall back to the default rather than
    /// failing to start. A helper that refuses to launch because of a typo in an
    /// environment variable is a dead hotkey with an obscure cause; the
    /// substitution is reported as a `log` frame instead.
    private static func msValue(
        _ raw: String?,
        default fallbackMs: Double,
        minimum: Double,
        maximum: Double
    ) -> TimeInterval {
        guard let raw, let value = Double(raw), value >= minimum, value <= maximum else {
            return fallbackMs / 1000
        }
        return value / 1000
    }
}
