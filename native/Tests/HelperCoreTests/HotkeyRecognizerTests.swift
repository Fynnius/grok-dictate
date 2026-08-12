/// The Fn semantics, exhaustively.
///
/// This is the file that stands in for "press the key and see". 
/// determined the mechanism but nothing in the project has ever executed it;
/// assumption 10.9 ("Fn emits `kCGEventFlagMaskSecondaryFn` on this MacBook")
/// stays open until the human test, but everything *downstream* of that flag is
/// settled here.

import Testing

@testable import HelperCore

@Suite("Hotkey recognition")
struct HotkeyRecognizerTests {
    private func flagsChanged(fn: Bool) -> KeyboardEvent {
        KeyboardEvent(kind: .flagsChanged, keyCode: 63, flags: fn ? [.secondaryFn] : [])
    }

    @Test("Fn down then up is one ptt_down and one ptt_up")
    func pushToTalk() {
        let recognizer = HotkeyRecognizer()
        let down = recognizer.handle(flagsChanged(fn: true))
        #expect(down.actions == [.pttDown])
        #expect(down.consumeEvent == false)

        let up = recognizer.handle(flagsChanged(fn: false))
        #expect(up.actions == [.pttUp])
        #expect(up.consumeEvent == false)
    }

    @Test("a flagsChanged that does not move the Fn bit emits nothing")
    func otherModifiersDoNotFire() {
        let recognizer = HotkeyRecognizer()
        // Pressing Shift produces a flagsChanged too. It must not read as PTT.
        #expect(recognizer.handle(KeyboardEvent(kind: .flagsChanged, keyCode: 56, flags: [.shift])).actions.isEmpty)
        #expect(recognizer.handle(KeyboardEvent(kind: .flagsChanged, keyCode: 55, flags: [.command])).actions.isEmpty)
        #expect(recognizer.handle(flagsChanged(fn: true)).actions == [.pttDown])
        // Shift pressed *while* Fn is held keeps the Fn bit set — no repeat.
        #expect(
            recognizer.handle(
                KeyboardEvent(kind: .flagsChanged, keyCode: 56, flags: [.secondaryFn, .shift])
            ).actions.isEmpty
        )
    }

    @Test("an arrow key carrying the Fn bit is not a push-to-talk press")
    func arrowKeysDoNotFire() {
        // Apple keyboards set the SecondaryFn bit on the arrow keys, Home/End,
        // Page Up/Down and the function row *without* Fn being held. Those
        // arrive as keyDown, not flagsChanged, so the transition is read from flagsChanged.
        let recognizer = HotkeyRecognizer()
        let leftArrow = KeyboardEvent(kind: .keyDown, keyCode: 123, flags: [.secondaryFn])
        #expect(recognizer.handle(leftArrow) == .pass)
        #expect(recognizer.isPushToTalkHeld == false)
    }

    @Test("Fn+Space emits toggle and is swallowed")
    func fnSpaceToggle() {
        let recognizer = HotkeyRecognizer()
        _ = recognizer.handle(flagsChanged(fn: true))
        let space = recognizer.handle(
            KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.space, flags: [.secondaryFn])
        )
        #expect(space.actions == [.toggle])
        // Swallowed, or hands-free mode also types a space into the target app.
        #expect(space.consumeEvent)
    }

    @Test("Space without Fn is left alone")
    func plainSpacePassesThrough() {
        let recognizer = HotkeyRecognizer()
        #expect(
            recognizer.handle(KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.space, flags: []))
                == .pass
        )
    }

    @Test("holding Fn+Space swallows the autorepeat but toggles once")
    func autorepeatToggles() {
        let recognizer = HotkeyRecognizer()
        _ = recognizer.handle(flagsChanged(fn: true))
        let first = recognizer.handle(
            KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.space, flags: [.secondaryFn])
        )
        #expect(first.actions == [.toggle])
        for _ in 0..<5 {
            let repeated = recognizer.handle(
                KeyboardEvent(
                    kind: .keyDown,
                    keyCode: VirtualKey.space,
                    flags: [.secondaryFn],
                    isAutorepeat: true
                )
            )
            #expect(repeated.actions.isEmpty)
            #expect(repeated.consumeEvent)
        }
    }

    @Test("the matching key-up is swallowed even if the modifier went first")
    func keyUpAfterModifierRelease() {
        // The common physical case: fingers leave Fn before Space, so the Space
        // key-up arrives with no Fn bit. Forwarding it hands the focused app a
        // key-up with no key-down.
        let recognizer = HotkeyRecognizer()
        _ = recognizer.handle(flagsChanged(fn: true))
        _ = recognizer.handle(
            KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.space, flags: [.secondaryFn])
        )
        _ = recognizer.handle(flagsChanged(fn: false))
        let up = recognizer.handle(KeyboardEvent(kind: .keyUp, keyCode: VirtualKey.space, flags: []))
        #expect(up.consumeEvent)
        #expect(up.actions.isEmpty)
    }

    @Test("an unmatched key-up is forwarded")
    func unmatchedKeyUpPassesThrough() {
        let recognizer = HotkeyRecognizer()
        #expect(
            recognizer.handle(KeyboardEvent(kind: .keyUp, keyCode: VirtualKey.space, flags: []))
                == .pass
        )
    }

    @Test("Ctrl+Cmd+V emits retry_insert and is swallowed")
    func retryInsert() {
        let recognizer = HotkeyRecognizer()
        let decision = recognizer.handle(
            KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.v, flags: [.control, .command])
        )
        #expect(decision.actions == [.retryInsert])
        #expect(decision.consumeEvent)
    }

    @Test(
        "near misses on the retry chord are forwarded",
        arguments: [
            ModifierFlags([.command]),
            ModifierFlags([.control]),
            ModifierFlags([.control, .command, .shift]),
            ModifierFlags([.control, .command, .option]),
            ModifierFlags([]),
        ]
    )
    func retryChordIsExact(flags: ModifierFlags) {
        let recognizer = HotkeyRecognizer()
        let decision = recognizer.handle(
            KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.v, flags: flags)
        )
        #expect(decision == .pass)
    }

    @Test("Caps Lock and the Fn bit do not break the retry chord")
    func retryChordIgnoresRiders() {
        // Caps Lock, the numeric-pad bit and Fn ride along on ordinary
        // keystrokes; an exact-match test over all flags would fail at random.
        let recognizer = HotkeyRecognizer()
        let decision = recognizer.handle(
            KeyboardEvent(
                kind: .keyDown,
                keyCode: VirtualKey.v,
                flags: [.control, .command, .capsLock, .secondaryFn, .numericPad]
            )
        )
        #expect(decision.actions == [.retryInsert])
    }

    @Test("Fn+Space during a hold still reports the surrounding ptt_down/ptt_up")
    func toggleDuringHoldReportsVerbatim() {
        // Contract §2: "Fn/Fn+Space disambiguation is the app's problem, not the
        // helper's. The helper reports both `ptt_down` and a subsequent
        // `toggle` verbatim."
        let recognizer = HotkeyRecognizer()
        var actions: [HotkeyAction] = []
        actions += recognizer.handle(flagsChanged(fn: true)).actions
        actions += recognizer.handle(
            KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.space, flags: [.secondaryFn])
        ).actions
        actions += recognizer.handle(
            KeyboardEvent(kind: .keyUp, keyCode: VirtualKey.space, flags: [.secondaryFn])
        ).actions
        actions += recognizer.handle(flagsChanged(fn: false)).actions
        #expect(actions == [.pttDown, .toggle, .pttUp])
    }

    @Test("reset clears a stuck Fn so the next press is seen")
    func resetClearsLatch() {
        // Events that happen while the tap is disabled are never delivered. If
        // Fn is released during that window, `fnIsDown` would stay true for ever
        // and push-to-talk would be dead until a restart — a silent failure
        // inside the recovery from another silent failure.
        let recognizer = HotkeyRecognizer()
        #expect(recognizer.handle(flagsChanged(fn: true)).actions == [.pttDown])
        recognizer.reset()
        #expect(recognizer.handle(flagsChanged(fn: true)).actions == [.pttDown])
    }

    @Test("reset clears a pending swallowed key-up")
    func resetClearsSwallowedKeys() {
        let recognizer = HotkeyRecognizer()
        _ = recognizer.handle(flagsChanged(fn: true))
        _ = recognizer.handle(
            KeyboardEvent(kind: .keyDown, keyCode: VirtualKey.space, flags: [.secondaryFn])
        )
        recognizer.reset()
        #expect(
            recognizer.handle(KeyboardEvent(kind: .keyUp, keyCode: VirtualKey.space, flags: []))
                == .pass
        )
    }

    @Test("the ModifierFlags raw values match CGEventFlags")
    func flagRawValues() {
        // HelperCore redeclares these so it stays free of CoreGraphics; if the
        // two ever drift, every hotkey silently stops matching.
        #expect(ModifierFlags.capsLock.rawValue == 0x0001_0000)
        #expect(ModifierFlags.shift.rawValue == 0x0002_0000)
        #expect(ModifierFlags.control.rawValue == 0x0004_0000)
        #expect(ModifierFlags.option.rawValue == 0x0008_0000)
        #expect(ModifierFlags.command.rawValue == 0x0010_0000)
        #expect(ModifierFlags.numericPad.rawValue == 0x0020_0000)
        #expect(ModifierFlags.help.rawValue == 0x0040_0000)
        // kCGEventFlagMaskSecondaryFn — the one the whole design rests on.
        #expect(ModifierFlags.secondaryFn.rawValue == 0x0080_0000)
        #expect(VirtualKey.space == 49)
        #expect(VirtualKey.v == 9)
    }
}
