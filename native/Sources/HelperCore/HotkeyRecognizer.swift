/// Turns raw keyboard events into protocol `hotkey` actions.
///
/// Pure and CoreGraphics-free so the whole matrix is unit-testable without a
/// windowserver, an event tap or an Accessibility grant — this file is where
/// the "hold Fn" semantics actually live, and it is the part most likely to be
/// wrong in a way no compiler catches.
///
/// : Fn is not a regular key. It surfaces as the modifier flag
/// `kCGEventFlagMaskSecondaryFn` inside `.flagsChanged` events — bit set is
/// Fn-down, bit cleared is Fn-up — and Fn+Space falls out of the same tap
/// because Space then arrives as an ordinary `keyDown` carrying that flag.
///
/// Why `.flagsChanged` and not the flag on any keyDown: Apple keyboards set the
/// SecondaryFn bit on the arrow keys, Home/End/PageUp/PageDown and the function
/// row *without* Fn being physically held. Those produce no `.flagsChanged`
/// event, so reading the transition from `.flagsChanged` alone is what keeps an
/// arrow key from being reported as a push-to-talk press.

import Foundation

/// Mirrors the `CGEventFlags` bits this helper cares about. Redeclared rather
/// than imported so `HelperCore` stays free of CoreGraphics; the executable
/// target maps one to the other, and a test asserts the raw values match.
public struct ModifierFlags: OptionSet, Sendable, Equatable {
    public let rawValue: UInt64
    public init(rawValue: UInt64) { self.rawValue = rawValue }

    public static let capsLock = ModifierFlags(rawValue: 0x0001_0000)
    public static let shift = ModifierFlags(rawValue: 0x0002_0000)
    public static let control = ModifierFlags(rawValue: 0x0004_0000)
    public static let option = ModifierFlags(rawValue: 0x0008_0000)
    public static let command = ModifierFlags(rawValue: 0x0010_0000)
    public static let numericPad = ModifierFlags(rawValue: 0x0020_0000)
    public static let help = ModifierFlags(rawValue: 0x0040_0000)
    public static let secondaryFn = ModifierFlags(rawValue: 0x0080_0000)

    /// The four modifiers a chord may specify. Caps Lock, the numeric-pad bit
    /// and Fn are excluded on purpose: they ride along on ordinary keystrokes
    /// and would make an exact-match chord test fail at random.
    public static let chordMask: ModifierFlags = [.shift, .control, .option, .command]
}

/// Virtual key codes. **Positional, not layout-dependent** — 
/// On the user's QWERTZ layout V sits in the same physical position as on
/// QWERTY, so a hardcoded code is correct here; assumption 10.6 and §5.5
/// record that layout resolution is deliberately out of scope for a
/// single-user v1. On Dvorak this code would be the wrong physical key.
public enum VirtualKey {
    public static let space = 49  // kVK_Space
    public static let v = 9  // kVK_ANSI_V
}

public struct KeyboardEvent: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case flagsChanged
        case keyDown
        case keyUp
    }

    public let kind: Kind
    public let keyCode: Int
    public let flags: ModifierFlags
    public let isAutorepeat: Bool
    public let timestampMs: Int

    public init(
        kind: Kind,
        keyCode: Int,
        flags: ModifierFlags,
        isAutorepeat: Bool = false,
        timestampMs: Int = 0
    ) {
        self.kind = kind
        self.keyCode = keyCode
        self.flags = flags
        self.isAutorepeat = isAutorepeat
        self.timestampMs = timestampMs
    }
}

public struct RecognizerDecision: Sendable, Equatable {
    public let actions: [HotkeyAction]
    /// `true` → the tap callback returns `nil` and the event never reaches the
    /// focused application.
    public let consumeEvent: Bool

    public static let pass = RecognizerDecision(actions: [], consumeEvent: false)
}

public final class HotkeyRecognizer {
    public private(set) var configuration: HotkeyConfiguration
    private var fnIsDown = false
    /// Key codes whose `keyDown` this recogniser swallowed, so the matching
    /// `keyUp` is swallowed too. Needed because the user routinely lets go of
    /// the modifier first: releasing Fn before Space means the Space `keyUp`
    /// arrives *without* the SecondaryFn flag, and forwarding it would hand the
    /// focused app a key-up with no key-down.
    private var swallowedKeyDowns = Set<Int>()

    public init(configuration: HotkeyConfiguration = .default) {
        self.configuration = configuration
    }

    public func setConfiguration(_ configuration: HotkeyConfiguration) {
        self.configuration = configuration
    }

    /// Forget every latch. Called when the tap is rebuilt, because events that
    /// happened while the tap was down were never seen: without this, an Fn
    /// released during the gap leaves `fnIsDown` stuck true and the next press
    /// emits nothing.
    public func reset() {
        fnIsDown = false
        swallowedKeyDowns.removeAll()
    }

    public var isPushToTalkHeld: Bool { fnIsDown }

    public func handle(_ event: KeyboardEvent) -> RecognizerDecision {
        switch event.kind {
        case .flagsChanged:
            return handleFlagsChanged(event)
        case .keyDown:
            return handleKeyDown(event)
        case .keyUp:
            return handleKeyUp(event)
        }
    }

    private func handleFlagsChanged(_ event: KeyboardEvent) -> RecognizerDecision {
        let isDown = event.flags.contains(.secondaryFn)
        guard isDown != fnIsDown else { return .pass }
        fnIsDown = isDown

        // Track the Fn state regardless of the binding — `fn+space` needs it
        // too — but only report push-to-talk when Fn is actually bound to it.
        guard configuration.ptt == .fn else { return .pass }

        // Never consumed. Swallowing `.flagsChanged` would hide a modifier
        // transition from every other application on the system, and Fn alone
        // is already inert once System Settings → Keyboard → "Press 🌐 key to"
        // is set to "Do Nothing".
        return RecognizerDecision(actions: [isDown ? .pttDown : .pttUp], consumeEvent: false)
    }

    private func handleKeyDown(_ event: KeyboardEvent) -> RecognizerDecision {
        if configuration.toggle == .fnSpace,
            event.keyCode == VirtualKey.space,
            event.flags.contains(.secondaryFn)
        {
            swallowedKeyDowns.insert(event.keyCode)
            // Autorepeat still gets swallowed — otherwise holding Fn+Space
            // sprays spaces into the target app — but it emits nothing, or one
            // long press would flip hands-free mode dozens of times.
            return RecognizerDecision(
                actions: event.isAutorepeat ? [] : [.toggle],
                consumeEvent: true
            )
        }

        if configuration.retry == .ctrlCmdV,
            event.keyCode == VirtualKey.v,
            event.flags.intersection(.chordMask) == [.control, .command]
        {
            swallowedKeyDowns.insert(event.keyCode)
            return RecognizerDecision(
                actions: event.isAutorepeat ? [] : [.retryInsert],
                consumeEvent: true
            )
        }

        return .pass
    }

    private func handleKeyUp(_ event: KeyboardEvent) -> RecognizerDecision {
        guard swallowedKeyDowns.contains(event.keyCode) else { return .pass }
        swallowedKeyDowns.remove(event.keyCode)
        return RecognizerDecision(actions: [], consumeEvent: true)
    }
}
