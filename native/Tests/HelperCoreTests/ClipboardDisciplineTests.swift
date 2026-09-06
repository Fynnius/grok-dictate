/// **The pasteboard is written, never read.**
///
/// This file used to enforce the opposite rule — that the pasteboard is never
/// written automatically at all — and `contracts/helper-protocol.md` §5 records
/// why that changed. The short version: the original objection was to the
/// transcript *lingering* on the clipboard, and a promised item handed out on
/// read and cleared on settle answers that without a snapshot. The rule that
/// replaced it is narrower and harder to keep: **no read, anywhere.**
///
/// Reading is the operation macOS 15.4 previewed a permission prompt for and
/// macOS 26 carries. Writing never prompts. A design that only writes is immune
/// to that permanently — but only as long as nobody adds a "helpful" snapshot
/// later in good faith, which is exactly the change someone would make.
///
/// Two complementary checks, because either alone is weak. The shape is kept
/// from the file this replaces; the invariants are what changed:
///
///   - **Structural** — no pasteboard *read* appears anywhere in
///     `native/Sources`. This catches a snapshot added somewhere the
///     behavioural test does not reach.
///   - **Behavioural** — every insertion path driven through the real router
///     with a spy pasteboard, including all the failing ones, asserting that
///     what reaches the pasteboard is what the route promised and nothing else.

import Foundation
import Testing

@testable import HelperCore

@Suite("Clipboard discipline")
struct ClipboardDisciplineTests {
    private func router(
        ax: TierAttempt,
        unicode: TierAttempt,
        frontmost bundleId: String? = "com.apple.Notes"
    ) -> (CommandRouter, SpyPasteboard, FrameRecorder) {
        let pasteboard = SpyPasteboard()
        let recorder = FrameRecorder()
        let ladder = InsertionLadder(
            accessibility: StubAccessibilityInserter(result: ax),
            unicode: StubUnicodeInserter(result: unicode),
            frontmost: StubFrontmost(bundleId: bundleId, name: "Notes")
        )
        let router = CommandRouter(
            insertion: ladder,
            pasteboard: pasteboard,
            frontmost: StubFrontmost(bundleId: bundleId, name: "Notes"),
            emit: recorder.emit
        )
        return (router, pasteboard, recorder)
    }

    @Test("no insertion path writes the clipboard")
    func noInsertionPathWritesTheClipboard() {
        let outcomes: [(String, TierAttempt, TierAttempt, String?)] = [
            ("ax confirmed", .confirmed, .succeeded, "com.apple.Notes"),
            ("ax unverified", .succeeded, .succeeded, "com.apple.Notes"),
            ("unicode confirmed", .failed(reason: "no"), .confirmed, "com.apple.Notes"),
            ("unicode unverified", .failed(reason: "no"), .succeeded, "com.apple.Notes"),
            // The BUG-1 branch, and the one most likely to attract a helpful
            // "well, at least put it on the clipboard" later: it is the only
            // path where the helper knows for a fact the text did not arrive.
            (
                "unicode proven not landed", .failed(reason: "no"),
                .notLanded(reason: "the field did not change"), "com.apple.Notes"
            ),
            ("both fail", .failed(reason: "no"), .failed(reason: "no"), "com.apple.Notes"),
            ("target moved", .confirmed, .succeeded, "com.microsoft.VSCode"),
            ("no target check", .failed(reason: "no"), .failed(reason: "no"), nil),
        ]

        for (label, ax, unicode, target) in outcomes {
            let (router, pasteboard, recorder) = self.router(ax: ax, unicode: unicode)
            let targetJSON = target.map { "\"\($0)\"" } ?? "null"
            router.handle(
                line: #"{"v":1,"type":"insert","id":"x","text":"hallo","targetBundleId":\#(targetJSON)}"#
            )
            #expect(pasteboard.writes.isEmpty, "\(label) wrote to the pasteboard")
            // …and an insert_result really was produced, so the case ran.
            #expect(recorder.insertResults().count == 1, "\(label) produced no insert_result")
        }
    }

