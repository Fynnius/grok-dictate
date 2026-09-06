/// Wait for physically-held modifiers to leave the keyboard before posting
/// synthetic events.
///
/// Lifted out of `UnicodeInserter` unchanged when the paste tier arrived,
/// because both tiers need it and for the same reason: the retry hotkey is
/// Ctrl+Cmd+V, so at the moment a retry insertion starts, Ctrl and Cmd are
/// almost always still down. Some applications read `NSEvent.modifierFlags`
/// (global hardware state) rather than the flags on the event they were handed,
/// so an injected `a` becomes ⌘A "select all" and every subsequent character
/// replaces the selection.
///
/// The paste tier inherits the problem in a sharper form. Its chord *is* ⌘V, and
/// a stray Control still held from the retry hotkey turns it into ⌃⌘V — which is
/// the retry hotkey again, not paste. Clearing the flags on our own event is not
/// enough when the target reads hardware state.
///
/// Waiting a few tens of milliseconds for the user's fingers to leave the keys
/// costs nothing perceptible and removes the whole class of misfire.

import CoreGraphics
import Foundation
import HelperCore

enum ModifierSettle {
    /// Poll until no chord modifier is physically held, or the timeout expires.
    ///
    /// Fn is deliberately not waited on: the state machine queues a `ptt_down`
    /// that arrives while inserting rather than dropping it
    /// (`contracts/state-machine.md` §5), so the user legitimately holds Fn
    /// during an insert — and Fn alone triggers nothing in the target app.
    static func wait(timeout: TimeInterval, log: (LogLevel, String) -> Void) {
        guard timeout > 0 else { return }
        let step: TimeInterval = 0.01
        var waited: TimeInterval = 0
        while waited < timeout, heldChordModifiers().isEmpty == false {
            Thread.sleep(forTimeInterval: step)
            waited += step
        }
        let stillHeld = heldChordModifiers()
        if !stillHeld.isEmpty {
            log(
                .warn,
                "inserting while \(stillHeld.joined(separator: "+")) is still held — "
                    + "if characters come out as shortcuts, let go of the keys sooner"
            )
        } else if waited > 0 {
            log(.info, "waited \(Int(waited * 1000)) ms for held modifiers to clear before inserting")
        }
    }

    static func heldChordModifiers() -> [String] {
        let flags = CGEventSource.flagsState(.combinedSessionState)
        var held: [String] = []
        if flags.contains(.maskShift) { held.append("Shift") }
        if flags.contains(.maskControl) { held.append("Control") }
        if flags.contains(.maskAlternate) { held.append("Option") }
        if flags.contains(.maskCommand) { held.append("Command") }
        return held
    }
}
