# Orislop AI Classifier v1

## What It Is

Orislop AI Classifier v1 is a lightweight local text/metadata classifier. It is not a multimodal detector and it does not inspect YouTube video pixels or audio.

The model learns from:

- title
- description/caption
- channel name
- transcript text when supplied
- duration bucket
- Shorts vs normal video

The dataset retains existing heuristic scores and matched signal names for auditing, but the classifier intentionally excludes them from training. The combined scorer already uses the heuristic result as its own weighted source; training on those labels would leak the same evidence into both inputs.

The exported runtime model is TF-IDF plus logistic regression. Inference is implemented manually in TypeScript/JavaScript using exported weights and a sigmoid.

## Files

- Seed dataset: `data/slop_training_seed.csv`
- Trainer: `scripts/train_ai_classifier_v1.py`
- Evaluation: `scripts/evaluate_ai_classifier_v1.py`
- Exported full model artifact: `models/orislop_ai_classifier_v1.json`
- Web inference: `apps/web/src/lib/aiClassifier.ts`
- Web combiner: `apps/web/src/lib/combinedScore.ts`
- Extension runtime copies: `apps/extension/src/contentScript.js`, `apps/extension/src/background.js`
- Evaluation report: `docs/AI_CLASSIFIER_V1_EVAL.md`

## Labels

The seed dataset supports:

- `reddit_story`
- `ai_voice`
- `repost_compilation`
- `scam_bait`
- `brainrot_format`
- `slop`
- `normal_educational`
- `normal_creator`
- `normal_entertainment`

Runtime output returns:

- `slopProbability` from 0 to 1
- `score` from 0 to 100
- `predictedLabel`
- `confidence`
- `topFeatures`

## Training

Run:

```powershell
pnpm run ai:train
```

This reads `data/slop_training_seed.csv` and writes `models/orislop_ai_classifier_v1.json`.

The trainer is dependency-free on purpose. It uses TF-IDF features and logistic regression trained with gradient descent so it works in restricted environments without scikit-learn installs.

## Evaluation

Run:

```powershell
pnpm run ai:evaluate
```

This writes `docs/AI_CLASSIFIER_V1_EVAL.md` with:

- accuracy
- precision
- recall
- F1
- confusion matrix
- false positives
- false negatives

False positives matter most for Orislop because a good video incorrectly classified as slop damages user trust. The report calls them out explicitly.

## Runtime Integration

The web analyzer runs:

1. heuristic score
2. AI Classifier v1 score
3. optional transcript score if transcript text is supplied
4. channel risk score
5. combined score

In the combined path, transcript rules are also a separate weighted source, so transcript text is withheld from the classifier invocation there. Standalone classifier inference still supports transcript input. This prevents the same transcript phrase from being counted twice.

The browser extension runs the same metadata classifier, then adds required Qwen and spatial/temporal inference through the selected local or authenticated cloud bridge. Heavy PyTorch inference runs outside Chrome.

## Limitations

- The 111-example seed dataset is small and intentionally not a production accuracy claim.
- YouTube metadata can be incomplete or delayed.
- The model can overfit seed labels.
- The static website cannot inspect YouTube video pixels or audio.
- Spatiotemporal inference is active in Orislop Shield 1.1 when the selected local or cloud detector bridge is available; it remains unavailable in the website's metadata analyzer.

Add more labeled rows to `data/slop_training_seed.csv`, retrain, evaluate false positives, then update runtime weights if the evaluation is acceptable.
