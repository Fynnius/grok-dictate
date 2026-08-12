#!/usr/bin/env bash
#
# Byte-for-byte comparison of what was injected against what actually landed.
#
# IMPLEMENTATION-PLAN.md §3.2 test 3: "Inject a known 300-character UTF-8 string
# (including German umlauts and emoji) into VS Code/Cursor, iTerm, Slack,
# Safari, Notes; diff byte-for-byte." Braindump §12.5 is why the comparison has
# to be exact rather than eyeballed: a partial or altered injection produces
# plausible-looking text with no error anywhere.
#
# Usage:
#   ./build/grok-dictate-helper --probe-insert --delay 5
#   # …select-all and copy from the target app, then:
#   pbpaste > probe-out/cursor.txt
#   ./verify-insert.sh probe-out/cursor.txt
set -euo pipefail
cd "$(dirname "$0")"

EXPECTED="${EXPECTED:-probe-out/expected.txt}"
ACTUAL="${1:-}"

if [[ -z "$ACTUAL" ]]; then
  echo "usage: $0 <file-containing-what-landed-in-the-app>" >&2
  exit 64
fi
if [[ ! -f "$EXPECTED" ]]; then
  echo "no $EXPECTED — run the probe first so it records what it injected" >&2
  exit 66
fi
if [[ ! -f "$ACTUAL" ]]; then
  echo "no such file: $ACTUAL" >&2
  exit 66
fi

# `pbpaste > file` and most editors add a trailing newline that was never
# injected. Stripping exactly one trailing newline from the actual file keeps
# that artefact from being reported as a difference; everything else is real.
STRIPPED="$(mktemp)"
trap 'rm -f "$STRIPPED"' EXIT
perl -0777 -pe 's/\n\z//' "$ACTUAL" > "$STRIPPED"

expected_bytes=$(wc -c < "$EXPECTED" | tr -d ' ')
actual_bytes=$(wc -c < "$STRIPPED" | tr -d ' ')
expected_chars=$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read()))' "$EXPECTED")
actual_chars=$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read()))' "$STRIPPED")

echo "expected: $expected_bytes bytes, $expected_chars scalars"
echo "actual:   $actual_bytes bytes, $actual_chars scalars"
echo

if cmp -s "$EXPECTED" "$STRIPPED"; then
  echo "IDENTICAL — byte for byte."
  exit 0
fi

echo "DIFFERENT. First difference:"
cmp "$EXPECTED" "$STRIPPED" || true
echo
echo "Side by side (expected | actual):"
diff <(fold -w 60 "$EXPECTED") <(fold -w 60 "$STRIPPED") || true
exit 1
