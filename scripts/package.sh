#!/usr/bin/env bash
#
# Build the standalone macOS app.
#
# ## Why this exists rather than a bare `electron-builder`
#
# Three steps have to happen in one order, and getting it wrong fails quietly:
#
#   1. `native/build.sh` first. `extraResources` copies whatever helper binary
#      is on disk, and a *stale* one is worse than a missing one —
#      `resolveHelperBinary()` reports a missing binary loudly and reports
#      nothing at all about an old one.
#   2. `npm run build` second, which typechecks and then runs electron-vite.
#   3. Ad-hoc code signing last, and this is the part `electron-builder` will
#      not do for us: its `identity: null` means "skip signing entirely", which
#      leaves the bundle unsigned. macOS will still run an unsigned app, but TCC
#      then has no stable identity to attach a grant to — so Microphone,
#      Accessibility and Input Monitoring would have to be re-approved after
#      changes that should not have mattered. An ad-hoc signature is not a
#      Developer ID and cannot be distributed (braindump §1.4 rules that out
#      anyway); it is enough to give this machine something stable to remember.
#
# Phase 5 packaged the app because HT-13 established that terminal-launched
# Electron cannot own a menu-bar status item on this machine — see
# docs/phase-5-review.md. The tray is the only affordance a menu-bar app has, so
# "run it from a terminal" stopped being a viable way to use the product.
#
# After a build, macOS treats the result as a new application. Expect to grant
# Microphone, Accessibility and Input Monitoring once (braindump §12.6, and
# docs/phase-2-report.md §4 HT-1 for why the grants were attached to the
# terminal until now).
set -euo pipefail
cd "$(dirname "$0")/.."

STAGED="release/mac-arm64/Grok Dictate.app"

# The finished app lives outside the repository, and that is not tidiness.
#
# This repository sits under `~/Documents`, which is synced by iCloud, and the
# fileprovider stamps `com.apple.FinderInfo` on anything inside it. `codesign`
# refuses a bundle carrying one — "resource fork, Finder information, or
# similar detritus not allowed" — and `xattr -cr` does not win, because the
# attribute comes back. Signing in `~/Applications` sidesteps it entirely, and
# stops iCloud uploading a 289 MB bundle on every build as a bonus.
#
# `~/Applications` is also the right home for the thing: Spotlight finds it,
# and the TCC grants for Microphone, Accessibility and Input Monitoring are
# keyed to a path that no longer moves when the build directory is cleaned.
APP="$HOME/Applications/Grok Dictate.app"

echo "──────────────────────────────────────────────────────────"
echo " 1/4  Swift helper"
echo "──────────────────────────────────────────────────────────"
./native/build.sh

echo
echo "──────────────────────────────────────────────────────────"
echo " 2/4  TypeScript, and the renderer bundles"
echo "──────────────────────────────────────────────────────────"
npm run build

echo
echo "──────────────────────────────────────────────────────────"
echo " 3/4  Application bundle"
echo "──────────────────────────────────────────────────────────"
# A running copy of the app holds its own bundle open, so the clean-out below
# fails with "Directory not empty" and the build lands on top of the old one.
# Ask it to quit properly first — it is a menu-bar app with an event tap and a
# child process, and SIGKILL would leave the helper orphaned.
if pgrep -f "Grok Dictate.app/Contents/MacOS" >/dev/null; then
  echo "  quitting the running copy first"
  osascript -e 'quit app "Grok Dictate"' 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "Grok Dictate.app/Contents/MacOS" >/dev/null || break
    sleep 0.5
  done
  pkill -f "Grok Dictate.app/Contents" 2>/dev/null || true
  sleep 1
fi

# From scratch, every time. `electron-builder` reuses an existing output
# directory, and re-signing over the previous ad-hoc signature fails with
# "resource fork, Finder information, or similar detritus not allowed" even
# after `xattr -cr` — the extended attributes come back with the nested
# frameworks it leaves in place. A build takes about a minute; a signature that
# silently did not get replaced costs a great deal more than that.
rm -rf release
npx electron-builder --dir

if [[ ! -x "$STAGED/Contents/Resources/grok-dictate-helper" ]]; then
  echo "the helper did not reach the bundle — check extraResources in electron-builder.yml" >&2
  exit 1
fi

# `ditto` rather than `cp -R`: it is the tool that preserves a bundle's
# symlinks and permissions correctly, which the Electron frameworks need.
mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
ditto "$STAGED" "$APP"

echo
echo "──────────────────────────────────────────────────────────"
echo " 4/4  Ad-hoc signature"
echo "──────────────────────────────────────────────────────────"
# Belt and braces. The `ditto` above leaves only `com.apple.provenance`, which
# `codesign` accepts, but the downloaded Electron zip carries its own.
xattr -cr "$APP"

# `--deep` is deprecated by Apple for distribution signing, and correct here:
# there is no Developer ID and no notarization, and every nested Electron
# framework needs the same ad-hoc identity as the outer bundle.
codesign --force --deep --sign - "$APP"
codesign --verify --verbose=1 "$APP" 2>&1 | sed 's/^/  /'

echo
echo "Built: $APP"
echo
echo "Run it with:   open -a \"Grok Dictate\""
echo "Its log:       ~/Library/Logs/grok-dictate/main.log"
echo
echo "The ad-hoc signature is derived from the bundle's contents, so macOS may"
echo "treat each build as a new application and drop its permissions. If Fn"
echo "stops working after a rebuild, the tray will say so — grant Accessibility"
echo "and Input Monitoring again under System Settings → Privacy & Security."
