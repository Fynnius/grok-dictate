/// The `CGEventTap` — the reason this helper exists at all.
///
/// Electron cannot install one, so it cannot see the Fn key and
/// `globalShortcut` has no key-up concept. This tap watches
/// `.flagsChanged`, `.keyDown` and `.keyUp`, hands each event to the pure
/// `HotkeyRecognizer`, and either forwards or swallows it.
///
/// `.defaultTap` rather than `.listenOnly`, because Fn+Space and Ctrl+Cmd+V
/// have to be *consumed* — otherwise every hands-free toggle also types a space
/// into whatever the user is looking at. That upgrade is what makes an
/// Accessibility grant necessary rather than just Input Monitoring.
///
/// The disabled-tap handling in `handle(type:event:)` is the single most
/// important branch in this file. See `TapHealth.swift`.

import CoreGraphics
import Foundation
import HelperCore

final class EventTapController {
    enum InstallError: Error, CustomStringConvertible {
        case tapCreationFailed
        case runLoopSourceFailed

        var description: String {
            switch self {
            case .tapCreationFailed:
                return
                    "could not create the event tap. Grant Accessibility *and* Input Monitoring to "
                    + "the app in System Settings → Privacy & Security, then restart it. If Secure "
                    + "Input is active (a password field is focused somewhere), no third-party "
                    + "process can install a tap at all."
            case .runLoopSourceFailed:
                return "could not attach the event tap to the run loop"
            }
        }
    }

    private let recognizer: HotkeyRecognizer
    private let onActions: ([HotkeyAction], Int) -> Void
    private let log: (LogLevel, String) -> Void

    private var machPort: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var watchdogTimer: Timer?
    private(set) var health: TapHealthMonitor?

    init(
        recognizer: HotkeyRecognizer,
        log: @escaping (LogLevel, String) -> Void,
        onActions: @escaping ([HotkeyAction], Int) -> Void
    ) {
        self.recognizer = recognizer
        self.log = log
        self.onActions = onActions
    }

    func install(watchdogInterval: TimeInterval) throws {
        let mask =
            (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)

        guard
            let port = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .defaultTap,
                eventsOfInterest: CGEventMask(mask),
                callback: eventTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            )
        else {
            throw InstallError.tapCreationFailed
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            throw InstallError.runLoopSourceFailed
        }

        machPort = port
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)

        let health = TapHealthMonitor(
            handle: self,
            log: log,
            onRearmed: { [weak self] in
                // Events that occurred while the tap was down were never seen.
                // Without clearing the latches, an Fn released during the gap
                // leaves the recogniser believing it is still held, and the
                // next press emits nothing at all.
                self?.recognizer.reset()
            }
        )
        self.health = health

        let timer = Timer(timeInterval: watchdogInterval, repeats: true) { _ in
            health.checkAndRearmIfNeeded()
        }
        RunLoop.main.add(timer, forMode: .common)
        watchdogTimer = timer
    }

    func uninstall() {
        watchdogTimer?.invalidate()
        watchdogTimer = nil
        if let port = machPort {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
        }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
        machPort = nil
        runLoopSource = nil
        health = nil
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // Delivered regardless of the event mask, and the only warning macOS
        // gives that the hotkey has just died system-wide.
        if type == .tapDisabledByTimeout {
            health?.handleDisabled(cause: .timeout)
            return nil
        }
        if type == .tapDisabledByUserInput {
            health?.handleDisabled(cause: .userInput)
            return nil
        }

        let kind: KeyboardEvent.Kind
        switch type {
        case .keyDown: kind = .keyDown
        case .keyUp: kind = .keyUp
        case .flagsChanged: kind = .flagsChanged
        default: return Unmanaged.passUnretained(event)
        }

        let timestampMs = Int(Date().timeIntervalSince1970 * 1000)
        let decision = recognizer.handle(
            KeyboardEvent(
                kind: kind,
                keyCode: Int(event.getIntegerValueField(.keyboardEventKeycode)),
                flags: ModifierFlags(rawValue: event.flags.rawValue),
                isAutorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
                timestampMs: timestampMs
            )
        )

        if !decision.actions.isEmpty {
            onActions(decision.actions, timestampMs)
        }
        return decision.consumeEvent ? nil : Unmanaged.passUnretained(event)
    }
}

extension EventTapController: EventTapHandle {
    var isEnabled: Bool {
        guard let port = machPort else { return false }
        return CGEvent.tapIsEnabled(tap: port)
    }

    func setEnabled(_ enabled: Bool) {
        guard let port = machPort else { return }
        CGEvent.tapEnable(tap: port, enable: enabled)
    }
}

/// A C function pointer, so it cannot capture context — the controller travels
/// through `userInfo` as an unretained pointer. Unretained is correct: the
/// controller outlives the tap by construction (it owns it), and retaining here
/// would leak it.
private func eventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let controller = Unmanaged<EventTapController>.fromOpaque(userInfo).takeUnretainedValue()
    return controller.handle(type: type, event: event)
}
