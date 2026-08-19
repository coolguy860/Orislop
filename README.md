# Orislop

**Reclaim your old feed.**

Orislop is an AI-powered browser extension that detects and automatically skips repetitive, synthetic, low-effort, and low-originality content on short-form platforms.

Instead of blocking social media entirely, Orislop changes what users see inside their existing feeds.

> **Current status:** Active prototype under development. Models, classifications, and platform integrations are still being tested and improved.

## Complete-stack GPU test release

The `orislop/` directory now contains the v1.3 complete-stack test source: the
browser extension, detector bridge, adaptive Heavy scheduler with first-run GPU
autotuning, temporal MoE and AV/lip-sync integration, Ollama integration,
training/evaluation utilities, Vast launchers, and private SSH-tunnel tests.

- Start with [`orislop/START_HERE_TESTING.md`](orislop/START_HERE_TESTING.md).
- GPU deployment details are in [`orislop/VAST_RTX3090_DEPLOY.md`](orislop/VAST_RTX3090_DEPLOY.md).
- The exact complete model release is pinned to private Hugging Face revision
  `gonnerthetooner/orislop-complete-stack-v1@09f0510580de5a8c11393adc7d7905ab40b200ab`.
- Large upstream/model weights are materialized and hash-verified at startup;
  they are intentionally not duplicated in Git history.

For the first live test, keep detector port `4317` private, connect through the
packaged SSH tunnel, run the CUDA/component smoke check, and then submit a real
Heavy video with `orislop/scripts/test-extension-bridge.ps1`.

---

## The problem

Short-form feeds are increasingly filled with:

* Recycled compilations
* AI-generated videos
* Synthetic narration
* Text-to-speech content
* Engagement bait
* Repetitive editing formats
* Reposts with unclear attribution
* Low-effort “brainrot” content
* Videos optimized for retention rather than value

Most existing tools respond by blocking the entire platform or limiting screen time.

Orislop takes a different approach: **keep the platform, filter the feed.**

---

## What Orislop does

Orislop analyzes short-form videos as users scroll and classifies them into categories such as:

* **Watch**
* **Questionable**
* **Skip**

Based on the selected strictness level, Orislop can automatically move past content that matches the user’s filtering preferences.

Users remain in control. Skipped videos are not permanently hidden, and users can scroll backward to view them.

---

## Supported platforms

Orislop is being designed for:

* YouTube Shorts
* TikTok
* Instagram Reels
* LinkedIn video and AI-generated posts

Platform support is still evolving, and individual integrations may be at different levels of completeness.

---

## Core features

* Automatic short-form content detection
* Configurable filtering strictness
* Automatic skipping
* Scroll-back support
* Per-signal classification explanations
* Recent flagged-content history
* Look-ahead video scanning
* Pre-classification of upcoming videos
* Platform-specific adapters
* Local inference support
* Optional heavier model analysis
* Fail-closed analyzer behavior
* Maximum-skip protection
* Scroll-loop prevention
* Privacy-focused local controls

---

## How it works

Orislop is built as a multimodal detection system rather than a single binary classifier.

Each video can be evaluated using several specialized signal groups.

### Temporal analysis

The temporal model analyzes how a video changes over time.

It uses multiple expert branches focused on different time scales:

* Micro-term patterns
* Mid-term patterns
* Long-term patterns
* Extra-long-term patterns

The outputs are fused and calibrated into a final temporal score.

### Spatial analysis

Spatial analysis examines individual frames for visual patterns associated with synthetic, repetitive, heavily templated, or low-originality content.

### Audio analysis

Audio models can inspect:

* Synthetic voices
* Text-to-speech patterns
* Reused audio
* Narration structure
* Low-information or repetitive sound design

### Audio-video synchronization

Orislop can use audiovisual synchronization signals to identify content where the visible speaker, mouth movement, and audio may not naturally align.

### Provenance and repost signals

Future versions may incorporate:

* Perceptual hashes
* Audio fingerprints
* Video embeddings
* Creator grouping
* Repost similarity
* Source and attribution signals

No single signal determines the final result. Scores are combined to reduce false positives and produce a more useful classification.

---

## Architecture

