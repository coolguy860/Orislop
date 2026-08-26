# Orislop extension testing package

This package connects the unpacked Chrome extension to the complete pinned Orislop stack on a Vast GPU. The model repository is not duplicated in this ZIP: the Vast launcher downloads and verifies the exact private Hugging Face revision before it starts.

## What is pinned

- Model: `gonnerthetooner/orislop-complete-stack-v1@09f0510580de5a8c11393adc7d7905ab40b200ab`
- Published inventory: 494 files, 2,794,404,210 bytes
- Extension ID: `nhkffdhagjignajnmlgkgekpkfljhfdd`
- Extension origin: `chrome-extension://nhkffdhagjignajnmlgkgekpkfljhfdd`
- Detector endpoint: `http://127.0.0.1:4317`

The extension ZIP defaults new installs to Local + Heavy so testing reaches the complete spatial, motion, promoted temporal MoE, AV/lip-sync, and local Qwen paths. Automatic hiding is deliberately enabled for this private test profile. This is not a production calibration claim.

The 1.3 launcher enables first-run autotuning on top of the adaptive execution scheduler. The first representative Heavy video benchmarks every layout allowed by live VRAM, then saves the fastest output-equivalent winner. Independent branches overlap only while sufficient VRAM is free; CUDA OOM triggers a safe retry. See `AUTOTUNE_README.md` and `TURBO_EXECUTION.md` for settings and telemetry.

## 1. Start the complete stack on Vast

Upload and extract this outer package on a Vast NVIDIA instance. Do **not** expose port 4317 in Vast. Then run:

```bash
chmod +x scripts/start-vast-extension-test.sh
./scripts/start-vast-extension-test.sh
```

The launcher prompts for a Hugging Face read token if `HF_TOKEN` is not already set. It installs runtime dependencies, downloads the immutable model revision, hashes every manifest file, preloads Heavy models, and stays attached to the services. Keep that terminal open.

Optional evidence keys can be exported before launch:

```bash
export BRAVE_SEARCH_API_KEY='your-key'
export GOOGLE_FACT_CHECK_API_KEY='your-key'
```

Those keys are optional for model/extension testing. Without one, source-backed fact checks show as limited while visual, temporal, AV, text, and Ollama inference still run.

## 2. Open the private tunnel from Windows

In the extracted package on Windows, use the SSH host and port shown by Vast:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-extension-test-tunnel.ps1 -SshTarget "root@YOUR_VAST_HOST" -SshPort YOUR_VAST_SSH_PORT
```

Add `-IdentityFile "C:\path\to\key"` when the instance uses a private key. Keep this PowerShell window open. The tunnel maps only local `127.0.0.1:4317` to Vast's loopback service.

In a second PowerShell window, prove the bridge is both ready and private:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-extension-bridge.ps1
```

## 3. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select `apps/extension/dist` from this extracted package.
5. Confirm Chrome shows extension ID `nhkffdhagjignajnmlgkgekpkfljhfdd`.
6. Open the Orislop popup. Leave inference on **Local** and performance on **Heavy**.
7. Test YouTube, Instagram, TikTok, or LinkedIn while both launcher and tunnel remain open.

`dist/orislop-browser-extension.zip` is the standalone extension artifact, but Chrome developer mode still expects it to be extracted before **Load unpacked**.

## Honest testing boundary

The packaged static and unit checks prove build integrity, exact revision pinning, the deterministic extension origin, direct-test isolation, and the extension/bridge contracts. They do not replace a live GPU video test in your Vast instance or prove real-world accuracy on videos outside the training distribution. Record false positives and false negatives during the test rather than treating the validation AUC as production accuracy.
