/// Runtime knobs, read from the environment.
///
/// These are environment variables rather than constants for one specific
/// reason:  leaves the injection chunk size and inter-chunk delay
/// *unmeasured* — "real behaviour in VS Code, Cursor, iTerm, Slack is
/// unverified" — and IMPLEMENTATION-PLAN.md §3.2 makes measuring them a
/// human-in-the-loop test. Tuning a constant means a rebuild between every
/// attempt; tuning an environment variable means the person at the keyboard can
/// sweep the value in one sitting. Whatever the measurement lands on becomes
/// the default here, and `docs/phase-2-report.md` records the evidence.

import CoreGraphics
import Foundation
import HelperCore

struct Settings {
    /// UTF-16 units per `CGEventKeyboardSetUnicodeString` call.
    let injectChunkUnits: Int
    /// Pause between chunks. Zero is legal and fastest; raise it if a target
    /// app drops characters.
    let injectDelay: TimeInterval
    /// Where injected events enter the system.
    ///
    /// `.cghidEventTap` puts them in at the HID level, which is what the
    /// battle-tested tools (Espanso, cliclick, Karabiner) use and what reaches
    /// the widest set of apps. `.cgAnnotatedSessionEventTap` enters later, past
    /// the HID taps. Overridable because "which one works in Cursor" is an
    /// empirical question this phase answers.
    let injectTap: CGEventTapLocation
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
    /// Bundle identifiers to skip the AX tier for. See the note on
    /// `InsertionLadder.axSkipBundleIds` — it is an escape hatch for an app
    /// that reports a successful AX write and inserts nothing.
    let axSkipBundleIds: Set<String>
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
            injectChunkUnits: intValue(
                environment["GROK_DICTATE_INJECT_CHUNK"],
                default: TextChunker.defaultMaxUTF16Units,
                minimum: 1,
                maximum: 4096
            ),
            injectDelay: msValue(
                environment["GROK_DICTATE_INJECT_DELAY_MS"],
                default: 5,
                minimum: 0,
                maximum: 250
            ),
            injectTap: environment["GROK_DICTATE_INJECT_TAP"]?.lowercased() == "session"
                ? .cgAnnotatedSessionEventTap
                : .cghidEventTap,
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
            axSkipBundleIds: Set(
                (environment["GROK_DICTATE_AX_SKIP"] ?? "")
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
            ),
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
    private static func intValue(_ raw: String?, default fallback: Int, minimum: Int, maximum: Int)
        -> Int
    {
        guard let raw, let value = Int(raw), value >= minimum, value <= maximum else {
            return fallback
        }
        return value
    }

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
