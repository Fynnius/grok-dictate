/// Newline-delimited framing over a byte stream.
///
/// stdin arrives in arbitrary chunks that have nothing to do with frame
/// boundaries: one read can carry half a frame, or three frames and a half.
/// Contract §1 — "a reader must buffer until it sees `\n`".
///
/// Operates on bytes, not `String`, on purpose. Decoding a chunk to `String`
/// before splitting would corrupt any multi-byte character that straddles a
/// chunk boundary — and the transcripts this app moves are German, so `ü`
/// split across two reads is a routine case, not an exotic one.

import Foundation

public final class LineReader {
    /// Hard ceiling on a single unterminated line. A peer that never sends a
    /// newline would otherwise grow this buffer without bound. 8 MB is far
    /// above any real frame — the largest thing on this wire is one transcript
    /// — so hitting it means the stream is broken, not busy.
    public static let maxLineBytes = 8 * 1024 * 1024

    private var buffer: [UInt8] = []
    private var overflowed = false

    public init() {}

    public enum Line: Equatable {
        case line(String)
        /// A complete line that was not valid UTF-8, or a line discarded for
        /// exceeding `maxLineBytes`. Reported rather than dropped, because a
        /// silently vanishing command is the failure this type exists to catch.
        case undecodable(reason: String)
    }

    /// Feed one chunk; get back every complete line it completed.
    public func feed(_ bytes: [UInt8]) -> [Line] {
        var lines: [Line] = []
        for byte in bytes {
            if byte == UInt8(ascii: "\n") {
                if overflowed {
                    lines.append(
                        .undecodable(
                            reason: "discarded a line longer than \(LineReader.maxLineBytes) bytes"
                        )
                    )
                    overflowed = false
                    buffer.removeAll(keepingCapacity: false)
                    continue
                }
                lines.append(Self.decode(buffer))
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            if overflowed { continue }
            if buffer.count >= LineReader.maxLineBytes {
                // Drop the partial line and keep scanning for the newline that
                // ends it, so the *next* frame still parses. Resynchronising
                // matters more than reporting the exact byte that broke it.
                overflowed = true
                buffer.removeAll(keepingCapacity: false)
                continue
            }
            buffer.append(byte)
        }
        return lines
    }

    /// Anything left when the stream ends. A final line without a trailing
    /// newline is still a frame.
    public func flush() -> [Line] {
        defer {
            buffer.removeAll(keepingCapacity: false)
            overflowed = false
        }
        if overflowed {
            return [.undecodable(reason: "discarded an over-long line at end of stream")]
        }
        if buffer.isEmpty { return [] }
        return [Self.decode(buffer)]
    }

    public func reset() {
        buffer.removeAll(keepingCapacity: false)
        overflowed = false
    }

    private static func decode(_ bytes: [UInt8]) -> Line {
        // Tolerate CRLF: a stray `\r` is a transport artefact, not content.
        var slice = bytes[...]
        if slice.last == UInt8(ascii: "\r") { slice = slice.dropLast() }
        guard let text = String(bytes: slice, encoding: .utf8) else {
            return .undecodable(reason: "line is not valid UTF-8 (\(slice.count) bytes)")
        }
        return .line(text)
    }
}
