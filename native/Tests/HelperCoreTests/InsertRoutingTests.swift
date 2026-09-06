/// Which rung gets the text, and what it costs to decide.
///
/// The rules are cheap to state and expensive to get wrong: rule 2 decides
/// roughly half of this user's traffic, and rule 3 is the only one that pays for
/// an AX round trip into another process.

import Testing

@testable import HelperCore

@Suite("Insert routing")
struct InsertRoutingTests {
    /// A focus probe that fails the test if it is consulted. Rule 3 is the only
    /// rule with a cost, so "was it asked?" is part of the behaviour.
    private func neverAsked() -> () -> FocusSignature {
        { Issue.record("the routing read the focused element when it did not need to"); return .unknown }
    }

    private let terminal = FocusSignature(selectedTextIsSettable: false, characterCount: 0)
    private let textField = FocusSignature(selectedTextIsSettable: true, characterCount: 0)

    @Test("an explicit preference wins outright, without asking anything")
    func overrideWins() {
        // The escape hatch that replaced four environment variables. It must not
        // be second-guessed by length or by what the focused element looks like:
        // a user who chose `type` is often choosing it *because* the automatic
        // answer was wrong for them.
        #expect(
            InsertRouting.route(preference: .paste, utf16Count: 1, focus: neverAsked()) == .paste)
        #expect(
            InsertRouting.route(preference: .type, utf16Count: 10_000, focus: neverAsked())
                == .type)
    }

    @Test("long text pastes without an AX round trip")
    func lengthShortCircuits() {
        // The common case the tier was built for — 39 % of dictations are over
        // 200 characters — and the one where the round trip would be pure cost.
        #expect(
            InsertRouting.route(preference: .auto, utf16Count: 121, focus: neverAsked()) == .paste)
    }

    @Test("the threshold is exclusive, so short text still asks")
    func thresholdBoundary() {
        var asked = 0
        let probe: () -> FocusSignature = {
            asked += 1
            return self.textField
        }
        #expect(InsertRouting.route(preference: .auto, utf16Count: 120, focus: probe) == .type)
        #expect(asked == 1)
    }

    @Test("a short dictation into a text field types, and leaves the clipboard alone")
    func shortTextTypes() {
        #expect(
            InsertRouting.route(preference: .auto, utf16Count: 20, focus: { textField }) == .type)
    }

    @Test("the xterm.js signature pastes even when the text is short")
    func terminalSignaturePastes() {
        // `settable: false` *and* zero characters. A terminal emulator's AX text
        // area is its screen buffer, and xterm.js does not expose the buffer at
        // all — so it reports zero whether or not the screen is full. Injected
        // keys go into it and disappear.
        #expect(
            InsertRouting.route(preference: .auto, utf16Count: 20, focus: { terminal }) == .paste)
    }

    @Test("neither half of the signature is enough on its own")
    func signatureNeedsBothHalves() {
        // Terminal.app reports `settable: false` and types perfectly well, so
        // that half alone would route half the world to the clipboard. And an
        // ordinary empty text field reports zero characters.
        let notSettableWithContent = FocusSignature(
            selectedTextIsSettable: false, characterCount: 400)
        #expect(
            InsertRouting.route(preference: .auto, utf16Count: 20, focus: { notSettableWithContent })
                == .type
        )
        #expect(
            InsertRouting.route(preference: .auto, utf16Count: 20, focus: { textField }) == .type)
    }

    @Test("knowing nothing types, because typing never touches the clipboard")
    func unknownSignatureTypes() {
        // No Accessibility grant, no focused element, a dry run. Every one of
        // them lands here, and the conservative answer is the one that changes
        // nothing about the user's machine.
        #expect(
            InsertRouting.route(preference: .auto, utf16Count: 20, focus: { .unknown }) == .type)
        #expect(
            InsertRouting.route(
                preference: .auto,
                utf16Count: 20,
                focus: { FocusSignature(selectedTextIsSettable: nil, characterCount: 0) }
            ) == .type
        )
    }

    @Test("settable false with an unreadable count pastes")
    func unreadableCountPastes() {
        // The swallow shape we could not confirm: AX returns CFNumber, the old
        // `as? Int` often failed, characterCount was nil, isTerminalTextView
        // was false, and short cmux dictations typed and got swallowed. Failing
        // toward paste is conservative for not losing text.
        let unreadable = FocusSignature(selectedTextIsSettable: false, characterCount: nil)
        #expect(
            InsertRouting.route(preference: .auto, utf16Count: 20, focus: { unreadable }) == .paste)
    }

    @Test("an absent or unrecognised wire value reads as auto")
    func wireValues() {
        // An older app sends no route at all and must get the shipping default.
        #expect(InsertRoutePreference(wireValue: nil) == .auto)
        #expect(InsertRoutePreference(wireValue: "paste") == .paste)
        #expect(InsertRoutePreference(wireValue: "type") == .type)
        // A value from the future never reaches here — `CommandDecoder` rejects
        // the frame rather than coercing it, because coercing could paste when
        // the user asked us not to. This is the belt to that pair of braces.
        #expect(InsertRoutePreference(wireValue: "telepathy") == .auto)
    }
}
