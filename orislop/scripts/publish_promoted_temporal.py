from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


REQUIRED = ("config.json", "metrics.json")
WEIGHTS = ("final_model.safetensors", "final_model.pt")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Publish the promoted Orislop temporal package to a pinned private Hugging Face model repo"
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(os.environ.get(
            "ORISLOP_PROMOTED_TEMPORAL_SOURCE",
            "/content/drive/MyDrive/orislop-checkpoints/orislop-a100-full-v2-retrain-v2-aggressive/temporal/final_model_package",
        )),
    )
    parser.add_argument("--repo-id", default=os.environ.get("ORISLOP_TEMPORAL_TARGET_REPO", ""))
    parser.add_argument("--token", default=os.environ.get("HF_TOKEN", ""))
    parser.add_argument("--promotion-receipt", type=Path, default=None)
    parser.add_argument("--public", action="store_true", help="Create a public repo; private is the safe default")
    args = parser.parse_args()

    if not args.repo_id or "/" not in args.repo_id:
        raise SystemExit("Set --repo-id owner/repository or ORISLOP_TEMPORAL_TARGET_REPO")
    if not args.token:
        raise SystemExit("Set HF_TOKEN to a write-scoped Hugging Face token")
    source = args.source.expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"Promoted package does not exist: {source}")
    for required in REQUIRED:
        if not (source / required).is_file():
            raise SystemExit(f"Required model-package file is missing: {source / required}")
    weights = next((source / name for name in WEIGHTS if (source / name).is_file()), None)
    if weights is None:
        raise SystemExit("The promoted package has no final_model.safetensors or final_model.pt")

    try:
        from huggingface_hub import HfApi, create_repo
    except ImportError as error:
        raise SystemExit("Install huggingface-hub first: pip install 'huggingface_hub>=0.34,<2'") from error

    with tempfile.TemporaryDirectory(prefix="orislop-promoted-") as temporary:
        stage = Path(temporary) / "final_model_package"
        shutil.copytree(source, stage)
        if args.promotion_receipt:
            receipt = args.promotion_receipt.expanduser().resolve()
            if not receipt.is_file():
                raise SystemExit(f"Promotion receipt does not exist: {receipt}")
            shutil.copy2(receipt, stage / "PROMOTION_RECEIPT.json")
        files = {
            path.relative_to(stage).as_posix(): sha256_file(path)
            for path in stage.rglob("*")
            if path.is_file() and path.name != "artifact_manifest.json"
        }
        manifest = {
            "schemaVersion": 1,
            "artifactType": "orislop-promoted-temporal-package",
            "files": dict(sorted(files.items())),
        }
        (stage / "artifact_manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        create_repo(
            repo_id=args.repo_id,
            repo_type="model",
            private=not args.public,
            exist_ok=True,
            token=args.token,
        )
        info = HfApi(token=args.token).upload_folder(
            repo_id=args.repo_id,
            repo_type="model",
            folder_path=str(stage),
            path_in_repo="final_model_package",
            commit_message="Publish promoted Orislop temporal package",
        )
        revision = str(getattr(info, "oid", "") or "")
        weight_sha = files[weights.name]
        print(json.dumps({
            "repoId": args.repo_id,
            "private": not args.public,
            "revision": revision,
            "weightsFile": weights.name,
            "weightsSha256": weight_sha,
            "env": {
                "ORISLOP_TEMPORAL_HF_REPO_ID": args.repo_id,
                "ORISLOP_TEMPORAL_HF_REVISION": revision,
                "ORISLOP_TEMPORAL_HF_SUBDIR": "final_model_package",
                "ORISLOP_TEMPORAL_MODEL_SHA256": weight_sha,
                "ORISLOP_TEMPORAL_ROLLOUT": "shadow",
            },
        }, indent=2))


if __name__ == "__main__":
    main()
