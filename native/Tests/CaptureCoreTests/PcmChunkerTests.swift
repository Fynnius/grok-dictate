import Foundation
import Testing

@testable import CaptureCore

@Suite("PCM16 chunking")
struct PcmChunkerTests {
    @Test("emits exactly-sized chunks and holds the remainder")
    func sizedChunks() {
        var chunker = PcmChunker(chunkBytes: 8)
        let first = chunker.push(Data([1, 0, 2, 0, 3, 0]))
        #expect(first.isEmpty)
        #expect(chunker.pendingBytes == 6)

        let second = chunker.push(Data([4, 0, 5, 0]))
        #expect(second.count == 1)
        #expect(second[0].pcm.count == 8)
        #expect(Array(second[0].pcm) == [1, 0, 2, 0, 3, 0, 4, 0])
        #expect(chunker.pendingBytes == 2)
    }

    @Test("flush emits the tail because the last 100 ms is the end of the last word")
    func flushTail() {
        var chunker = PcmChunker(chunkBytes: 8)
        _ = chunker.push(Data([1, 0, 2, 0]))
        let tail = chunker.flush()
        #expect(tail?.pcm.count == 4)
        #expect(chunker.flush() == nil)
    }

    @Test("reset drops pending bytes")
    func resetDrops() {
        var chunker = PcmChunker(chunkBytes: 8)
        _ = chunker.push(Data([1, 0, 2, 0]))
        chunker.reset()
        #expect(chunker.flush() == nil)
    }

    @Test("silence has RMS 0")
    func silentRms() {
        #expect(rmsPcm16(Data(repeating: 0, count: 8)) == 0)
        #expect(rmsPcm16(Data()) == 0)
    }

    @Test("full-scale PCM16 has RMS near 1")
    func fullScaleRms() {
        // 32767 as little-endian int16, four samples.
        let bytes: [UInt8] = [0xFF, 0x7F, 0xFF, 0x7F, 0xFF, 0x7F, 0xFF, 0x7F]
        let level = rmsPcm16(Data(bytes))
        #expect(abs(level - 32767.0 / 32768.0) < 0.0001)
    }

    @Test("a pushed full chunk reports the RMS of that window")
    func chunkLevel() {
        var chunker = PcmChunker(chunkBytes: 4)
        let chunks = chunker.push(Data([0x00, 0x00, 0x00, 0x40]))
        #expect(chunks.count == 1)
        let expected = rmsPcm16(Data([0x00, 0x00, 0x00, 0x40]))
        #expect(chunks[0].level == expected)
    }
}
