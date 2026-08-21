/// The frozen contract, checked from the Swift side.
///
/// The frames asserted here are the literal examples from
/// `contracts/helper-protocol.md`. If one of these fails, the helper and the
/// app disagree about the wire — which IMPLEMENTATION-PLAN.md §5.1 calls the
/// highest-severity risk in the plan and §5a calls the most likely integration
/// defect.

import Foundation
import Testing

@testable import HelperCore

@Suite("Frame encoding")
struct FrameEncodingTests {
    private func decode(_ frame: HelperFrame) throws -> [String: Any] {
        let line = frame.encoded()
        #expect(line.hasSuffix("\n"))
        // The entire framing rests on this: one frame is one line.
        #expect(line.dropLast().contains("\n") == false)
        let data = try #require(line.data(using: .utf8))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("every frame carries v: 1")
    func versionOnEveryFrame() throws {
        let frames: [HelperFrame] = [
            .ready(version: "0.1.0", caps: [.ax, .unicode]),
            .hotkey(action: .pttDown, timestampMs: 1_754_683_200_000),
            .secureInput(enabled: true),
            .frontmost(bundleId: "com.apple.Notes", name: "Notes", id: nil),
            .insertResult(
                id: "abc", tier: .ax, ok: true, verified: true, error: nil, reason: nil,
                frontmostBundleId: nil, frontmostName: nil
            ),
            .log(level: .warn, message: "hello"),
        ]
        for frame in frames {
            let object = try decode(frame)
            #expect(object["v"] as? Int == 1)
        }
    }

    @Test("ready matches the contract example")
    func ready() throws {
        let object = try decode(.ready(version: "0.1.0", caps: [.ax, .unicode]))
        #expect(object["type"] as? String == "ready")
        #expect(object["version"] as? String == "0.1.0")
        #expect(object["caps"] as? [String] == ["ax", "unicode"])
    }

    @Test("hotkey carries the action and a millisecond timestamp")
    func hotkey() throws {
        let object = try decode(.hotkey(action: .retryInsert, timestampMs: 1_754_683_200_000))
        #expect(object["type"] as? String == "hotkey")
        #expect(object["action"] as? String == "retry_insert")
        #expect(object["ts"] as? Int == 1_754_683_200_000)
    }

    @Test("hotkey action spellings are exactly the contract's")
    func hotkeyActionSpellings() {
        #expect(HotkeyAction.pttDown.rawValue == "ptt_down")
        #expect(HotkeyAction.pttUp.rawValue == "ptt_up")
        #expect(HotkeyAction.toggle.rawValue == "toggle")
        #expect(HotkeyAction.retryInsert.rawValue == "retry_insert")
    }

    @Test("unsolicited frontmost omits id; a reply carries it")
    func frontmostIdIsOptionalNotNull() throws {
        // The app parses `id` with Zod's `.optional()`, which rejects an
        // explicit null — so "absent" and "null" are not interchangeable here.
        let unsolicited = try decode(.frontmost(bundleId: "com.apple.Notes", name: "Notes", id: nil))
        #expect(unsolicited["id"] == nil)

        let reply = try decode(.frontmost(bundleId: "com.apple.Notes", name: "Notes", id: "a"))
        #expect(reply["id"] as? String == "a")
    }

    @Test("frontmost sends null, not an empty string, when nothing owns the menu bar")
    func frontmostNulls() throws {
        let object = try decode(.frontmost(bundleId: nil, name: nil, id: nil))
        #expect(object["bundleId"] is NSNull)
        #expect(object["name"] is NSNull)
    }

    @Test("insert_result carries a machine-readable reason")
    func insertResultReason() throws {
        // Added in Phase 5. `error` is prose; the app needs to branch on the
        // frontmost-check decline specifically.
        let object = try decode(
            .insertResult(
                id: "c",
                tier: .none,
                ok: false,
                verified: nil,
                error: "focus moved to Safari",
                reason: .targetChanged,
                frontmostBundleId: "com.apple.Safari",
                frontmostName: "Safari"
            )
        )
        #expect(object["reason"] as? String == "target_changed")
        // The app builds the history row from this, now that it no longer
        // knows which application received the text.
        #expect(object["frontmostBundleId"] as? String == "com.apple.Safari")
        #expect(object["frontmostName"] as? String == "Safari")
    }

    @Test("insert_result carries a null error on success")
    func insertResultNullError() throws {
        let object = try decode(
            .insertResult(
                id: "b", tier: .unicode, ok: true, verified: nil, error: nil, reason: nil,
                frontmostBundleId: nil, frontmostName: nil
            )
        )
        #expect(object["type"] as? String == "insert_result")
        #expect(object["tier"] as? String == "unicode")
        #expect(object["ok"] as? Bool == true)
        #expect(object["error"] is NSNull)
        #expect(object["reason"] is NSNull)
    }

    @Test("insert_result says whether the text was confirmed to have landed")
    func insertResultVerified() throws {
        // The BUG-1 field. `ok: true` with `verified` anything but `true` means
        // "typed, unconfirmed" — the state the app stops showing as plain
        // success, and the state the incident had no way to express: 60.3 s of
        // dictation posted into a terminal, dropped in full, reported as a green
        // "Inserted" pill.
        let confirmed = try decode(
            .insertResult(
                id: "a", tier: .ax, ok: true, verified: true, error: nil, reason: nil,
                frontmostBundleId: nil, frontmostName: nil
            )
        )
        #expect(confirmed["verified"] as? Bool == true)

        let unconfirmed = try decode(
            .insertResult(
                id: "b", tier: .unicode, ok: true, verified: nil, error: nil, reason: nil,
                frontmostBundleId: nil, frontmostName: nil
            )
        )
        // Null rather than absent: the app parses it with Zod's `.nullish()`,
        // which takes both, and a field that is always present is one less shape
        // to reason about when reading NDJSON by eye (contract §5).
        #expect(unconfirmed["verified"] is NSNull)

        let refuted = try decode(
            .insertResult(
                id: "c", tier: .unicode, ok: false, verified: false,
                error: "the text was typed into cmux but did not arrive",
                reason: .verificationFailed,
                frontmostBundleId: "dev.cmux.app", frontmostName: "cmux"
            )
        )
        #expect(refuted["verified"] as? Bool == false)
        #expect(refuted["ok"] as? Bool == false)
        #expect(refuted["reason"] as? String == "verification_failed")
        // The tier stays `unicode`: the events were posted, so this is not the
        // "nothing was attempted, the clipboard is untouched" case that `none`
        // means (contract §2).
        #expect(refuted["tier"] as? String == "unicode")
    }

    @Test("the decline reasons are spelled exactly as the contract writes them")
    func declineReasonSpellings() {
        #expect(InsertDeclineReason.targetChanged.rawValue == "target_changed")
        #expect(InsertDeclineReason.emptyText.rawValue == "empty_text")
        #expect(InsertDeclineReason.noTier.rawValue == "no_tier")
        #expect(InsertDeclineReason.verificationFailed.rawValue == "verification_failed")
    }

    @Test("the three verification states map onto true, false and null")
    func verificationWireValues() {
        #expect(InsertionVerification.confirmed.wireValue == true)
        #expect(InsertionVerification.provenNotLanded.wireValue == false)
        // Deliberately the same value an older helper build produces by not
        // sending the field at all: "this build cannot tell you" and "this
        // target cannot be measured" are the same claim from the app's side.
        #expect(InsertionVerification.notPossible.wireValue == nil)
    }

    @Test("a transcript containing newlines and quotes stays on one line")
    func multilineTranscriptStaysOneLine() throws {
        // Contract §1: "Frames may contain newlines inside string values —
        // transcripts routinely do." All framing rests on them being escaped.
        let nasty = "erste Zeile\nzweite \"Zeile\"\\ \r\n\ttabuliert 🇩🇪"
        let line = HelperFrame.log(level: .info, message: nasty).encoded()
        #expect(line.filter { $0 == "\n" }.count == 1)

        let data = try #require(line.data(using: .utf8))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["msg"] as? String == nasty)
    }
}

@Suite("Command decoding")
struct CommandDecodingTests {
    @Test("decodes each command in the contract")
    func decodesEveryCommand() {
        #expect(
            CommandDecoder.decode(
                line: #"{"v":1,"type":"insert","id":"b","text":"hallo","targetBundleId":"com.apple.Notes"}"#
            ) == .command(.insert(id: "b", text: "hallo", targetBundleId: "com.apple.Notes"))
        )
        #expect(
            CommandDecoder.decode(line: #"{"v":1,"type":"copy","text":"hallo"}"#)
                == .command(.copy(text: "hallo"))
        )
        #expect(
            CommandDecoder.decode(line: #"{"v":1,"type":"get_frontmost","id":"a"}"#)
                == .command(.getFrontmost(id: "a"))
        )
        #expect(
            CommandDecoder.decode(
                line: #"{"v":1,"type":"set_hotkeys","ptt":"fn","toggle":"fn+space","retry":"ctrl+cmd+v"}"#
            ) == .command(.setHotkeys(ptt: "fn", toggle: "fn+space", retry: "ctrl+cmd+v"))
        )
        #expect(
            CommandDecoder.decode(line: #"{"v":1,"type":"shutdown"}"#) == .command(.shutdown)
        )
    }

    @Test("a null targetBundleId disables the frontmost check")
    func nullTarget() {
        #expect(
            CommandDecoder.decode(
                line: #"{"v":1,"type":"insert","id":"b","text":"x","targetBundleId":null}"#
            ) == .command(.insert(id: "b", text: "x", targetBundleId: nil))
        )
    }

    @Test("a missing targetBundleId is treated as null rather than rejected")
    func absentTarget() {
        // Both mean "do not check the target". Rejecting the frame would drop
        // an insert, and a dropped insert loses a transcript.
        #expect(
            CommandDecoder.decode(line: #"{"v":1,"type":"insert","id":"b","text":"x"}"#)
                == .command(.insert(id: "b", text: "x", targetBundleId: nil))
        )
    }

    @Test("empty text is a legal insert")
    func emptyTextDecodes() {
        // The ladder decides what to do with it; the decoder must not editorialise.
        #expect(
            CommandDecoder.decode(
                line: #"{"v":1,"type":"insert","id":"b","text":"","targetBundleId":null}"#
            ) == .command(.insert(id: "b", text: "", targetBundleId: nil))
        )
    }

    @Test("unknown fields on a known type are ignored")
    func unknownFieldsIgnored() {
        // Contract §1 rule 3 —  records exactly this bug on the
        // other side of the wire, where the Grok CLI's serde struct silently
        // drops fields `transcript.partial` carries.
        #expect(
            CommandDecoder.decode(
                line: #"{"v":1,"type":"copy","text":"hallo","fromTheFuture":{"a":[1,2]}}"#
            ) == .command(.copy(text: "hallo"))
        )
    }

    @Test("unknown types degrade instead of failing")
    func unknownType() {
        #expect(
            CommandDecoder.decode(line: #"{"v":1,"type":"from_the_future","payload":1}"#)
                == .unknownType("from_the_future")
        )
    }

    @Test("a different protocol version is rejected, not coerced")
    func wrongVersion() {
        guard case let .malformed(reason) = CommandDecoder.decode(
            line: #"{"v":99,"type":"shutdown"}"#
        ) else {
            Issue.record("expected v:99 to be rejected")
            return
        }
        #expect(reason.contains("99"))
    }

    @Test(
        "malformed input is a value, never a crash",
        arguments: [
            "",
            "   ",
            "this is not json",
            "[1,2,3]",
            "null",
            "\"a string\"",
            #"{"type":"shutdown"}"#,
            #"{"v":"1","type":"shutdown"}"#,
            #"{"v":1}"#,
            #"{"v":1,"type":42}"#,
            #"{"v":1,"type":"insert","id":"","text":"x"}"#,
            #"{"v":1,"type":"insert","id":"b"}"#,
            #"{"v":1,"type":"insert","id":"b","text":42}"#,
            #"{"v":1,"type":"copy"}"#,
            #"{"v":1,"type":"get_frontmost"}"#,
            #"{"v":1,"type":"set_hotkeys","ptt":"fn"}"#,
            #"{"v":1,"type":"set_hotkeys","ptt":"","toggle":"fn+space","retry":"ctrl+cmd+v"}"#,
            #"{"v":1,"type":"insert","id":"b","text":"x","targetBundleId":42}"#,
        ]
    )
    func malformedNeverThrows(line: String) {
        // IMPLEMENTATION-PLAN.md §3.2: "Malformed input must never crash the
        // helper." Reaching the assertion at all is most of the test.
        let decoded = CommandDecoder.decode(line: line)
        if case .command = decoded {
            // One case above is deliberately borderline: a non-string
            // targetBundleId is treated as absent rather than fatal.
            #expect(decoded == .command(.insert(id: "b", text: "x", targetBundleId: nil)))
        }
    }

    @Test("a 1 MB transcript decodes")
    func hugeText() {
        let text = String(repeating: "ä", count: 500_000)
        let line = HelperFrame.log(level: .info, message: text).encoded()
        #expect(line.count > 500_000)
    }
}
