/// The one and only route to the pasteboard in this entire package.
///
/// , user turn 7: *"Is that the idea because I like that more
/// instead of it automatically pasting into my clipboard? I don't want that."*
/// The clipboard tier was dropped from the ladder entirely; the pasteboard is
/// written **only** on an explicit user click of *Copy* in the HUD or history,
/// which arrives as the `copy` command and nothing else.
///
/// The protocol lives here, alone, so that containment is checkable rather than
/// promised. `ClipboardContainmentTests` asserts that the string `NSPasteboard`
/// occurs in exactly one source file of this package (the implementation in the
/// executable target), and that a spy conforming to this protocol records zero
/// writes when every branch of the insertion ladder and every `insert` command
/// is exercised — including the failing ones, which is where a "helpful"
/// fallback would otherwise hide.
///
/// IMPLEMENTATION-PLAN.md §3.2 requires Phase 2 to prove this by test; §5b has
/// Phase 5 audit it again.

public protocol PasteboardWriting: AnyObject {
    func write(_ text: String)
}
