/// Splits text into the units posted by a single `CGEventKeyboardSetUnicodeString`.
///
/// : "some apps drop characters if you go too fast", with ~20
/// UTF-16 units per event as the commonly-cited safe chunk. That number is a
/// *ceiling*, and the interesting part of this file is the one place it is
/// allowed to be exceeded.
///
/// **Chunks never split a grapheme cluster.** `CGEventKeyboardSetUnicodeString`
/// takes UTF-16, and the naive implementation slices the UTF-16 array every 20
/// units. That cuts surrogate pairs in half — every emoji is two units — and
/// worse, it cuts ZWJ sequences and combining marks apart, so `👨‍👩‍👧‍👦` arrives as
/// four separate people and `ü` typed as `u` + combining diaeresis arrives as a
/// bare `u` in one event and an orphan mark in the next. Both are German-and-
/// emoji cases the Phase 2 human test injects on purpose, so this is not
/// theoretical.
///
/// Consequence: a single grapheme longer than the limit is emitted alone, in an
/// over-sized chunk. Splitting it would corrupt it, and there is no third
/// option.

import Foundation

public enum TextChunker {
    /// , and `UNICODE_CHUNK_UTF16_UNITS` in
    /// `src/shared/constants.ts`, which carries the same citation.
    public static let defaultMaxUTF16Units = 20

    public static func chunks(of text: String, maxUTF16Units: Int = defaultMaxUTF16Units) -> [String] {
        let limit = max(1, maxUTF16Units)
        if text.isEmpty { return [] }

        var chunks: [String] = []
        var current = ""
        var currentUnits = 0

        for character in text {
            let units = character.utf16.count
            if currentUnits > 0, currentUnits + units > limit {
                chunks.append(current)
                current = ""
                currentUnits = 0
            }
            current.append(character)
            currentUnits += units
            // A grapheme that is itself over the limit becomes its own chunk.
            if currentUnits >= limit {
                chunks.append(current)
                current = ""
                currentUnits = 0
            }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}