    @Test("mute commands write nothing to the pasteboard")
    func muteCommandsWriteNothing() {
        let (router, pasteboard, _) = self.router(
            ax: .succeeded, unicode: .succeeded)
        router.handle(line: #"{"v":1,"type":"mute_output"}"#)
        router.handle(line: #"{"v":1,"type":"unmute_output"}"#)
        #expect(pasteboard.writes.isEmpty)
    }

    @Test("empty, malformed and unknown frames write nothing")
    func degenerateFramesWriteNothing() {
        let (router, pasteboard, _) = self.router(
            ax: .failed(reason: "no"),
            unicode: .failed(reason: "no")
        )
        router.handle(line: #"{"v":1,"type":"insert","id":"x","text":"","targetBundleId":null}"#)
        router.handle(line: "not json at all")
        router.handle(line: #"{"v":1,"type":"paste","text":"hallo"}"#)
        router.handle(line: #"{"v":99,"type":"copy","text":"hallo"}"#)
        router.handle(line: #"{"v":1,"type":"get_frontmost","id":"a"}"#)
        router.handle(line: #"{"v":1,"type":"set_hotkeys","ptt":"fn","toggle":"fn+space","retry":"ctrl+cmd+v"}"#)
        router.handle(line: #"{"v":1,"type":"shutdown"}"#)
        #expect(pasteboard.writes.isEmpty)
    }

    @Test("only an explicit copy command writes, and it writes exactly once")
    func copyWrites() {
        let (router, pasteboard, recorder) = self.router(ax: .succeeded, unicode: .succeeded)
        router.handle(line: #"{"v":1,"type":"copy","text":"hallo Welt"}"#)
        #expect(pasteboard.writes == ["hallo Welt"])
        // The log records that it happened, with a length and never the text —
        // the transcript may be anything the user said.
        let logged = recorder.logMessages.joined(separator: "\n")
        #expect(logged.contains("pasteboard"))
        #expect(logged.contains("hallo Welt") == false)
    }

    /// Every way AppKit offers to get data *out* of a pasteboard.
    ///
    /// The write-side spellings deliberately do not collide with these:
    /// `setString(_:forType:)` does not contain `string(forType:`, and
    /// `setData(_:forType:)` does not contain `data(forType:`. That is what
    /// makes a plain substring scan sufficient here, and it is worth stating,
    /// because the scan silently stops working if somebody writes
    /// `pasteboard . string(forType:)` with spaces.
    static let readSpellings = [
        "pasteboardItems",
        "string(forType:",
        "data(forType:",
        "propertyList(forType:",
        "readObjects(",
        "canReadObject",
        "readFileContents(",
    ]

    @Test("nothing in the sources reads the pasteboard")
    func noPasteboardRead() throws {
        let sources = try Self.swiftSources()
        #expect(sources.count > 10, "source scan found suspiciously few files")

        let offenders = sources.flatMap { source -> [String] in
            let code = Self.stripComments(source.contents)
            return Self.readSpellings
                .filter { code.contains($0) }
                .map { "\(source.name) calls \($0))" }
        }
        #expect(offenders.isEmpty)
    }

    @Test("HelperCore never touches AppKit, CoreGraphics or the AX API")
    func coreIsFreeOfSystemFrameworks() throws {
        // The ladder and everything under it live in HelperCore. If AppKit ever
        // appears there, the containment argument above stops being structural.
        //
        // The other three are here for a second reason. HelperCore holds the
        // *policies* the system frameworks are steered by — `AXSelectedTextGate`
        // and, since Phase 5, `AXWriteVerification` — and the temptation with
        // each is to reach for the real `AXUIElement` rather than take plain
        // values. That would move the decision out of `swift test`, which runs
        // headless with no TCC grant and no windowserver, and into a place only
        // a human with an app on screen can reach (Package.swift, and
        // IMPLEMENTATION-PLAN.md §4 "test what can be tested without a human").
        let forbidden = ["AppKit", "CoreGraphics", "ApplicationServices", "Carbon"]
        let core = try Self.swiftSources().filter { $0.path.contains("/Sources/HelperCore/") }
        #expect(core.count > 3, "source scan found suspiciously few HelperCore files")

        let offenders = core.flatMap { source -> [String] in
            let code = Self.stripComments(source.contents)
            return forbidden
                .filter { code.contains("import \($0)") }
                .map { "\(source.name) imports \($0)" }
        }
        #expect(offenders.isEmpty)
    }

    // MARK: - Source scanning

    struct Source {
        let name: String
        let path: String
        let contents: String
    }

    static func swiftSources() throws -> [Source] {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // HelperCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // native
        let sourcesRoot = packageRoot.appendingPathComponent("Sources")

        guard
            let walker = FileManager.default.enumerator(
                at: sourcesRoot,
                includingPropertiesForKeys: nil
            )
        else {
            throw CocoaError(.fileNoSuchFile)
        }

        var sources: [Source] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let contents = try String(contentsOf: url, encoding: .utf8)
            sources.append(Source(name: url.lastPathComponent, path: url.path, contents: contents))
        }
        return sources
    }

    /// Comments are stripped so that *documenting* the rule does not break it —
    /// several files explain the containment and name `NSPasteboard` while
    /// doing so. Deliberately simple: it does not understand `//` inside a
    /// string literal, and no file in this package has one.
    static func stripComments(_ source: String) -> String {
        var output = ""
        var index = source.startIndex
        var inLineComment = false
        var blockDepth = 0

        while index < source.endIndex {
            let remainder = source[index...]
            if inLineComment {
                if source[index] == "\n" { inLineComment = false }
                index = source.index(after: index)
                continue
            }
            if blockDepth > 0 {
                if remainder.hasPrefix("*/") {
                    blockDepth -= 1
                    index = source.index(index, offsetBy: 2)
                    continue
                }
                if remainder.hasPrefix("/*") {
                    blockDepth += 1
                    index = source.index(index, offsetBy: 2)
                    continue
                }
                index = source.index(after: index)
                continue
            }
            if remainder.hasPrefix("//") {
                inLineComment = true
                index = source.index(index, offsetBy: 2)
                continue
            }
            if remainder.hasPrefix("/*") {
                blockDepth = 1
                index = source.index(index, offsetBy: 2)
                continue
            }
            output.append(source[index])
            index = source.index(after: index)
        }
        return output
    }
}
