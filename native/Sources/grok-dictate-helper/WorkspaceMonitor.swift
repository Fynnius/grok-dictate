/// Reports which application owns the menu bar.
///
/// Two consumers, with different needs:
///
///   - `get_frontmost` is answered from a **live query**, because the target
///     is captured at `ptt_down` and verified before
///     inserting — a cached value with even a second of lag would defeat the
///     check it exists to make.
///   - The unsolicited `frontmost` push is informational, and is driven by both
///     the workspace notification *and* a poll. The notification is the fast
///     path; the poll is the one that is guaranteed to work. This helper is a
///     plain command-line process with no bundle and no `NSApplication`, and
///     whether it reliably receives `NSWorkspace` activation notifications in
///     that configuration is not something to bet a silent failure on
///. Both funnel through one change tracker, so a
///     duplicate costs nothing.

import AppKit
import Foundation
import HelperCore

final class WorkspaceMonitor: FrontmostAppProviding {
    private let tracker = ChangeTracker<FrontmostAppInfo>()
    private let onChange: (FrontmostAppInfo) -> Void
    private var observer: NSObjectProtocol?
    private var pollTimer: Timer?

    init(onChange: @escaping (FrontmostAppInfo) -> Void) {
        self.onChange = onChange
    }

    var frontmostApp: FrontmostAppInfo {
        guard let app = NSWorkspace.shared.frontmostApplication else { return .unknown }
        return FrontmostAppInfo(
            bundleId: app.bundleIdentifier,
            name: app.localizedName,
            processId: app.processIdentifier
        )
    }

    func start(pollInterval: TimeInterval) {
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.publishIfChanged()
        }

        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.publishIfChanged()
        }
        // `.common` so the poll keeps running through modal run-loop modes.
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer

        publishIfChanged()
    }

    func stop() {
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            self.observer = nil
        }
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func publishIfChanged() {
        guard let changed = tracker.observe(frontmostApp) else { return }
        onChange(changed)
    }
}
