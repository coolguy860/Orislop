"""PyInstaller entry point for the Windows Local Fast companion."""

import os
from pathlib import Path
import sys


def bundled_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))


ROOT = bundled_root()
BRIDGE_ROOT = ROOT / "apps" / "detector-bridge"
sys.path.insert(0, str(BRIDGE_ROOT))

environment_path = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Orislop" / ".env.local"
if environment_path.is_file():
    for raw_line in environment_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())

os.environ.setdefault("ORISLOP_DETECTOR_HOST", "127.0.0.1")
os.environ.setdefault("ORISLOP_DETECTOR_PORT", "4317")
os.environ.setdefault("ORISLOP_CLOUD_HEAVY_ENABLED", "0")
os.environ.setdefault("ORISLOP_PRELOAD_HEAVY_MODE", "0")

from server import main


if __name__ == "__main__":
    main()