```text
Short-form platform
        │
        ▼
Platform adapter
        │
        ▼
Active video detection
        │
        ├── Look-ahead scanner
        ├── Metadata extraction
        └── Media extraction
        │
        ▼
Inference adapter
        │
        ├── Temporal model
        ├── Spatial model
        ├── Audio model
        ├── AV-sync model
        └── Provenance signals
        │
        ▼
Score fusion and calibration
        │
        ▼
Watch / Questionable / Skip
        │
        ▼
Extension UI and skip controller
```

The browser layer handles platform interaction, navigation observation, scoring display, and skip behavior.

The inference layer handles model execution, score normalization, signal fusion, and classification.

---

## Built with OpenAI Codex

Codex was used extensively throughout Orislop’s development as an engineering agent.

It was not used to decide what Orislop should become. The product concept, detection strategy, architecture, model direction, filtering philosophy, and roadmap were developed through human direction and iteration.

Codex helped turn those decisions into working software faster.

### How Codex contributed

Codex was used for:

* Generating initial implementations
* Refactoring large sections of the codebase
* Connecting extension components
* Building platform adapters
* Debugging navigation and scrolling behavior
* Implementing skip-controller safeguards
* Improving TypeScript structure
* Creating tests and fixtures
* Auditing code for security and reliability issues
* Reviewing model integration code
* Tracing failures across multiple files
* Cleaning up duplicated or overengineered logic
* Producing implementation plans before large changes
* Checking changes against the intended architecture
* Accelerating repetitive engineering work

### Human-directed, agent-accelerated

The development loop generally looked like this:

1. Define the product behavior or technical objective.
2. Break the objective into components and constraints.
3. Use Codex to inspect the existing repository.
4. Ask Codex to propose or implement a change.
5. Run the code and test the behavior.
6. Review failures, regressions, and unnecessary complexity.
7. Have Codex revise the implementation.
8. Manually validate whether the result matched the product intent.

Codex significantly increased development speed, especially for repo-wide changes that would otherwise require manually tracing many interconnected files.

However, generated code was not automatically assumed to be correct. It still required testing, review, debugging, and architectural judgment.

> Orislop is not “vibe-coded” software where generated code is accepted blindly. Codex is treated as an engineering tool, not as the product owner.

---

## Technology stack

### Application

* JavaScript
* TypeScript
* Node.js
* Electron
* Chrome Extension APIs
* HTML5
* CSS3
* pnpm

### Machine learning

* Python
* PyTorch
* CUDA
* BF16 inference and training
* Computer vision
* Audio processing
* Video analysis
* Multimodal machine learning
* Local inference adapters

### Infrastructure and development

* GitHub
* Vercel
* OpenAI Codex
* Automated testing
* Model calibration
* Dataset pipelines

---

## Repository structure

The exact structure may change as the project is reorganized, but the main system includes components for:

```text
orislop/
├── extension/              # Browser extension interface and platform logic
├── desktop/                # Electron application and local runtime
├── inference/              # Model and inference adapters
├── models/                 # Temporal and multimodal model components
├── platform-adapters/      # YouTube, TikTok, Instagram, and other integrations
├── tests/                  # Unit, integration, and behavior tests
├── web/                    # Web analyzer and project site
└── scripts/                # Training, evaluation, and development utilities
```

Refer to the current repository tree for the latest organization.

---

## Development setup

### Requirements

Install the following before running the project:

* Node.js
* pnpm
* Python
* Git
* A Chromium-based browser

CUDA-compatible hardware may be required for some model-training or accelerated-inference workflows.

### Clone the repository

```bash
git clone https://github.com/coolguy860/orislop.git
cd orislop
```

### Install JavaScript dependencies

```bash
pnpm install
```

### Run the available development scripts

Check the root and package-specific `package.json` files for the currently supported commands.

Common commands may include:

```bash
pnpm dev
pnpm build
pnpm test
pnpm lint
```

Script names may change while the repository is being consolidated.

### Load the browser extension

1. Build the extension package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the generated extension directory.

Some detection features may require the local inference service or desktop application to be running.

---

## Model development

The long-term model architecture is intended to combine:

```text
Temporal score
+ Spatial score
+ Audio score
+ AV-sync score
+ Repost and provenance score
+ User preference signals
= Final classification
```

The current system is still being trained and calibrated.

