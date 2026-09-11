/// PCM16 little-endian chunking and RMS, with no audio I/O.
///
/// The capture executable converts hardware audio to 16 kHz mono PCM16 and
/// hands the bytes to this type. Tests cover the only two properties the
/// recogniser cares about: 3,200-byte chunks (the last drain chunk may be
/// shorter) and a 0…1 RMS of the window that produced each chunk.

import Foundation

public struct PcmChunk: Equatable, Sendable {
    public let pcm: Data
    /// RMS of the PCM16 window, scaled to 0…1.
    public let level: Double

    public init(pcm: Data, level: Double) {
        self.pcm = pcm
        self.level = level
    }
}

public struct PcmChunker: Sendable {
    public let chunkBytes: Int
    private var pending: Data = Data()

    public init(chunkBytes: Int) {
        precondition(chunkBytes > 0 && chunkBytes % 2 == 0, "chunkBytes must be a positive even count")
        self.chunkBytes = chunkBytes
    }

    public mutating func push(_ bytes: Data) -> [PcmChunk] {
        if bytes.isEmpty { return [] }
        pending.append(bytes)
        var chunks: [PcmChunk] = []
        while pending.count >= chunkBytes {
            let slice = pending.prefix(chunkBytes)
            pending.removeSubrange(..<chunkBytes)
            chunks.append(PcmChunk(pcm: Data(slice), level: rmsPcm16(slice)))
        }
        return chunks
    }

    /// Remainder, shorter than a full chunk. Empty pending → nil, so a stop
    /// with nothing in flight does not emit a zero-byte frame.
    public mutating func flush() -> PcmChunk? {
        if pending.isEmpty { return nil }
        let tail = pending
        pending = Data()
        return PcmChunk(pcm: tail, level: rmsPcm16(tail))
    }

    public mutating func reset() {
        pending = Data()
    }

    public var pendingBytes: Int { pending.count }
}

/// RMS of little-endian PCM16, treating full-scale as 1.0.
public func rmsPcm16(_ bytes: Data) -> Double {
    let sampleCount = bytes.count / 2
    if sampleCount == 0 { return 0 }
    var sum = 0.0
    var offset = 0
    bytes.withUnsafeBytes { raw in
        let buffer = raw.bindMemory(to: UInt8.self)
        while offset + 1 < buffer.count {
            let sample = Int16(bitPattern: UInt16(buffer[offset]) | (UInt16(buffer[offset + 1]) << 8))
            let float = Double(sample) / 32768.0
            sum += float * float
            offset += 2
        }
    }
    return sqrt(sum / Double(sampleCount))
}
