/// The full app→helper→app round trip, at the wire level.
///
/// Exercises the same `handle(line:)` entry point production uses, so the
/// robustness rules from contract §1 are tested where they actually live rather
/// than through a test-only shortcut.

import Testing

@testable import HelperCore

@Suite("Command routing")
struct CommandRouterTests {
    private func makeRouter(
        ax: TierAttempt = .succeeded,
        unicode: TierAttempt = .succeeded,
        frontmost bundleId: String? = "com.apple.Notes",
        name: String? = "Notes"
    ) -> (CommandRouter, FrameRecorder, SpyPasteboard) {
        let recorder = FrameRecorder()
        let pasteboard = SpyPasteboard()
        let frontmost = StubFrontmost(bundleId: bundleId, name: name)
        let router = CommandRouter(
            insertion: InsertionLadder(
                accessibility: StubAccessibilityInserter(result: ax),
                unicode: StubUnicodeInserter(result: unicode),
                frontmost: frontmost
            ),
            pasteboard: pasteboard,
            frontmost: frontmost,
            emit: recorder.emit
        )
        return (router, recorder, pasteboard)
    }

    @Test("an insert is answered by exactly one insert_result with the same id")
    func insertIsCorrelated() {
        let (router, recorder, _) = makeRouter()
        router.handle(line: #"{"v":1,"type":"insert","id":"b-42","text":"hallo","targetBundleId":null}"#)
        let results = recorder.insertResults()
        #expect(results.count == 1)
        #expect(results[0].id == "b-42")
        #expect(results[0].tier == .ax)
        #expect(results[0].ok)
        #expect(results[0].error == nil)
    }

    @Test("two inserts are answered independently and in order")
    func twoInserts() {
        let (router, recorder, _) = makeRouter()
        router.handle(line: #"{"v":1,"type":"insert","id":"one","text":"a","targetBundleId":null}"#)
        router.handle(line: #"{"v":1,"type":"insert","id":"two","text":"b","targetBundleId":null}"#)
        #expect(recorder.insertResults().map(\.id) == ["one", "two"])
    }

    @Test("get_frontmost is answered with the same id")
    func getFrontmost() {
        let (router, recorder, _) = makeRouter()
        router.handle(line: #"{"v":1,"type":"get_frontmost","id":"a"}"#)
        guard case let .frontmost(bundleId, name, id) = recorder.frames.last else {
            Issue.record("expected a frontmost frame, got \(String(describing: recorder.frames.last))")
            return
        }
        #expect(bundleId == "com.apple.Notes")
        #expect(name == "Notes")
        #expect(id == "a")
    }

    @Test("get_frontmost answers even when nothing owns the menu bar")
    func getFrontmostWithNoApp() {
        let (router, recorder, _) = makeRouter(frontmost: nil, name: nil)
        router.handle(line: #"{"v":1,"type":"get_frontmost","id":"a"}"#)
        #expect(recorder.frames.last == .frontmost(bundleId: nil, name: nil, id: "a"))
    }

    @Test("set_hotkeys applies and notifies")
    func setHotkeys() {
        let recorder = FrameRecorder()
        var applied: HotkeyConfiguration?
        let frontmost = StubFrontmost(bundleId: "com.apple.Notes")
        let router = CommandRouter(
            insertion: InsertionLadder(
                accessibility: StubAccessibilityInserter(result: .succeeded),
                unicode: StubUnicodeInserter(result: .succeeded),
                frontmost: frontmost
            ),
            pasteboard: SpyPasteboard(),
            frontmost: frontmost,
            emit: recorder.emit,
            onHotkeysChanged: { applied = $0 }
        )
        router.handle(
            line: #"{"v":1,"type":"set_hotkeys","ptt":"fn","toggle":"fn+space","retry":"ctrl+cmd+v"}"#
        )
        #expect(applied == .default)
        #expect(recorder.logMessages.isEmpty)
    }

    @Test("an unrecognised binding warns and keeps the previous value")
    func setHotkeysWarns() {
        let (router, recorder, _) = makeRouter()
        router.handle(
            line: #"{"v":1,"type":"set_hotkeys","ptt":"f13","toggle":"fn+space","retry":"ctrl+cmd+v"}"#
        )
        #expect(recorder.logMessages.count == 1)
        #expect(recorder.logMessages[0].contains("f13"))
        #expect(router.hotkeys.ptt == .fn)
    }

    @Test("shutdown produces the shutdown effect")
    func shutdown() {
        let (router, _, _) = makeRouter()
        #expect(router.handle(line: #"{"v":1,"type":"shutdown"}"#) == [.shutdown])
    }

    @Test("no other command produces an effect")
    func noStrayEffects() {
        let (router, _, _) = makeRouter()
        #expect(router.handle(line: #"{"v":1,"type":"copy","text":"x"}"#).isEmpty)
        #expect(router.handle(line: #"{"v":1,"type":"get_frontmost","id":"a"}"#).isEmpty)
        #expect(router.handle(line: "garbage").isEmpty)
    }

    @Test("an unknown type is logged and skipped")
    func unknownTypeLogged() {
        let (router, recorder, _) = makeRouter()
        router.handle(line: #"{"v":1,"type":"from_the_future","payload":1}"#)
        #expect(recorder.logMessages.count == 1)
        #expect(recorder.logMessages[0].contains("from_the_future"))
        #expect(recorder.insertResults().isEmpty)
    }

    @Test("a stream of garbage cannot stop the helper serving the next command")
    func survivesGarbage() {
        // Contract §1 rule 1, and the reason `CommandDecoder` is total: a bad
        // byte must not turn into a dead hotkey.
        let (router, recorder, _) = makeRouter()
        for line in [
            "", "   ", "not json", "[1,2,3]", "{", #"{"v":2,"type":"shutdown"}"#,
            #"{"v":1,"type":"insert"}"#, "\u{0}\u{1}\u{2}",
        ] {
            #expect(router.handle(line: line).isEmpty)
        }
        router.handle(line: #"{"v":1,"type":"insert","id":"after","text":"hallo","targetBundleId":null}"#)
        #expect(recorder.insertResults().map(\.id) == ["after"])
    }

    @Test("a failed insert still answers, with actionable text")
    func failedInsertStillAnswers() {
        // IMPLEMENTATION-PLAN.md §4: "Errors carry actionable text." A request
        // that goes unanswered is worse — the app would wait out its timeout
        // and the user would watch a transcript hang.
        let (router, recorder, _) = makeRouter(
            ax: .failed(reason: "kAXErrorAPIDisabled (-25211)"),
            unicode: .failed(reason: "could not create a private CGEventSource")
        )
        router.handle(line: #"{"v":1,"type":"insert","id":"x","text":"hallo","targetBundleId":null}"#)
        let results = recorder.insertResults()
        #expect(results.count == 1)
        #expect(results[0].tier == .none)
        #expect(results[0].ok == false)
        #expect(results[0].error?.isEmpty == false)
    }

    @Test("a moved target is declined, and the reply names the app now in front")
    func targetMovedDeclines() {
        let (router, recorder, _) = makeRouter(frontmost: "com.apple.Safari", name: "Safari")
        router.handle(
            line: #"{"v":1,"type":"insert","id":"x","text":"hallo","targetBundleId":"com.microsoft.VSCode"}"#
        )
        let results = recorder.insertResults()
        #expect(results[0].tier == .none)
        #expect(results[0].ok == false)
        #expect(results[0].error?.contains("Safari") == true)
    }
}
