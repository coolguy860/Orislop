from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import os


REQUIRED = ("config.json", "metrics.json")
WEIGHTS = ("final_model.safetensors", "final_model.pt")
OPTIONAL = ("threshold.json", "README.md", "training_log.jsonl", "PROMOTION_RECEIPT.json")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a reproducible integrity manifest for an Orislop temporal package")
    parser.add_argument("package", type=Path)
    parser.add_argument("--promotion-receipt", type=Path, default=None)
    args = parser.parse_args()
    package = args.package.expanduser().resolve()
    if not package.is_dir():
        raise SystemExit(f"Package directory does not exist: {package}")
    for name in REQUIRED:
        if not (package / name).is_file():
            raise SystemExit(f"Required file is missing: {package / name}")
    weights = next((package / name for name in WEIGHTS if (package / name).is_file()), None)
    if weights is None:
        raise SystemExit("Package needs final_model.safetensors or final_model.pt")
    if args.promotion_receipt:
        receipt = args.promotion_receipt.expanduser().resolve()
        if not receipt.is_file():
            raise SystemExit(f"Promotion receipt does not exist: {receipt}")
        (package / "PROMOTION_RECEIPT.json").write_bytes(receipt.read_bytes())
    names = [weights.name, *REQUIRED, *OPTIONAL]
    files = {
        name: sha256_file(package / name)
        for name in names
        if (package / name).is_file()
    }
    payload = {
        "schemaVersion": 1,
        "artifactType": "orislop-promoted-temporal-package",
        "files": dict(sorted(files.items())),
    }
    target = package / "artifact_manifest.json"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=package, suffix=".tmp") as temporary:
        json.dump(payload, temporary, indent=2, sort_keys=True)
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, target)
    print(json.dumps({"manifest": str(target), "weights": weights.name, "weightsSha256": files[weights.name]}, indent=2))


if __name__ == "__main__":
    main()
