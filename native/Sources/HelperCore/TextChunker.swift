/// Splits text into the units posted by a single `CGEventKeyboardSetUnicodeString`.
///
/// The ceiling is a *ceiling*, and the interesting part of this file is the one
/// place it is allowed to be exceeded.
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
    /// UTF-16 units per `CGEventKeyboardSetUnicodeString` call.
    ///
    /// **Was 20 until 2026-09-06, on folklore.** The number came from 2015-era
    /// reports against Quicksilver and Qt that the call truncates at about
    /// twenty. `--probe-chunk` sets N units on a real event and reads them back
    /// off the same event: 20, 200, 1,000 and 2,000 all round-trip intact on
    /// macOS 26.6. Whatever those reports hit, it is not the API on this OS.
    ///
    /// 200 is FluidVoice's shipping value and gives 10× fewer events for the
    /// same text, which is 10× less exposure to whatever coalesces or
    /// intercepts them.
    ///
    /// **Measured for the API, not for any target.** Whether a given
    /// application *accepts* a 200-unit event is a different question and this
    /// says nothing about it. If one turns out not to, the fix is this constant
    /// and a rebuild — the environment knob that used to allow sweeping it
    /// without one was removed with the rest of the August measurement
    /// scaffolding. A known limit rather than an overlooked one.
    ///
    /// Kept in step with `UNICODE_CHUNK_UTF16_UNITS` in
    /// `src/shared/constants.ts`.
    public static let defaultMaxUTF16Units = 200

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
