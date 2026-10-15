/// Polls `IsSecureEventInputEnabled()` and reports changes, plus who holds it.
///
/// : when macOS Secure Input is active — normally when focus
/// enters a password field — **no third-party process can install a
/// `CGEventTap`, system-wide**. Apps routinely get stuck in that state without
/// calling `DisableSecureEventInput()`; there are long-running bug threads for
/// 1Password and KeePassXC. So this is not a rare edge case, and while it is
/// active the Fn key is simply dead.
///
/// §12.2: "Both produce no error, no log, no crash — the hotkey simply stops
/// responding." This frame is the only thing that turns that into a visible
/// state instead of "the app is broken", which is the entire reason it survived
/// the single-user scope cut in §5.5.
///
/// There is no notification for this; polling is the documented approach.
///
/// **Who holds it, not just that something does.** Knowing the hotkey is dead
/// was not enough for a user who hit this 111 times in a month to actually fix
/// anything — the product never said which app to go and dismiss. See
/// `currentHolder()` for how the pid is found and named.

import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import HelperCore

final class SecureInputMonitor {
    /// Both triggers this type watches for, bundled into one `Equatable` value
    /// so a single `ChangeTracker` catches either: the on/off bit flipping,
    /// *and* the holder changing while it stays on — one password field losing
    /// focus to another without Secure Input ever clearing in between.
    private struct State: Equatable {
        let enabled: Bool
        let holder: SecureInputHolder?
    }

    private let tracker = ChangeTracker<State>()
    private let onChange: (Bool, SecureInputHolder?) -> Void
    private var timer: Timer?

    init(onChange: @escaping (Bool, SecureInputHolder?) -> Void) {
        self.onChange = onChange
    }

    var isEnabled: Bool { IsSecureEventInputEnabled() }

    func start(pollInterval: TimeInterval) {
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.publishIfChanged()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer

        // Contract §2: emitted on change only, "plus once shortly after `ready`
        // to establish the initial value". The tracker starts empty, so this
        // first observation always publishes.
        publishIfChanged()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func publishIfChanged() {
        let enabled = isEnabled
        let holder = enabled ? Self.currentHolder() : nil
        guard let changed = tracker.observe(State(enabled: enabled, holder: holder)) else { return }
        onChange(changed.enabled, changed.holder)
    }

    /// Who macOS reports is holding Secure Input right now.
    ///
    /// **Measured 2026-10-15, macOS 27**, by toggling Terminal.app's own
    /// Terminal ▸ Secure Keyboard Entry and re-reading the session dictionary:
    /// `CGSessionCopyCurrentDictionary()` gains a `kCGSSessionSecureInputPID`
    /// entry — absent while Secure Input is off — set to the holder's pid as
    /// an `NSNumber`. Also visible via `ioreg -l -w 0 | grep SecureInput`.
    ///
    /// `NSRunningApplication(processIdentifier:)` names anything with an
    /// `NSApplication` — which is every realistic holder (1Password,
    /// KeePassXC, Terminal) — via its `localizedName`. A plain command-line
    /// tool holding Secure Input (`ssh`, `sudo`) has no `NSApplication` and
    /// falls back to `proc_name`, its raw process name. `nil` only when
    /// neither resolves anything, which the caller treats as "unknown".
    private static func currentHolder() -> SecureInputHolder? {
        guard
            let dictionary = CGSessionCopyCurrentDictionary() as NSDictionary?,
            let pid = dictionary["kCGSSessionSecureInputPID"] as? Int32
        else { return nil }

        if let app = NSRunningApplication(processIdentifier: pid) {
            return SecureInputHolder(name: app.localizedName, bundleId: app.bundleIdentifier)
        }

        var nameBuffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard proc_name(pid, &nameBuffer, UInt32(nameBuffer.count)) > 0 else { return nil }
        return SecureInputHolder(name: String(cString: nameBuffer), bundleId: nil)
    }
}
