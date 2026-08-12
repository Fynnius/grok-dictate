/// Polls `IsSecureEventInputEnabled()` and reports changes.
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

import Carbon.HIToolbox
import Foundation
import HelperCore

final class SecureInputMonitor {
    private let tracker = ChangeTracker<Bool>()
    private let onChange: (Bool) -> Void
    private var timer: Timer?

    init(onChange: @escaping (Bool) -> Void) {
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
        guard let changed = tracker.observe(isEnabled) else { return }
        onChange(changed)
    }
}
