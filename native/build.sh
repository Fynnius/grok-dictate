#!/usr/bin/env bash
#
# Builds the native helper and leaves it at native/build/grok-dictate-helper.
#
# That path is deliberate: `helperSpawnSpec()` in src/main/native/index.ts looks
# there in development, and a packaged build copies the same file into the app
# bundle's Resources. One well-known location, so nothing has to be threaded
# through a config.
#
# arm64 only. Assumption 10.7 in the braindump — "single user, single machine,
# macOS aarch64" — and building a universal binary would double the build for a
# slice nobody runs.
set -euo pipefail
cd "$(dirname "$0")"

CONFIGURATION="${CONFIGURATION:-release}"
OUTPUT_DIR="build"
OUTPUT="$OUTPUT_DIR/grok-dictate-helper"

# SwiftPM's scratch directory goes to out/ rather than native/.build.
#
# Not a preference: `npm run lint` runs `prettier --check .`, and Prettier reads
# only the *root* .prettierignore — a native/.gitignore does not reach it. The
# scratch tree is full of .json and .yaml, so a default-placed .build fails the
# lint. `.prettierignore` belongs to Phase 1 (IMPLEMENTATION-PLAN.md §2), and
# out/ is already ignored by both git and Prettier, so this keeps the build
# inside Phase 2's boundary. Recorded as a cross-boundary request in
# docs/phase-2-report.md: a bare `swift build` still writes native/.build.
SCRATCH="${SCRATCH:-../out/native-build}"

# Warnings are errors (IMPLEMENTATION-PLAN.md §4). Passed here rather than in
# Package.swift because `unsafeFlags` in a manifest makes the package
# undependable from anywhere else, and this is the only build entry point.
echo "building ($CONFIGURATION)…"
swift build -c "$CONFIGURATION" --scratch-path "$SCRATCH" -Xswiftc -warnings-as-errors

mkdir -p "$OUTPUT_DIR"
cp -f "$SCRATCH/$CONFIGURATION/grok-dictate-helper" "$OUTPUT"

# The AX API requires a signed binary (braindump §4.6). Ad-hoc is enough in
# development. Note that an ad-hoc signature is a hash of the binary, so it
# changes on every build — if TCC ever attributes the grant to *this* binary
# rather than to the Electron process that spawns it, permissions would need
# re-granting after every build. Which of those two is true is assumption 10.5,
# and it is the first thing the Phase 2 human tests check.
codesign --force --sign - --identifier com.grokdictate.helper "$OUTPUT"

echo
echo "built  $(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
"$OUTPUT" --version | sed 's/^/version /'
codesign -dv "$OUTPUT" 2>&1 | sed 's/^/sign   /'