Early internal testing has shown meaningful improvement over earlier prototypes, but those results should not be interpreted as a public benchmark. A larger, cleaner, creator-separated, and manually verified evaluation set is still required.

---

## Dataset strategy

One of the hardest parts of building Orislop is creating a useful dataset.

“Slop” is not one objective visual class. It can depend on:

* Originality
* Repetition
* Editing style
* Audio structure
* Source attribution
* Synthetic generation
* Context
* User preference

The dataset pipeline is being designed around:

* Real short-form feed content
* Human-reviewed labels
* Multiple content categories
* Creator-level train/test separation
* Perceptual deduplication
* Audio fingerprinting
* Embedding-based similarity checks
* Held-out generation methods
* Label-quality audits
* False-positive analysis

Detector-generated labels are not treated as ground truth without additional verification. Otherwise, a new model would simply inherit the assumptions and mistakes of the old model.

---

## Privacy

Orislop is being designed around data minimization.

The intended architecture prioritizes:

* Local inference where practical
* Limited data retention
* User-visible classifications
* Clear filtering reasons
* User control over strictness
* Optional rather than hidden feedback collection

Cloud inference may be used when a model is too computationally expensive to run locally, but the goal is to avoid collecting unnecessary user data.

The privacy model is still under development and should be reviewed before any public production release.

---

## Current limitations

Orislop is an experimental prototype.

Known limitations include:

* False positives
* False negatives
* Platform interface changes
* Slow inference on some hardware
* Incomplete multimodal fusion
* Limited labeled training data
* Subjective classification boundaries
* Differences between users’ definitions of low-value content
* Possible breakage when platforms change their page structure

Orislop should not be presented as a perfect or universal judge of content quality.

---

## Roadmap

### Detection

* Complete spatial detector
* Expand audio classification
* Improve AV-sync detection
* Add repost and similarity detection
* Improve score calibration
* Reduce false positives
* Build stronger evaluation datasets
* Add uncertainty-aware classifications

### Product

* Improve YouTube Shorts support
* Improve TikTok support
* Improve Instagram Reels support
* Expand LinkedIn filtering
* Add clearer signal explanations
* Improve strictness controls
* Build personalized filtering profiles
* Add user feedback and correction tools

### Infrastructure

* Optimize lightweight local inference
* Add optional cloud escalation
* Improve model caching
* Reduce analysis latency
* Harden platform adapters
* Expand automated testing
* Improve release and update workflows

### Long term

* Android support
* iOS exploration
* Cross-platform feed controls
* Personalized content-quality models
* User-controlled recommendation layers
* Tools for evaluating AI-generated media
* A broader intelligence layer between users and algorithmic feeds

---

## Vision

Orislop’s long-term goal is larger than skipping annoying videos.

Algorithmic feeds decide what billions of people spend their attention on, but users have very little control over the logic behind those decisions.

Orislop aims to become a user-controlled intelligence layer between people and their feeds.

The platform recommends.

**The user decides.**

---

## Contributing

Orislop is still in active development, and the repository may change substantially.

Useful contribution areas include:

* Browser-extension engineering
* Platform adapters
* Computer vision
* Audio classification
* AV synchronization
* Model optimization
* Dataset tooling
* Privacy engineering
* Testing
* UX design
* Adversarial evaluation

Before submitting a major change, open an issue describing:

* The problem
* The proposed implementation
* Affected components
* Privacy implications
* Expected testing approach

---

## Responsible use

Orislop should not be used to secretly profile creators, discriminate against protected groups, or make high-stakes decisions about individuals.

Content classification is probabilistic and can be wrong.

The system should remain:

* User-controlled
* Reversible
* Explainable
* Privacy-conscious
* Open to correction

---

## License

This project is protected under a strict proprietary license.

All rights are reserved. You are **not permitted** to copy, reproduce, distribute, modify, sublicense, or use any part of this repository, its code, models, datasets, or documentation without explicit written permission from the author.

Unauthorized use, duplication, or redistribution of this project or any of its components is strictly prohibited and may result in legal action.

Third-party models, datasets, libraries, and media may have separate licenses that must also be followed.

---

## Contact

Project: **Orislop**

Website: **orislop.com**

GitHub: **github.com/coolguy860/orislop**

---

**Reclaim your old feed.**
