/// **The pasteboard is written, never read.**
///
/// This file used to enforce the opposite rule — that the pasteboard is never
/// written automatically at all — and `contracts/helper-protocol.md` §5.1
/// records why that changed. The short version: the original objection was to
/// the transcript *lingering* on the clipboard, and a promised item handed out
/// on read and cleared on settle answers that without a snapshot. The rule that
/// replaced it is narrower and harder to keep: **no read, anywhere.**
///
/// Reading is the operation macOS 15.4 previewed a permission prompt for and
/// macOS 26 carries. Writing never prompts. A design that only writes is immune
/// to that permanently — but only as long as nobody adds a "helpful" snapshot
/// later in good faith, which is exactly the change someone would make.
///
/// Two complementary checks, because either alone is weak. The shape is kept
/// from the file this replaces; the invariants are what changed.
///
/// **Behavioural**, driven through the real router with a spy pasteboard:
///
///   - nothing in the ladder reaches the `copy` seam, on any route, on any
///     branch — including every failing one, where a fallback is tempting;
///   - the `type` route never publishes anything, because that is what the
///     setting promises the user;
///   - the `paste` route publishes exactly once per insert, so no promise is
///     ever left with nothing to settle it;
///   - a declined insert publishes nothing at all.
///
/// **Structural**, by scanning `native/Sources`:
///
///   - no pasteboard *read* appears anywhere, which catches a snapshot added
///     somewhere the behavioural tests do not reach;
///   - the declared marker types come from one list, and that list never claims
///     the transcript is password-grade;
///   - `clearContents()` stays behind its `changeCount` guard.
///
/// The publish and the settle themselves are syscalls in the executable target,
/// which this test target cannot import. What holds them is `PasteTransaction`,
/// whose every branch — including "release before falling through" and "our own
/// clear must not settle twice" — is covered in `PasteTransactionTests`.

import Foundation
import Testing

@testable import HelperCore

