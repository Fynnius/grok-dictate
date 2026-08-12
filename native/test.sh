#!/usr/bin/env bash
#
# Runs the Swift unit tests with warnings as errors.
#
# Not wired into `npm test`: that would make the JavaScript suite depend on an
# Xcode toolchain, and a fresh clone with no Xcode would fail a test run for
# reasons that have nothing to do with the change under test. The TypeScript
# side instead spawns the *built binary* and checks protocol conformance
# (src/main/native/helper-binary.test.ts), skipping itself when the binary is
# absent.
set -euo pipefail
cd "$(dirname "$0")"
# --scratch-path for the same reason as build.sh: Prettier reads only the root
# .prettierignore, and a default-placed native/.build fails `npm run lint`.
swift test --scratch-path "${SCRATCH:-../out/native-build}" -Xswiftc -warnings-as-errors "$@"
