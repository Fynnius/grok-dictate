/// The `copy` command's write to `NSPasteboard`.
///
/// Two files in this package mention `NSPasteboard`: this one, which is the
/// *Copy* button's explicit write, and `PasteInserter`, which publishes a
/// promised item for the paste insertion tier. `CommandRouter` is the sole
/// caller of this type; the paste tier does not go through it.
///
/// Note what is *not* here: no read, no save-and-restore, no multi-format
/// handling. Contract §5 — "No clipboard read. Nothing in this protocol can
/// read the pasteboard, by design."

import AppKit
import HelperCore

final class SystemPasteboard: PasteboardWriting {
    func write(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}
