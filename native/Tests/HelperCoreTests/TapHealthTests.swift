/// Event-tap recovery.
///
/// IMPLEMENTATION-PLAN.md §3.2: "Tap re-arming on `kCGEventTapDisabledByTimeout`
/// / `…ByUserInput`. **Non-negotiable** — without it the hotkey dies silently
/// after hours of uptime (§12.2). Write a test that forces the disable and
/// asserts recovery."
///
/// Forcing a real timeout means blocking a real tap callback for longer than
/// macOS tolerates, which needs a windowserver, an Accessibility grant and
/// several seconds of wall clock — and would still be non-deterministic. A fake
/// handle forces it exactly, every run. What the fake cannot prove is that the
/// callback is wired to this monitor at all; that is `EventTapController` and
/// the human soak test.

import Testing

@testable import HelperCore

@Suite("Event-tap health")
struct TapHealthTests {
    @Test("a timeout disable re-arms the tap")
    func rearmsAfterTimeout() {
        let handle = FakeTapHandle(isEnabled: true)
        var logs: [(LogLevel, String)] = []
        let monitor = TapHealthMonitor(handle: handle, log: { logs.append(($0, $1)) })

        handle.disableExternally()
        monitor.handleDisabled(cause: .timeout)

        #expect(handle.isEnabled)
        #expect(handle.setEnabledCalls == [true])
        #expect(monitor.reactiveRearmCount == 1)
        // Warn, not info: this is the failure that makes a working app look
        // broken, and it must be visible in the app's log.
        #expect(logs.first?.0 == .warn)
        #expect(logs.first?.1.contains("kCGEventTapDisabledByTimeout") == true)
    }

    @Test("a user-input disable re-arms the tap")
    func rearmsAfterUserInput() {
        let handle = FakeTapHandle(isEnabled: true)
        var logs: [(LogLevel, String)] = []
        let monitor = TapHealthMonitor(handle: handle, log: { logs.append(($0, $1)) })

        handle.disableExternally()
        monitor.handleDisabled(cause: .userInput)

        #expect(handle.isEnabled)
        #expect(logs.first?.1.contains("kCGEventTapDisabledByUserInput") == true)
    }

    @Test("re-arming clears the recogniser's latches")
    func rearmNotifiesTheRecogniser() {
        // Events during the outage were never delivered. If Fn came up in that
        // window, the recogniser still believes it is held and the next press
        // emits nothing — a silent failure inside the recovery from a silent
        // failure.
        let handle = FakeTapHandle(isEnabled: true)
        var rearmed = 0
        let monitor = TapHealthMonitor(handle: handle, log: { _, _ in }, onRearmed: { rearmed += 1 })

        monitor.handleDisabled(cause: .timeout)
        #expect(rearmed == 1)
    }

    @Test("the watchdog re-arms a tap that was disabled without a callback")
    func watchdogRearms() {
        let handle = FakeTapHandle(isEnabled: true)
        var logs: [(LogLevel, String)] = []
        let monitor = TapHealthMonitor(handle: handle, log: { logs.append(($0, $1)) })

        monitor.checkAndRearmIfNeeded()
        #expect(monitor.watchdogRearmCount == 0, "a healthy tap must not be touched")
        #expect(handle.setEnabledCalls.isEmpty)

        handle.disableExternally()
        monitor.checkAndRearmIfNeeded()
        #expect(handle.isEnabled)
        #expect(monitor.watchdogRearmCount == 1)
        #expect(logs.last?.0 == .warn)
    }

    @Test("repeated disables keep recovering and keep counting")
    func survivesRepeatedDisables() {
        // The real-world shape: it happens after hours, then again after hours.
        let handle = FakeTapHandle(isEnabled: true)
        let monitor = TapHealthMonitor(handle: handle, log: { _, _ in })
        for _ in 0..<100 {
            handle.disableExternally()
            monitor.handleDisabled(cause: .timeout)
            #expect(handle.isEnabled)
        }
        #expect(monitor.reactiveRearmCount == 100)
    }
}

@Suite("Change tracking")
struct ChangeTrackerTests {
    @Test("the first observation always publishes")
    func firstObservationPublishes() {
        // Contract §2: secure_input is "emitted on change only, plus once
        // shortly after `ready` to establish the initial value". Starting from
        // nil makes those one rule rather than two.
        let tracker = ChangeTracker<Bool>()
        #expect(tracker.observe(false) == false)
        #expect(tracker.observe(false) == nil)
        #expect(tracker.observe(true) == true)
        #expect(tracker.observe(true) == nil)
        #expect(tracker.observe(false) == false)
    }

    @Test("tracks a struct value")
    func tracksStructs() {
        let tracker = ChangeTracker<FrontmostAppInfo>()
        let notes = FrontmostAppInfo(bundleId: "com.apple.Notes", name: "Notes")
        #expect(tracker.observe(notes) == notes)
        #expect(tracker.observe(notes) == nil)
        #expect(tracker.observe(.unknown) == .unknown)
    }

    @Test("reset makes the next observation publish again")
    func resetRepublishes() {
        let tracker = ChangeTracker<Bool>()
        _ = tracker.observe(true)
        tracker.reset()
        #expect(tracker.observe(true) == true)
    }
}
