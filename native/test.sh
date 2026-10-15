#!/usr/bin/env bash
#
# Runs the Swift unit tests with warnings as errors.
#
# Not wired into `npm test`: that would make the JavaScript suite depend on an
# Xcode toolchain, and a fresh clone with no Xcode would fail a test run for
# reasons that have nothing to do with the change under test. The TypeScript
# side instead spawns the *built binary* and checks protocol conformance
# (src/main/native/helper-binary.test.ts, src/main/audio/capture-process.test.ts),
# skipping itself when the binary is absent. HelperCore and CaptureCore tests
# both run here; neither needs a microphone.
set -euo pipefail
cd "$(dirname "$0")"
# --scratch-path for the same reason as build.sh: Prettier reads only the root
# .prettierignore, and a default-placed native/.build fails `npm run lint`.
#
# Outside the repository, unlike build.sh: SwiftPM ad-hoc signs the .xctest
# bundles, and this tree sits under iCloud-synced `~/Documents`, whose
# fileprovider stamps `com.apple.FinderInfo` on them. `codesign` then refuses
# with "resource fork, Finder information, or similar detritus not allowed" —
# the same trap scripts/package.sh signs around.
swift test --scratch-path "${SCRATCH:-${TMPDIR:-/tmp}/grok-dictate-native-test}" -Xswiftc -warnings-as-errors "$@"
