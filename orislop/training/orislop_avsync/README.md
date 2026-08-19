# Orislop AV-sync training on Google Colab

This package trains a lightweight audio-visual expert that measures whether a visible speaker's mouth motion is synchronized with the video's audio. It exports a CPU/GPU-portable TorchScript model, calibrated abstention thresholds, quality gates, and metadata for Orislop fusion.

The model is **not** a standalone deepfake detector. A mismatch can also come from dubbing, editing, Bluetooth delay, reposting, dropped frames, or an off-screen speaker. Orislop must combine its result with the spatial and temporal experts before an automatic Skip.

## Open the notebook

Upload or open [`orislop_avsync_colab.ipynb`](orislop_avsync_colab.ipynb) in Google Colab, select a GPU runtime, and run the cells from top to bottom.

The notebook uses these commands under the hood:

```bash
python training/orislop_avsync/train_avsync.py build-manifest ...
python training/orislop_avsync/train_avsync.py prepare ...
python training/orislop_avsync/train_avsync.py train ...
python training/orislop_avsync/train_avsync.py evaluate ...
python training/orislop_avsync/train_avsync.py export ...
```

## Dataset layout

Place short, legally usable video clips in Google Drive:

```text
MyDrive/orislop-avsync/data/
├── aligned/
│   ├── speaker-001/
│   │   ├── clip-001.mp4
│   │   └── clip-002.mp4
│   └── speaker-002/
│       └── clip-001.mp4
├── mismatched/
│   ├── speaker-101/
│   │   └── manipulated-001.mp4
│   └── speaker-102/
│       └── manipulated-001.mp4
├── uncertain/                 # optional gate-testing clips
└── not_applicable/            # optional: voice-over, silence, closed/hidden lips
```

Use one folder per speaker or identity. The manifest builder assigns the entire speaker folder to one split, preventing the model from seeing the same identity in training and evaluation. If files are placed directly under a label folder, the part of the filename before `__` is treated as the group.

Labels mean:

- `aligned`: authentic, synchronized visible speech.
- `mismatched`: genuinely manipulated or deliberately desynchronized audio/video.
- `uncertain`: speech is visible but quality is too poor to make a reliable decision. These clips audit the gates and are not used as binary training labels.
- `not_applicable`: no suitable visible active speaker—for example voice-over, closed lips, an obscured face, or silence. These are not fake labels.

The trainer also creates shifted-audio and cross-speaker negatives from aligned clips. Those augmentations are useful, but they do not replace real manipulation examples.

## Data requirements

For a pipeline smoke test, a few dozen clips per binary class are enough. For a detector that might influence real users, use thousands of diverse clips across identities, skin tones, ages, camera types, resolutions, languages, codecs, frame rates, and noise conditions.

Important hard negatives include:

- legitimate dubbing and translations;
- reaction videos and voice-over/B-roll;
- video calls with ordinary lag;
- Bluetooth and broadcast delay;
- music, shouting, laughter, profile faces, masks, and facial hair;
- multiple people, scene cuts, compression, and dropped frames.

Keep the test identities and source videos completely separate from training. Never tune thresholds against the test set.

## Output states

At inference, deterministic gates run before the neural model:

1. Too little visible face, speech, mouth motion, or duration → `not_applicable`.
2. Usable visible speech but very noisy audio → `uncertain`.
3. Model probability below the calibrated safe boundary → `aligned`.
4. Model probability above the high-precision boundary → `mismatched`.
5. Probability between both boundaries → `uncertain`.

The default face extractor follows the largest centered face using OpenCV and works best on one-speaker clips. A production multi-person pipeline should put an active-speaker model such as TalkNet in front of this model and pass the selected face track into the same input contract.

## Check a video after training

```bash
python training/orislop_avsync/train_avsync.py predict \
  --video /content/example.mp4 \
  --checkpoint /content/drive/MyDrive/orislop-avsync/runs/best.pt \
  --thresholds /content/drive/MyDrive/orislop-avsync/runs/validation.json
```

The result includes the state, mismatch probability, gate reasons, and measured quality. If the lips remain closed, the result is `not_applicable` and the neural model is not called.

## Export and Hugging Face

The export folder contains:

- `orislop_avsync.ts`: TorchScript inference artifact;
- `orislop_avsync.json`: input/output contract, calibration and SHA-256 hash;
- `README.md`: short runtime warning.

To upload, store `HF_TOKEN` in Colab Secrets and enable the final notebook cell. The suggested private model repository is `gonnerthetooner/orislop-avsync`. Review the model card, dataset licenses, privacy policy, and measured false-positive rates before making it public.

## Local smoke test

```powershell
.\.venv-detector\Scripts\python.exe training\orislop_avsync\train_avsync.py self-test
```

This exercises the forward pass, gradients, closed-lip gate, TorchScript export, reload and output contract without downloading a model or dataset.
