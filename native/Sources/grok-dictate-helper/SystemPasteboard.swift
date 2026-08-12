/// The only file in this package that mentions `NSPasteboard`.
///
/// `ClipboardContainmentTests` asserts that by scanning the sources, so this
/// comment is enforced rather than aspirational. : the clipboard
/// tier was removed from the insertion ladder entirely at the user's request,
/// and the pasteboard is written only on an explicit click of *Copy*. That
/// arrives as the `copy` command, which `CommandRouter` is the sole caller of.
///
/// Note what is *not* here: no read, no save-and-restore, no multi-format
/// handling. Contract §5 — "No clipboard read. Nothing in this protocol can
/// read the pasteboard, by design." That also sidesteps every failure mode in
///  (lossy restore, promised data, restore-timing races).

import AppKit
import HelperCore

final class SystemPasteboard: PasteboardWriting {
    func write(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}
