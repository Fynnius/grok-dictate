import Testing

@testable import HelperCore

@Suite("Hotkey bindings")
struct HotkeyBindingsTests {
    @Test("the canonical spellings parse")
    func canonicalSpellings() {
        #expect(HotkeyBinding.parse("fn") == .fn)
        #expect(HotkeyBinding.parse("fn+space") == .fnSpace)
        #expect(HotkeyBinding.parse("ctrl+cmd+v") == .ctrlCmdV)
    }

    @Test("case and token order are tolerated")
    func tolerantParsing() {
        #expect(HotkeyBinding.parse("Fn+Space") == .fnSpace)
        #expect(HotkeyBinding.parse("cmd+ctrl+v") == .ctrlCmdV)
        #expect(HotkeyBinding.parse(" ctrl + cmd + v ") == .ctrlCmdV)
    }

    @Test(
        "anything else is rejected",
        arguments: ["", "  ", "f13", "cmd+v", "ctrl+v", "fn+f5", "option+space", "ctrl+cmd+shift+v"]
    )
    func rejectsUnknown(raw: String) {
        #expect(HotkeyBinding.parse(raw) == nil)
    }

    @Test("the defaults match contracts/config.ts")
    func defaults() {
        #expect(HotkeyConfiguration.default.ptt == .fn)
        #expect(HotkeyConfiguration.default.toggle == .fnSpace)
        #expect(HotkeyConfiguration.default.retry == .ctrlCmdV)
    }

    @Test("a valid set_hotkeys applies with no warnings")
    func applyValid() {
        var configuration = HotkeyConfiguration.default
        let warnings = configuration.apply(ptt: "fn", toggle: "fn+space", retry: "ctrl+cmd+v")
        #expect(warnings.isEmpty)
        #expect(configuration == .default)
    }

    @Test("an unrecognised binding warns and keeps the previous value")
    func applyInvalidKeepsPrevious() {
        // Contract §3: "an unrecognised binding must be reported via `log` at
        // `warn` and the previous binding kept, never silently ignored."
        var configuration = HotkeyConfiguration.default
        let warnings = configuration.apply(ptt: "f13", toggle: "fn+space", retry: "ctrl+cmd+v")
        #expect(warnings.count == 1)
        #expect(warnings[0].contains("f13"))
        #expect(warnings[0].contains("fn"))
        #expect(configuration.ptt == .fn)
    }

    @Test("one bad slot does not discard the other two")
    func slotsAreIndependent() {
        var configuration = HotkeyConfiguration.default
        let warnings = configuration.apply(ptt: "nonsense", toggle: "rubbish", retry: "ctrl+cmd+v")
        #expect(warnings.count == 2)
        #expect(configuration == .default)
    }

    @Test("a binding valid for another slot is still refused")
    func slotMismatch() {
        // "fn+space" parses, but a chord cannot express a press-and-hold, so it
        // is not a legal push-to-talk binding.
        var configuration = HotkeyConfiguration.default
        let warnings = configuration.apply(ptt: "fn+space", toggle: "fn+space", retry: "ctrl+cmd+v")
        #expect(warnings.count == 1)
        #expect(configuration.ptt == .fn)
    }
}
