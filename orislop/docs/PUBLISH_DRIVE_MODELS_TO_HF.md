# Publish the promoted Google Drive models to Hugging Face

Use `scripts/COLAB_ONE_CELL_PUBLISH_DRIVE_MODELS.py` in Google Colab. Upload the
current Orislop Vast ZIP to `/content`, copy that complete file into one Python
cell, and run it.

The launcher mounts Drive, installs only the Hugging Face client and
Safetensors reader, extracts the publisher from the ZIP without expanding the
whole application, asks for a hidden HF write token, and runs one guarded
publish transaction.

The default search root is:

```text
/content/drive/MyDrive/orislop-checkpoints
```

The search ranks promotion-receipt matches above directory-name guesses, then
validation AUC and modification time. Before uploading, it:

- opens the selected final Temporal MoE weights;
- requires `micro`, `mid`, `long`, `extra_long`, `fusion`, and `temperature`;
- recognizes the weakest-first retrainer's promoted fusion/calibration delta and
  composes it with the four operational `stage1_*_best.pt` files only after
  their SHA-256 values match the cache fingerprints recorded by that promoted
  run;
- copies only deployment files, excluding datasets, optimizer state, logs, and
  unrelated checkpoints;
- searches for the five joint AV deployment artifacts;
- loads the AV TorchScript on CPU and requires its `mouth_tracks` contract;
- hashes staged files and writes artifact manifests;
- creates private HF model repos by default;
- verifies the immutable HF commit returned by each upload;
- writes a token-free `HF_PUBLISH_RECEIPT_*.json` back to Drive.

The training runs in Drive are immutable inputs. Composition occurs in a new
ephemeral `/tmp/orislop-hf-publish-*` directory. The publisher never deletes,
renames, replaces, or writes inside a model run. Diagnostic logs and receipts
use unique filenames and are created with exclusive-create semantics, so an
existing Drive file is never overwritten. Temporary cleanup targets only the
ephemeral runtime directory.

If the complete AV release is absent, the promoted Temporal MoE is still
published and the AV upload is explicitly skipped. This is not reported as a
full-stack release.

Do not put the HF write token in the source ZIP or a notebook variable. The
hidden prompt passes it only to the publisher child process and removes it from
the notebook environment afterward. Use a separate read token on Vast.

To inspect without uploading, extract the ZIP and run:

```bash
python scripts/colab_find_and_publish_drive_models.py \
  --drive-root /content/drive/MyDrive/orislop-checkpoints \
  --dry-run
```

The actual publisher intentionally refuses incomplete temporal packages,
unreadable TorchScript, missing hashes, invalid repository IDs, and unpinned HF
results. It does not delete or rewrite the trained originals in Google Drive.
