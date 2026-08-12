/// Chunking for `CGEventKeyboardSetUnicodeString`.
///
/// The reassembly property — "every chunking of every string joins back to the
/// original" — is the one that matters. : a partial or corrupted
/// injection produces wrong text with *no error anywhere*, so a bug here would
/// surface as characters quietly changing shape, not as a failure.

import Testing

@testable import HelperCore

@Suite("Unicode chunking")
struct TextChunkerTests {
    /// The shapes a UTF-16-counting chunker splits incorrectly.
    static let hazards = [
        "",
        "hallo",
        "Grüße aus München",
        "äöüÄÖÜß",
        "🚀",  // one surrogate pair
        "👍🏽",  // emoji + skin-tone modifier
        "👨‍👩‍👧‍👦",  // ZWJ sequence, 11 UTF-16 units in one grapheme
        "🇩🇪🇬🇧🇫🇷",  // regional-indicator pairs
        "e\u{0301}e\u{0301}e\u{0301}",  // combining acute accents
        "a\u{0301}\u{0308}\u{0327}b",  // several marks on one base
        "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀",
        "Zeile eins\nZeile zwei\tmit Tab",
        String(repeating: "x", count: 1000),
        #"@#$%^&*()_+-=[]{}|;:'",.<>/?`~"#,
    ]

    @Test("chunks rejoin to exactly the input", arguments: TextChunkerTests.hazards)
    func reassembles(text: String) {
        for limit in [1, 2, 3, 5, 20, 64] {
            let chunks = TextChunker.chunks(of: text, maxUTF16Units: limit)
            #expect(chunks.joined() == text, "limit \(limit)")
        }
    }

    @Test("no chunk splits a grapheme cluster", arguments: TextChunkerTests.hazards)
    func neverSplitsGraphemes(text: String) {
        for limit in [1, 2, 3, 5, 20, 64] {
            let chunks = TextChunker.chunks(of: text, maxUTF16Units: limit)
            // Counting characters chunk-by-chunk and comparing with the whole
            // catches a split cluster: half a ZWJ sequence is *more* graphemes
            // than the intact one.
            #expect(chunks.reduce(0) { $0 + $1.count } == text.count, "limit \(limit)")
        }
    }

    @Test("chunks stay within the limit unless one grapheme exceeds it")
    func respectsTheLimit() {
        let text = "Grüße 👨‍👩‍👧‍👦 aus München 🇩🇪 und Zürich"
        let chunks = TextChunker.chunks(of: text, maxUTF16Units: 20)
        for chunk in chunks {
            if chunk.count == 1 {
                // A single grapheme longer than the limit is emitted alone:
                // splitting it would corrupt it, and there is no third option.
                continue
            }
            #expect(chunk.utf16.count <= 20)
        }
    }

    @Test("the family emoji survives a limit smaller than itself")
    func oversizedGrapheme() {
        let family = "👨‍👩‍👧‍👦"
        #expect(family.utf16.count > 5)
        let chunks = TextChunker.chunks(of: family, maxUTF16Units: 5)
        #expect(chunks == [family])
    }

    @Test("empty text produces no chunks")
    func empty() {
        #expect(TextChunker.chunks(of: "").isEmpty)
    }

    @Test("a nonsensical limit does not hang or crash")
    func degenerateLimits() {
        #expect(TextChunker.chunks(of: "abc", maxUTF16Units: 0) == ["a", "b", "c"])
        #expect(TextChunker.chunks(of: "abc", maxUTF16Units: -5) == ["a", "b", "c"])
    }

    @Test("the default is the 20 units  cites")
    func defaultLimit() {
        #expect(TextChunker.defaultMaxUTF16Units == 20)
        // Kept in step with UNICODE_CHUNK_UTF16_UNITS in src/shared/constants.ts.
        #expect(TextChunker.chunks(of: String(repeating: "a", count: 100)).count == 5)
    }
}
