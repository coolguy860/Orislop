# Copy this entire file into ONE Google Colab Python cell and run it.
# Upload the new Orislop Vast ZIP to /content first. Your trained weights remain
# in Google Drive; this launcher only extracts the small publisher from the ZIP.

from __future__ import annotations

from datetime import datetime, timezone
import getpass
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile


# ---- EDIT ONLY THESE VALUES -------------------------------------------------
DRIVE_ROOT = "/content/drive/MyDrive/orislop-checkpoints"
TEMPORAL_REPO = "gonnerthetooner/orislop-temporal-moe-promoted-v2"
AV_REPO = "gonnerthetooner/orislop-av-joint"
MAKE_REPOS_PUBLIC = False
AUTO_SELECT_TOP_PROMOTED = True
SKIP_AV_UPLOAD = False
# -----------------------------------------------------------------------------


def run(command: list[str], *, log_path: Path | None = None, **kwargs):
    print("\n[launcher] " + " ".join(command), flush=True)
    environment = kwargs.pop("env", None)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=environment,
        **kwargs,
    )
    captured: list[str] = []
    log_handle = None
    try:
        if log_path is not None:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_handle = log_path.open("x", encoding="utf-8")
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            captured.append(line)
            if len(captured) > 200:
                del captured[:50]
            if log_handle is not None:
                log_handle.write(line)
                log_handle.flush()
    finally:
        if log_handle is not None:
            log_handle.close()
    return_code = process.wait()
    if return_code:
        tail = "".join(captured[-40:]).strip()
        location = f" Full log: {log_path}" if log_path is not None else ""
        raise RuntimeError(
            f"Command exited {return_code}.{location}\n"
            f"----- child output tail -----\n{tail or '[child produced no output]'}"
        )
    return return_code


try:
    from google.colab import drive
except ImportError as error:
    raise RuntimeError("This one-cell launcher must run in Google Colab") from error

run([
    sys.executable,
    "-m",
    "pip",
    "install",
    "--quiet",
    "--disable-pip-version-check",
    "huggingface-hub>=0.34,<2",
    "safetensors>=0.4,<1",
])

script_name = "colab_find_and_publish_drive_models.py"
bundle_name = "orislop_launch_ready_vast_3090_full_stack_drive_hf_v6.zip"
bundle = Path("/content") / bundle_name
direct: list[Path] = []

if bundle.is_file():
    # Always bind to the exact uploaded bundle. A previous failed notebook cell
    # may have left an older publisher under /content, which must not be reused.
    extraction = Path(tempfile.mkdtemp(prefix="orislop_hf_publisher_v6-", dir="/content"))
    print(f"[launcher] extracting publisher from exact bundle {bundle}", flush=True)
    with zipfile.ZipFile(bundle) as archive:
        members = [
            member
            for member in archive.infolist()
            if Path(member.filename).name == script_name and not member.is_dir()
        ]
        if len(members) != 1:
            raise RuntimeError(
                f"Expected exactly one {script_name} in {bundle}; found {len(members)}."
            )
        member = members[0]
        if member.file_size > 2_000_000:
            raise RuntimeError(f"Refusing unexpectedly large publisher script: {member.file_size} bytes")
        target = extraction / script_name
        with archive.open(member) as source, target.open("xb") as destination:
            shutil.copyfileobj(source, destination)
    direct = [target]
else:
    direct_patterns = (
        script_name,
        f"*/scripts/{script_name}",
        f"*/*/scripts/{script_name}",
    )
    direct = sorted(
        {path for pattern in direct_patterns for path in Path("/content").glob(pattern)},
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not direct:
        raise FileNotFoundError(
            f"Upload the exact new bundle to /content/{bundle_name}, then rerun this cell."
        )

publisher = direct[0].resolve()
print(f"[launcher] publisher={publisher}", flush=True)

drive.mount("/content/drive", force_remount=False)
drive_root = Path(DRIVE_ROOT)
if not drive_root.is_dir():
    raise FileNotFoundError(
        f"Drive checkpoint root is missing: {drive_root}. Edit DRIVE_ROOT at the top of the cell "
        "if your models are in a different Drive folder."
    )
try:
    root_entries = sorted(path.name for path in drive_root.iterdir())
except OSError as error:
    raise RuntimeError(
        f"Drive is mounted but the checkpoint directory cannot be read: {drive_root}: {error}. "
        "Reconnect Drive with force_remount=True and rerun."
    ) from error
print(
    f"[launcher] Drive preflight passed: {drive_root}; top-level entries={len(root_entries)}; "
    f"first={root_entries[:20]}",
    flush=True,
)

hf_token = os.environ.get("HF_TOKEN", "").strip()
if not hf_token:
    try:
        from google.colab import userdata
        hf_token = (userdata.get("HF_TOKEN") or "").strip()
    except Exception:
        hf_token = ""
if not hf_token:
    hf_token = getpass.getpass("Paste a Hugging Face WRITE token (hidden): ").strip()
if not hf_token:
    raise RuntimeError("A Hugging Face write token is required")

child_environment = os.environ.copy()
child_environment["HF_TOKEN"] = hf_token
child_environment["PYTHONFAULTHANDLER"] = "1"
command = [
    sys.executable,
    "-u",
    str(publisher),
    "--drive-root",
    str(drive_root),
    "--temporal-repo",
    TEMPORAL_REPO,
    "--av-repo",
    AV_REPO,
]
if MAKE_REPOS_PUBLIC:
    command.append("--public")
if AUTO_SELECT_TOP_PROMOTED:
    command.append("--yes")
if SKIP_AV_UPLOAD:
    command.append("--skip-av")

try:
    log_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    run(
        command,
        env=child_environment,
        log_path=drive_root / f"HF_PUBLISH_LOG_{log_stamp}.log",
    )
finally:
    child_environment["HF_TOKEN"] = ""
    hf_token = ""

print(
    "\n[launcher] Done. Save the printed HF_PUBLISH_RECEIPT JSON and use its exact "
    "repo IDs, immutable revisions, and SHA-256 values in the Vast environment file.",
    flush=True,
)
