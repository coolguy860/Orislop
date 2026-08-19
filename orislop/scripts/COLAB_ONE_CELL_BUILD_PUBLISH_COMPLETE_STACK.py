# Paste this whole file into one Google Colab cell after uploading the v10 ZIP.
# It mounts Drive read-only from the publisher's perspective, proves artifact
# coherence, stages the full release in /content, and uploads one private HF repo.

from collections import deque
from pathlib import Path
import getpass
import os
import subprocess
import sys
import tempfile
import zipfile


def run(command, **kwargs):
    command = [str(value) for value in command]
    printable = ["***" if index and command[index - 1] in {"--token"} else value for index, value in enumerate(command)]
    print("\n[launcher]", " ".join(map(str, printable)), flush=True)
    log_path = Path("/content/orislop-complete-stack-publisher.log")
    tail = deque(maxlen=120)
    environment = dict(os.environ)
    environment["PYTHONUNBUFFERED"] = "1"
    environment.update(kwargs.pop("env", {}))
    with log_path.open("a", encoding="utf-8") as log:
        log.write("\n[launcher] " + " ".join(map(str, printable)) + "\n")
        log.flush()
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
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            log.write(line)
            log.flush()
            tail.append(line.rstrip())
        return_code = process.wait()
    if return_code:
        recent = "\n".join(tail)
        raise RuntimeError(
            f"Child command failed with exit code {return_code}. "
            f"Full combined output: {log_path}\n\nLast output:\n{recent}"
        )
    return subprocess.CompletedProcess(command, return_code)


archives = sorted(
    Path("/content").glob("orislop_complete_stack_hf_v10*.zip"),
    key=lambda path: path.stat().st_mtime,
    reverse=True,
)
if not archives:
    raise FileNotFoundError("Upload orislop_complete_stack_hf_v10.zip to /content first")
archive = archives[0]
extract_root = Path(tempfile.mkdtemp(prefix="orislop-complete-builder-", dir="/content"))
print(f"[launcher] bundle={archive}", flush=True)
with zipfile.ZipFile(archive) as zipped:
    root = extract_root.resolve()
    for member in zipped.infolist():
        target = (extract_root / member.filename).resolve()
        if not target.is_relative_to(root):
            raise RuntimeError(f"Unsafe ZIP member: {member.filename}")
    zipped.extractall(extract_root)

publishers = list(extract_root.rglob("colab_build_publish_complete_stack.py"))
if len(publishers) != 1:
    raise RuntimeError(f"Expected one complete-stack publisher, found {publishers}")
publisher = publishers[0]

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

import huggingface_hub
import safetensors
print(
    f"[launcher] huggingface_hub={huggingface_hub.__version__} "
    f"safetensors={safetensors.__version__}",
    flush=True,
)

from google.colab import drive
drive.mount("/content/drive")

if not os.environ.get("HF_TOKEN"):
    os.environ["HF_TOKEN"] = getpass.getpass("HF write token (input hidden): ").strip()
if not os.environ["HF_TOKEN"]:
    raise RuntimeError("HF_TOKEN is required")

from huggingface_hub import HfApi
identity = HfApi(token=os.environ["HF_TOKEN"]).whoami()
print(f"[launcher] authenticated HF account={identity.get('name', '<unknown>')}", flush=True)

repo = os.environ.get("ORISLOP_COMPLETE_STACK_REPO", "gonnerthetooner/orislop-complete-stack-v1")
drive_root = os.environ.get("ORISLOP_DRIVE_CHECKPOINT_ROOT", "/content/drive/MyDrive/orislop-checkpoints")
run([
    sys.executable,
    "-u",
    str(publisher),
    "--drive-root",
    drive_root,
    "--repo",
    repo,
    "--yes",
])
