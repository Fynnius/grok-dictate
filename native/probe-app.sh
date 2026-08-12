#!/usr/bin/env bash
#
# One app, one command: inject the known 300-character string, then diff what
# actually landed against what was sent.
#
# IMPLEMENTATION-PLAN.md §3.2 test 3 wants this for eight applications across two
# tiers. Done by hand that is a `--probe-insert`, a `pbpaste >`, and a
# `verify-insert.sh` each time; this collapses it to one command and one Return.
#
# Reading the result back through the pasteboard is safe: the copy is the user's
# own ⌘C, not the application writing to it. Braindump §5.8 forbids *the app*
# writing the clipboard, which is asserted separately by
# ClipboardContainmentTests and is not what this script does.
#
# Usage:
#   ./probe-app.sh notes            # auto — walks the real ladder
#   ./probe-app.sh notes ax         # force the AX tier only
#   ./probe-app.sh notes unicode    # force Unicode injection only
set -euo pipefail
cd "$(dirname "$0")"

LABEL="${1:-}"
TIER="${2:-auto}"
DELAY="${DELAY:-6}"

if [[ -z "$LABEL" ]]; then
  echo "usage: $0 <app-label> [auto|ax|unicode]" >&2
  echo "example: $0 cursor unicode" >&2
  exit 64
fi

OUT="probe-out/${LABEL}-${TIER}.txt"
LOG="probe-out/${LABEL}-${TIER}.log"
mkdir -p probe-out

echo "════════════════════════════════════════════════════════════"
echo " $LABEL — tier: $TIER"
echo "════════════════════════════════════════════════════════════"
echo
echo "Switch to the app now and put the caret in an EMPTY text field."
echo

# Tee'd to a file as well as the screen: the tier the ladder chose and the real
# AXError behind an AX decline are the evidence braindump §9.5/§9.7 want, and
# leaving them only in a terminal scrollback means they have to be copied by
# hand — which is exactly the step that already went wrong once.
./build/grok-dictate-helper --probe-insert --tier "$TIER" --delay "$DELAY" 2>&1 | tee "$LOG" || true

echo
echo "────────────────────────────────────────────────────────────"
echo "In the app: select all (⌘A) and copy (⌘C)."
echo "Then come back here and press Return."
read -r _

pbpaste > "$OUT"
echo
./verify-insert.sh "$OUT" 2>&1 | tee -a "$LOG" || true

# A capture that matches the command that produced it means ⌘C grabbed the
# shell, not the app. Caught once already; cheaper to detect than to re-run.
if grep -q "probe-app.sh" "$OUT" 2>/dev/null; then
  echo
  echo "⚠️  The capture looks like a shell command, not the injected text."
  echo "    The ⌘C probably happened in Terminal instead of the target app."
  echo "    Re-run: $0 $LABEL $TIER"
fi

echo
echo "saved: $OUT"
echo "saved: $LOG"
