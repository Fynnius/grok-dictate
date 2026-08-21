/// The clipboard is never written except on an explicit user action.
///
/// , user turn 7, verbatim: *"Is that the idea because I like
/// that more instead of it automatically pasting into my clipboard? I don't
/// want that."* IMPLEMENTATION-PLAN.md §3.2 requires Phase 2 to "add a test
/// asserting no clipboard write occurs on any insertion path", and §5b has
/// Phase 5 audit every path again.
///
/// Two complementary checks, because either alone is weak:
///
///   - **Behavioural** — every insertion path, including all the failing ones,
///     driven through the real router with a spy pasteboard. This catches a
///     helpful fallback added later ("if both tiers fail, at least put it on the
///     clipboard"), which is exactly the change someone would make in good
///     faith.
///   - **Structural** — `NSPasteboard` appears in exactly one source file. This
///     catches a write added somewhere the behavioural test does not reach.

import Foundation
import Testing

@testable import HelperCore

@Suite("Clipboard containment")
struct ClipboardContainmentTests {
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

    @Test("NSPasteboard appears in exactly one source file")
    func structuralContainment() throws {
        let sources = try Self.swiftSources()
        #expect(sources.count > 10, "source scan found suspiciously few files")

        let offenders =
            sources
            .filter { Self.stripComments($0.contents).contains("NSPasteboard") }
            .map(\.name)
            .sorted()
        #expect(offenders == ["SystemPasteboard.swift"])
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
