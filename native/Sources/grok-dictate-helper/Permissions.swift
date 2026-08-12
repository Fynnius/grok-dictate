import ApplicationServices
import Foundation

/// Whether this process may use the Accessibility API and install an active
/// event tap.
///
/// `prompt` defaults to **false**. The prompting form of this call puts a
/// system dialog on screen, and this binary is spawned by an automated test
/// (`src/main/native/helper-binary.test.ts`); a test run that can pop a modal
/// is a test run that can hang. Prompting is opt-in via
/// `GROK_DICTATE_HELPER_PROMPT=1`, and the untrusted case is reported as an
/// actionable `log` frame either way.
///
/// : the grant binds to the *signature*, and in development it
/// attaches to the Electron binary that spawns this process rather than to this
/// binary — assumption 10.5, still unverified, and the first thing the Phase 2
/// human tests check.
func isAccessibilityTrusted(prompt: Bool = false) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}