@Suite("Clipboard discipline")
struct ClipboardDisciplineTests {
    private func router(
        paste: TierAttempt = .failed(reason: "the stub paste tier always declines"),
        ax: TierAttempt,
        unicode: TierAttempt,
        frontmost bundleId: String? = "com.apple.Notes"
    ) -> (CommandRouter, SpyPasteboard, StubPasteInserter, FrameRecorder) {
        let pasteboard = SpyPasteboard()
        let pasteStub = StubPasteInserter(result: paste)
        let recorder = FrameRecorder()
        let ladder = InsertionLadder(
            paste: pasteStub,
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
        return (router, pasteboard, pasteStub, recorder)
    }

    /// The `copy` seam is not the paste tier's route to the pasteboard, and this
    /// is what says so.
    ///
    /// The old version of this test asserted that *no* insertion path writes the
    /// pasteboard at all, which the paste tier makes false. What survives, and
    /// is the sharper claim: the paste tier publishes through a promise of its
    /// own inside the executable, and **nothing in the ladder can reach the
    /// `copy` seam**. A "helpful" fallback added later — "if both tiers fail, at
    /// least put it on the clipboard" — would leave the transcript sitting there
    /// as plain data with no markers and no settle, which is precisely the
    /// behaviour the promise design exists to avoid.
    @Test("no insertion path reaches the copy seam, on either route")
    func noInsertionPathWritesThroughCopy() {
        let branches: [(String, TierAttempt, TierAttempt, TierAttempt, String?)] = [
            ("paste landed", .confirmed, .confirmed, .succeeded, "com.apple.Notes"),
            ("paste declined, unicode took it", .failed(reason: "no"), .confirmed, .succeeded, "com.apple.Notes"),
            ("ax confirmed", .confirmed, .confirmed, .succeeded, "com.apple.Notes"),
            ("ax unverified", .confirmed, .succeeded, .succeeded, "com.apple.Notes"),
            ("unicode confirmed", .failed(reason: "no"), .failed(reason: "no"), .confirmed, "com.apple.Notes"),
            ("unicode unverified", .failed(reason: "no"), .failed(reason: "no"), .succeeded, "com.apple.Notes"),
            // The BUG-1 branch, and the one most likely to attract a helpful
            // "well, at least put it on the clipboard" later: it is the only
            // path where the helper knows for a fact the text did not arrive.
            (
                "unicode proven not landed", .failed(reason: "no"), .failed(reason: "no"),
                .notLanded(reason: "the field did not change"), "com.apple.Notes"
            ),
            ("everything fails", .failed(reason: "no"), .failed(reason: "no"), .failed(reason: "no"), "com.apple.Notes"),
            ("target moved", .confirmed, .confirmed, .succeeded, "com.microsoft.VSCode"),
            ("no target check", .failed(reason: "no"), .failed(reason: "no"), .failed(reason: "no"), nil),
        ]

        for route in ["auto", "paste", "type"] {
            for (label, paste, ax, unicode, target) in branches {
                let (router, pasteboard, _, recorder) = self.router(
                    paste: paste, ax: ax, unicode: unicode)
                let targetJSON = target.map { "\"\($0)\"" } ?? "null"
                router.handle(
                    line: #"{"v":1,"type":"insert","id":"x","text":"hallo","targetBundleId":\#(targetJSON),"route":"\#(route)"}"#
                )
                #expect(
                    pasteboard.writes.isEmpty, "\(label) on route \(route) wrote through `copy`")
                // …and an insert_result really was produced, so the case ran.
                #expect(
                    recorder.insertResults().count == 1,
                    "\(label) on route \(route) produced no insert_result")
            }
        }
    }

    @Test("the type route never publishes a promise")
    func typeRouteNeverPublishes() {
        // `insertMethod: "type"` is a promise to the user that dictation does
        // not touch their clipboard. It has to hold on every branch, including
        // the ones where nothing worked and a fallback would be tempting.
        for (ax, unicode) in [
            (TierAttempt.confirmed, TierAttempt.succeeded),
            (.failed(reason: "no"), .succeeded),
            (.failed(reason: "no"), .failed(reason: "no")),
        ] {
            let (router, pasteboard, paste, _) = self.router(
                paste: .confirmed, ax: ax, unicode: unicode)
            router.handle(
                line: #"{"v":1,"type":"insert","id":"x","text":"hallo","targetBundleId":null,"route":"type"}"#
            )
            #expect(paste.calls.isEmpty)
            #expect(pasteboard.writes.isEmpty)
        }
    }

    @Test("the paste route publishes exactly once per insert, whatever happens")
    func pasteRoutePublishesOnce() {
        // One publish per insert, on the landing branch and on every failing
        // one. A tier called twice would leave the first promise unsettled — the
        // transcript on the clipboard with nothing left to take it back.
        for outcome in [
            TierAttempt.confirmed,
            .failed(reason: "nobody read it"),
        ] {
            let (router, _, paste, recorder) = self.router(
                paste: outcome, ax: .confirmed, unicode: .succeeded)
            router.handle(
                line: #"{"v":1,"type":"insert","id":"x","text":"hallo","targetBundleId":null,"route":"paste"}"#
            )
            #expect(paste.calls == ["hallo"])
            #expect(recorder.insertResults().count == 1)
        }
    }

    @Test("a declined insert publishes nothing at all")
    func declinesPublishNothing() {
        // Empty text and a moved target are answered before the route is even
        // chosen, so neither can leave a promise on the pasteboard on its way to
        // saying no.
        let (router, pasteboard, paste, _) = self.router(
            paste: .confirmed, ax: .confirmed, unicode: .succeeded,
            frontmost: "com.apple.Notes")
        router.handle(
            line: #"{"v":1,"type":"insert","id":"a","text":"","targetBundleId":null,"route":"paste"}"#
        )
        router.handle(
            line: #"{"v":1,"type":"insert","id":"b","text":"hallo","targetBundleId":"com.microsoft.VSCode","route":"paste"}"#
        )
        #expect(paste.calls.isEmpty)
        #expect(pasteboard.writes.isEmpty)
    }

    @Test("a promise declares the transient markers, and never claims to be a password")
    func promiseDeclaresTheRightTypes() {
        #expect(
            PasteboardPromise.declaredTypes == [
                "public.utf8-plain-text",
                "org.nspasteboard.TransientType",
                "org.nspasteboard.AutoGeneratedType",
                "com.fynnius.grokdictate.PasteSession",
            ]
        )
        // `ConcealedType` signals password-grade content. Claiming it for a
        // dictation transcript makes some clipboard managers obfuscate the text,
        // which is worse for the user than recording it plainly.
        #expect(PasteboardPromise.declaredTypes.contains { $0.contains("Concealed") } == false)
    }

    @Test("the executable builds its declared types from that list, not from its own literals")
    func executableUsesTheSharedVocabulary() throws {
        // Two copies of a four-item list is one copy that silently loses a
        // marker, and the loss is invisible: a missing TransientType shows up as
        // "my clipboard manager keeps recording my dictation", months later, in
        // somebody else's application.
        let inserter = try #require(
            Self.swiftSources().first { $0.name == "PasteInserter.swift" })
        let code = Self.stripComments(inserter.contents)
        #expect(code.contains("PasteboardPromise.declaredTypes"))
        for marker in ["org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"] {
            #expect(code.contains("\"\(marker)\"") == false, "\(marker) is spelled out twice")
        }
    }

    @Test("the pasteboard is only ever cleared behind a changeCount guard")
    func clearingIsGuarded() throws {
        // Rule 2 of the transaction: only settle while we still own the
        // pasteboard. If the user copied something in the meantime, their action
        // wins and we touch nothing. The guard lives one function away from the
        // `clearContents()` it protects, so this asserts they stay together.
        let inserter = try #require(
            Self.swiftSources().first { $0.name == "PasteInserter.swift" })
        let code = Self.stripComments(inserter.contents)
        let clear = try #require(code.range(of: "func clear(")).lowerBound
        let body = code[clear...].prefix(400)
        #expect(body.contains("changeCount == expected"))
        #expect(body.contains("clearContents()"))
    }

    @Test("mute commands write nothing to the pasteboard")
    func muteCommandsWriteNothing() {
        let (router, pasteboard, _, _) = self.router(ax: .succeeded, unicode: .succeeded)
        router.handle(line: #"{"v":1,"type":"mute_output"}"#)
        router.handle(line: #"{"v":1,"type":"unmute_output"}"#)
        #expect(pasteboard.writes.isEmpty)
    }

    @Test("empty, malformed and unknown frames write nothing")
    func degenerateFramesWriteNothing() {
        let (router, pasteboard, _, _) = self.router(
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
        let (router, pasteboard, _, recorder) = self.router(ax: .succeeded, unicode: .succeeded)
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
