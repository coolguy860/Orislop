#!/usr/bin/env bash
set -Eeuo pipefail

# This file is uploaded by START_ORISLOP_VAST.ps1. It contains no credentials,
# accepts no interactive input, and never deletes an existing project or model.

WORKSPACE="${1:-/workspace}"
PACKAGE_NAME="orislop_extension_test_ready_v4_production"
ARCHIVE="$WORKSPACE/$PACKAGE_NAME.zip"
PROJECT="$WORKSPACE/$PACKAGE_NAME"
RECEIPT="$PROJECT/.orislop-source-archive.sha256"

fail() {
  echo "[orislop-bootstrap] $*" >&2
  exit 2
}

case "$WORKSPACE" in
  /*) ;;
  *) fail "The remote workspace must be an absolute path." ;;
esac

command -v python3 >/dev/null 2>&1 || fail "Python 3 is missing from this Vast template. Use the recommended PyTorch template."
[[ -r "$ARCHIVE" ]] || fail "The uploaded v4 ZIP is missing at $ARCHIVE."

if [[ -z "${HF_TOKEN:-}" ]]; then
  fail "HF_TOKEN is missing. Add a newly rotated read token to the Vast instance's private environment, then rerun the same Windows command. This launcher never prompts for or stores the token."
fi
export HF_TOKEN

ARCHIVE_SHA256="$(python3 - "$ARCHIVE" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

digest = sha256()
with Path(sys.argv[1]).open("rb") as handle:
    for block in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(block)
print(digest.hexdigest())
PY
)"

INSTALLED_SHA256=""
if [[ -r "$RECEIPT" ]]; then
  INSTALLED_SHA256="$(tr -d '[:space:]' < "$RECEIPT")"
fi

if [[ "$INSTALLED_SHA256" != "$ARCHIVE_SHA256" ]] || [[ ! -f "$PROJECT/scripts/orislop_vast_manager.py" ]]; then
  echo "[orislop-bootstrap] Verifying and installing the uploaded source package..."
  python3 - "$ARCHIVE" "$WORKSPACE" "$PACKAGE_NAME" <<'PY'
from pathlib import Path, PurePosixPath
import sys
import zipfile

archive = Path(sys.argv[1])
workspace = Path(sys.argv[2]).resolve()
package = sys.argv[3]
prefix = package + "/"

with zipfile.ZipFile(archive) as bundle:
    members = bundle.infolist()
    if not members:
        raise SystemExit("[orislop-bootstrap] The uploaded ZIP is empty.")
    for member in members:
        logical = PurePosixPath(member.filename)
        if logical.is_absolute() or ".." in logical.parts:
            raise SystemExit(f"[orislop-bootstrap] Unsafe ZIP path rejected: {member.filename!r}")
        if member.filename != package and not member.filename.startswith(prefix):
            raise SystemExit(f"[orislop-bootstrap] Unexpected ZIP root rejected: {member.filename!r}")
        destination = (workspace / Path(*logical.parts)).resolve()
        try:
            destination.relative_to(workspace)
        except ValueError:
            raise SystemExit(f"[orislop-bootstrap] ZIP path escapes the workspace: {member.filename!r}")
    bundle.extractall(workspace)
PY
  [[ -f "$PROJECT/scripts/orislop_vast_manager.py" ]] || fail "The ZIP did not contain the expected v4 project."
  printf '%s\n' "$ARCHIVE_SHA256" > "$RECEIPT"
else
  echo "[orislop-bootstrap] The identical v4 source package is already installed; reusing it."
fi

cd "$PROJECT"
exec bash scripts/start-vast-extension-test.sh "$PROJECT"
