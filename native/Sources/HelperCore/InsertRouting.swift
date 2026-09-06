/// Which rung of the ladder gets the text.
///
/// A pure function, because choosing the route is a *decision* and every
/// decision in this helper is testable without a windowserver. The alternative —
/// an `if` in the middle of `InsertionLadder.run` — is how the two rules below
/// would drift apart from the reasons they exist.
///
/// **There is deliberately no bundle-id table.** A list of the applications
/// somebody happened to test is exactly what `AXSelectedTextGate`'s comment
/// argues against at length, and the argument has not changed: a rule derived
/// from what an application *does* protects applications nobody has tried.
/// `GROK_DICTATE_AX_SKIP` was the escape hatch for the same problem and it was
/// never used once.

import Foundation

/// What the user asked for, from `insert.route` (contract §3).
public enum InsertRoutePreference: String, Sendable, Equatable {
    /// Let the helper choose. The shipping default.
    case auto
    /// Always paste. Fast everywhere ⌘V works, replaces the clipboard.
    case paste
    /// Never touch the pasteboard. Exactly the pre-2026-09-06 behaviour.
    case type

    /// `nil` and an unrecognised value both mean `auto`.
    ///
    /// An older app sends no `route` at all and must get the behaviour a user
    /// who has not touched the setting gets. An app from the *future* naming a
    /// route this build cannot perform is a different case and is rejected one
    /// level up, in the decoder — silently downgrading it could paste when the
    /// user asked not to.
    public init(wireValue: String?) {
        self = wireValue.flatMap(InsertRoutePreference.init(rawValue:)) ?? .auto
    }
}

/// The route actually taken.
public enum InsertRoute: Sendable, Equatable {
    /// Publish a promise, post ⌘V, fall through to injection on no receipt.
    /// The AX tier is skipped entirely.
    case paste
    /// AX first, then Unicode injection. The pasteboard is not touched.
    case type
}

/// What one AX round trip can say about the focused element.
///
/// Both fields are optional because both queries can fail, and "the query
/// failed" is not the same claim as "the answer is no" — the distinction is the
/// whole of `AXSelectedTextGate` and it applies here for the same reason.
public struct FocusSignature: Sendable, Equatable {
    /// `AXUIElementIsAttributeSettable(kAXSelectedTextAttribute)`. `nil` when
    /// the check itself errored.
    public let selectedTextIsSettable: Bool?
    /// `kAXNumberOfCharacters`. `nil` when unreadable.
    public let characterCount: Int?

    public init(selectedTextIsSettable: Bool?, characterCount: Int?) {
        self.selectedTextIsSettable = selectedTextIsSettable
        self.characterCount = characterCount
    }

    /// Nothing could be learned — no focused element, no Accessibility grant, a
    /// tier that does not implement the probe.
    public static let unknown = FocusSignature(
        selectedTextIsSettable: nil, characterCount: nil)

    /// The xterm.js shape: an element that says its selected text cannot be set
    /// **and** that it contains no characters at all.
    ///
    /// A terminal emulator's AX text area is its *screen buffer*, not the
    /// shell's input line, and xterm.js does not expose the buffer at all — so
    /// it reports zero characters whether or not the screen is full. That pair
    /// is a shape no ordinary text field has: a real empty field reports
    /// `settable: true`, and a real read-only field with content reports a
    /// non-zero count.
    ///
    /// Both halves are required. `settable == false` alone is also true of
    /// Terminal.app, which pastes and types equally well; the zero count is
    /// what identifies the element that will silently swallow injected keys.
    public var isTerminalTextView: Bool {
        selectedTextIsSettable == false && characterCount == 0
    }
}

public enum InsertRouting {
    /// Above this many UTF-16 units, `auto` pastes.
    ///
    /// **Chosen, not measured.** Espanso's `clipboard_threshold` is 100 and is
    /// the most battle-tested number in this space; 120 is the same number with
    /// a little room, and the report proposed it.
    ///
    /// It decides roughly half this user's traffic: the median transcript is
    /// 109 characters and 39 % are over 200. That is deliberate on both sides.
    /// Above it, typing costs ~0.9 ms per character and a 2,000-character
    /// dictation takes 1,785 ms. Below it, typing finishes in ~13 ms and leaves
    /// the clipboard alone, which is worth more than the milliseconds a paste
    /// would save.
    ///
    /// If it is wrong it is wrong cheaply and in a way the user can fix without
    /// a rebuild: `insertMethod` forces either route outright.
    public static let pasteAboveUTF16Units = 120

    /// Three rules, in order.
    ///
    /// `focus` is a closure and is called **at most once**, only when the first
    /// two rules have not already decided. It costs an AX round trip into
    /// another process, and long text — the common case this tier was built for
    /// — never needs it.
    public static func route(
        preference: InsertRoutePreference,
        utf16Count: Int,
        focus: () -> FocusSignature
    ) -> InsertRoute {
        switch preference {
        // Rule 1 — the user's override wins outright. This single control
        // replaces four environment variables.
        case .paste: return .paste
        case .type: return .type
        case .auto:
            // Rule 2 — length.
            if utf16Count > pasteAboveUTF16Units { return .paste }
            // Rule 3 — the shape of a terminal that will swallow injected keys.
            return focus().isTerminalTextView ? .paste : .type
        }
    }
}
