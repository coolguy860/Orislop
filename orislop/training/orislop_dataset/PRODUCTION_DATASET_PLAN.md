# Orislop production dataset plan

Status: approved for a 100-pair pilot after contracts and generator reviews are
signed. Scaling beyond the pilot is conditional on the gates in this document.
This is an engineering policy, not legal advice.

## Corpus definition

A sample is one independently cataloged 2-30 second media clip. Multiple clips
from one master share `source_asset_id`; every original, benign variant, and
synthetic derivative shares `group_id`. The same source, creator, person, face,
voice, or scene stays in one split regardless of whether recordings differ.

The production target is approximately 20,000 reviewed samples:

- Core: 5,000 genuine and 5,000 manipulated/fully synthetic samples.
- Safety: at least 10,000 additional genuine samples, used only for the sealed
  false-hide evaluation.

The initial genuine acquisition quota is:

- 2,500 controlled or directly creator-licensed samples.
- 1,500 individually reviewed Wikimedia CC0/CC BY samples.
- 1,000 individually reviewed government or institutional samples.

These are minimum acquisition buckets, not blanket source approvals. Every row
must pass the same per-item rights and provenance checks. Safety samples must be
independent of core sources, identities, creators, voices, and scenes.

The corpus must also represent the content Orislop encounters in scrolling
feeds. At minimum it contains 3,500 genuine and 3,500 synthetic/manipulated
short-form core clips plus 7,000 short-form genuine safety clips. At least 3,000
clips per core class and 6,000 safety clips are vertical. YouTube Shorts,
TikTok-feed, and Instagram-Reels contexts each contribute at least 750 clips per
core class and 1,500 safety clips, with at least ten distinct content styles
overall. These are context tags, not acquisition methods: the media must still
come from creator masters, controlled captures, or separately licensed files.

## Rights and provenance gates

Every training or safety row requires:

- structured `rights_evidence` explicitly approving download, commercial ML
  training, derivatives, and distribution of the trained model;
- a complete `rights_review` with reviewer, timestamp, and approval ID;
- verified `label_evidence` from capture records, creator attestations, approved
  ground truth, archive provenance, or generation logs;
- a separate complete `provenance_review`;
- an approved acquisition method;
- explicit classification of whether an identifiable real person appears.
- `content_profile`, and for short-form feed clips, reviewed feed context,
  visual format, content-style tags, and a 2-30 second clip duration.

Human visual judgment and detector predictions are never ground truth. Rights
and label evidence are independent: proof that a clip is synthetic does not
grant permission to train on it.

When an identifiable performer appears, the release must explicitly cover
adult participation, biometric processing, commercial ML training, retention,
and trained-model distribution. Synthetic derivatives additionally require
specific consent for synthetic media and, as applicable, face manipulation or
voice cloning. Celebrity or non-consenting identities are excluded.

Social-platform post URLs are reference metadata only. Orislop does not scrape
or download YouTube, TikTok, Instagram, or Facebook media. Creators must provide
a local master or an authorized direct file that does not resolve through the
platform. Pexels and Pixabay require separate written ML agreements and are not
counted under their standard licenses.

## Authenticity and transformation taxonomy

The binary Temporal MoE label remains `0=genuine`, `1=synthetic`, but every row
also records:

- `authenticity_label`: `genuine`, `manipulated`, or `fully_synthetic`;
- `media_origin`: camera capture, traditional animation, conventional CGI,
  conventional VFX, AI generated, or hybrid;
- `transformation_types`: benign and synthetic operations as separate tags;
- `sync_status`: synchronized, legitimate dub, accidental delay, manipulated
  sync, or not applicable.

Compression, crops, resizing, filters, captions, screen recordings, and ordinary
audio compression never change a genuine label. Legitimate dubbing and ordinary
delay remain genuine with the appropriate sync status. Conventional animation,
CGI, and VFX are included as genuine/non-AI negative controls.

## Generator approval

`generator_registry.json` is the source of truth. A permissive code license does
not clear weights, dependencies, training data, inputs, performer likenesses, or
outputs. Every production generation log requires:

- generator and family identifiers;
- code/weight/service license evidence;
- an archived provider-terms snapshot;
- a checkpoint SHA-256 or SaaS model version plus request ID;
- approved generator and output-rights reviews;
- parameters, seeds when available, and input/source linkage;
- a provenance review and verified generation log.

Open Wav2Lip is prohibited for commercial Orislop data. Sync Labs requires an
appropriate commercial dataset contract. DeepFaceLab is conditional on a full
component and performer audit. Runway and Stability checkpoints remain
conditional on exact versioned terms and input/output review.

At least two commercially approved generator families are reserved entirely for
the final core test. They never appear in training or validation.

## Split and evaluation discipline

Global leakage components are built before batching. Train, validation, and
test are assigned by component, not by individual file.

- Train fits model parameters.
- Validation selects architecture, calibration, and thresholds.
- Core test is run only after model and thresholds are frozen.
- Held-out generator families are test-only.
- The genuine safety corpus is test-only and never tunes thresholds.

The production automatic-hide gate is at most 0.1% false hides on at least
10,000 independent genuine safety samples. Synthetic/manipulated recall,
precision, PR-AUC, calibration, latency, generator breakdowns, and benign-edit
breakdowns are reported separately. Demographic analysis uses only consented,
self-reported or otherwise lawfully provided aggregate attributes; Orislop does
not infer protected traits from faces.

## Rolling four-worker execution

The global split is divided into leakage-safe raw batches capped at 50 GiB.
Four workers acquire disjoint batches, verify hashes, prepare the same temporal
views, and run identical frozen expert checkpoints. Each durable expert cache
must include matching checkpoint fingerprints and `BATCH_COMPLETE.json` before
raw staging data can be removed.

Worker outputs are never averaged as four independent models. One final job
merges compatible expert caches and performs one fusion/calibration run. This
cached-feature workflow updates fusion and calibration, not every expert
backbone. End-to-end backbone retraining requires retaining raw/precomputed
tensors until synchronized distributed gradients have been incorporated.

When source media is already hosted on authorized web endpoints,
`hf_web_ingest.py` replaces Drive with a private Hugging Face dataset. Workers
use ephemeral storage, upload verified per-batch media and manifests, publish a
completion marker last, and clean the local batch only after remote
verification. Quarantine ingestion never promotes provisional web metadata into
production ground truth.

## Rollout gates

1. Pilot: 100 genuine masters plus 100 synthetic derivatives.
2. Scale 1: 1,000 pairs after zero rights-gate failures and successful leakage
   tests.
3. Scale 2: 5,000 core pairs only after the acquisition, rejection, generation,
   and review unit economics are measured.
4. Safety: acquire and seal at least 10,000 additional genuine samples.
5. Production: release only after integrity, calibration, latency, recall, and
   false-hide gates pass.

Budgeting is based on cost per approved clip, synthetic derivative, rights
review, creator/identity, generation retry, and rejected candidate. Corporate
finished-video pricing is not used to estimate short dataset captures.
