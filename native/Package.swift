// swift-tools-version: 6.0
//
// The native macOS helper — the two things Electron cannot do: observe the Fn
// key, and put text into another application.
//
// Split deliberately into two targets:
//
//   HelperCore           — pure logic. No CoreGraphics, no ApplicationServices,
//                          no AppKit. Everything here runs headless in `swift
//                          test` with no TCC grants and no windowserver, which
//                          is what makes the protocol, the hotkey recogniser,
//                          the chunker and the insertion ladder testable
//                          without a human (IMPLEMENTATION-PLAN.md §4).
//   grok-dictate-helper  — the thin shell that binds HelperCore's protocols to
//                          CGEventTap, the AX API, NSWorkspace and Carbon.
//
// LANGUAGE MODE — deliberate, and the one non-obvious choice in this file.
// The package builds in Swift 5 language mode rather than Swift 6. The helper
// is single-threaded by construction: one CFRunLoop on the main thread, a
// CGEventTap C callback that is *documented* to run on the thread that added
// the run-loop source, and timers on that same loop. Swift 6's strict
// concurrency has nothing to check here — there is no second thread to be
// unsafe with — but it would require `MainActor.assumeIsolated` at every
// C-callback and timer boundary, which adds noise around exactly the code that
// most needs to stay readable. Warnings-as-errors is still enforced, in
// `build.sh` and `test.sh`, per IMPLEMENTATION-PLAN.md §4.

import PackageDescription

let package = Package(
    name: "GrokDictateHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "HelperCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "grok-dictate-helper",
            dependencies: ["HelperCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "HelperCoreTests",
            dependencies: ["HelperCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
