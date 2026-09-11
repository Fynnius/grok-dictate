import Foundation
import Testing

@testable import CaptureCore

@Suite("Capture protocol")
struct CaptureProtocolTests {
    @Test("decodes start, stop and cancel")
    func decodesCommands() {
        let start = CaptureCommandDecoder.decode(
            line: #"{"type":"start","sessionId":"s1","sampleRate":16000,"chunkBytes":3200}"#
        )
        #expect(start == .command(.start(sessionId: "s1", sampleRate: 16_000, chunkBytes: 3200)))

        let stop = CaptureCommandDecoder.decode(line: #"{"type":"stop","sessionId":"s1"}"#)
        #expect(stop == .command(.stop(sessionId: "s1")))

        let cancel = CaptureCommandDecoder.decode(line: #"{"type":"cancel","sessionId":"s1"}"#)
        #expect(cancel == .command(.cancel(sessionId: "s1")))
    }

    @Test("unknown types and malformed lines are values, not traps")
    func unknownAndMalformed() {
        #expect(CaptureCommandDecoder.decode(line: #"{"type":"from_the_future"}"#) == .unknownType("from_the_future"))
        #expect(CaptureCommandDecoder.decode(line: "this is not json") == .malformed(reason: "not JSON"))
        #expect(CaptureCommandDecoder.decode(line: "[1,2,3]") == .malformed(reason: "top-level value is not a JSON object"))
        #expect(CaptureCommandDecoder.decode(line: "") == .malformed(reason: "empty line"))
        #expect(
            CaptureCommandDecoder.decode(line: #"{"type":"start","sessionId":"s1"}"#)
                == .malformed(reason: "start is missing a positive sampleRate")
        )
    }

    @Test("unknown fields on a known type are ignored")
    func unknownFields() {
        let decoded = CaptureCommandDecoder.decode(
            line: #"{"type":"stop","sessionId":"s1","micProcessing":true,"extra":[1]}"#
        )
        #expect(decoded == .command(.stop(sessionId: "s1")))
    }

    @Test("started encodes with a trailing newline and no embedded newline")
    func startedEncoding() throws {
        let line = CaptureFrame.started(sessionId: "s1", actualSampleRate: 16_000).encoded()
        #expect(line.hasSuffix("\n"))
        #expect(line.dropLast().contains("\n") == false)
        let object = try decode(line)
        #expect(object["type"] as? String == "started")
        #expect(object["sessionId"] as? String == "s1")
        #expect(object["actualSampleRate"] as? Int == 16_000)
    }

    @Test("chunk round-trips PCM as base64")
    func chunkEncoding() throws {
        let pcm = Data([0x00, 0x80, 0xFF, 0x7F])
        let line = CaptureFrame.chunk(sessionId: "s1", pcm: pcm).encoded()
        let object = try decode(line)
        #expect(object["type"] as? String == "chunk")
        let encoded = try #require(object["pcm"] as? String)
        #expect(Data(base64Encoded: encoded) == pcm)
        #expect(encoded.contains("\n") == false)
    }

    @Test("error carries a machine code and a hint")
    func errorEncoding() throws {
        let line = CaptureFrame.error(
            sessionId: "s1",
            code: .audioPermission,
            message: "not allowed",
            hint: "grant it"
        ).encoded()
        let object = try decode(line)
        #expect(object["code"] as? String == "audio_permission")
        #expect(object["message"] as? String == "not allowed")
        #expect(object["hint"] as? String == "grant it")
    }

    @Test("level is clamped to 0...1")
    func levelClamped() throws {
        let high = try decode(CaptureFrame.level(sessionId: "s1", level: 4).encoded())
        #expect((high["level"] as? NSNumber)?.doubleValue == 1)
        let nan = try decode(CaptureFrame.level(sessionId: "s1", level: .nan).encoded())
        #expect((nan["level"] as? NSNumber)?.doubleValue == 0)
    }

    private func decode(_ line: String) throws -> [String: Any] {
        let data = try #require(line.data(using: .utf8))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
