import Foundation
import Testing

@testable import HelperCore

@Suite("NDJSON framing")
struct LineReaderTests {
    private func lines(_ results: [LineReader.Line]) -> [String] {
        results.compactMap {
            if case let .line(text) = $0 { return text }
            return nil
        }
    }

    @Test("splits a chunk containing several frames")
    func severalFrames() {
        let reader = LineReader()
        let result = reader.feed("a\nb\nc\n".utf8Bytes)
        #expect(lines(result) == ["a", "b", "c"])
    }

    @Test("holds a partial frame until its newline arrives")
    func partialFrame() {
        let reader = LineReader()
        #expect(lines(reader.feed(#"{"v":1,"type":"shut"#.utf8Bytes)).isEmpty)
        let completed = reader.feed(#"down"}"# .utf8Bytes + "\n".utf8Bytes)
        #expect(lines(completed) == [#"{"v":1,"type":"shutdown"}"#])
    }

    @Test("a multi-byte character split across two reads survives")
    func splitMultibyteCharacter() {
        // The reason this class buffers bytes rather than decoded strings.
        // "ü" is 0xC3 0xBC; the app writes UTF-8 and the pipe can split it
        // anywhere, and German transcripts make that a routine case.
        let reader = LineReader()
        let full = Array(#"{"v":1,"type":"copy","text":"über"}"#.utf8) + [UInt8(ascii: "\n")]
        let splitPoint = full.firstIndex(of: 0xC3)!
        #expect(lines(reader.feed(Array(full[..<(splitPoint + 1)]))).isEmpty)
        let rest = reader.feed(Array(full[(splitPoint + 1)...]))
        #expect(lines(rest) == [#"{"v":1,"type":"copy","text":"über"}"#])
    }

    @Test("one byte at a time works")
    func byteAtATime() {
        let reader = LineReader()
        var collected: [String] = []
        for byte in "hallo\nwelt\n".utf8Bytes {
            collected += lines(reader.feed([byte]))
        }
        #expect(collected == ["hallo", "welt"])
    }

    @Test("empty lines are surfaced, not swallowed")
    func emptyLines() {
        let reader = LineReader()
        // The decoder rejects them with "empty line"; deciding that here would
        // split the malformed-input policy across two files.
        #expect(lines(reader.feed("\n\na\n".utf8Bytes)) == ["", "", "a"])
    }

    @Test("a trailing \\r is stripped")
    func carriageReturn() {
        let reader = LineReader()
        #expect(lines(reader.feed("a\r\nb\r\n".utf8Bytes)) == ["a", "b"])
    }

    @Test("invalid UTF-8 is reported rather than dropped")
    func invalidUTF8() {
        let reader = LineReader()
        let result = reader.feed([0xFF, 0xFE, UInt8(ascii: "\n")])
        guard case let .undecodable(reason) = result.first else {
            Issue.record("expected an undecodable line, got \(result)")
            return
        }
        #expect(reason.contains("UTF-8"))
    }

    @Test("invalid UTF-8 does not poison the next frame")
    func resynchronisesAfterBadBytes() {
        let reader = LineReader()
        _ = reader.feed([0xFF, UInt8(ascii: "\n")])
        #expect(lines(reader.feed("good\n".utf8Bytes)) == ["good"])
    }

    @Test("flush returns a final line with no terminator")
    func flushUnterminated() {
        let reader = LineReader()
        #expect(lines(reader.feed("tail".utf8Bytes)).isEmpty)
        #expect(lines(reader.flush()) == ["tail"])
        #expect(reader.flush().isEmpty)
    }

    @Test("an over-long line is discarded and the stream resynchronises")
    func overlongLine() {
        // A peer that never sends a newline must not be able to grow this
        // buffer without bound.
        let reader = LineReader()
        var chunk = [UInt8](repeating: UInt8(ascii: "x"), count: 1 << 20)
        for _ in 0..<9 { _ = reader.feed(chunk) }
        chunk = [UInt8(ascii: "\n")] + "next\n".utf8Bytes
        let result = reader.feed(chunk)
        guard case let .undecodable(reason) = result.first else {
            Issue.record("expected the over-long line to be reported, got \(result)")
            return
        }
        #expect(reason.contains("longer than"))
        #expect(lines(result) == ["next"])
    }

    @Test("reset drops a partial frame")
    func resetDropsPartial() {
        let reader = LineReader()
        _ = reader.feed("half".utf8Bytes)
        reader.reset()
        #expect(lines(reader.feed("whole\n".utf8Bytes)) == ["whole"])
    }
}
