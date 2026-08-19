# Model provenance and release gate

Orislop records machine-readable component provenance in `configs/model_provenance.json`.
The frozen spatial backbones, supporting public frame detector, and AEGIS motion branch have pinned revisions, hashes, and recorded licenses. The current
Orislop spatial training dataset does not yet have enough source and rights documentation
for a commercial production release, so public cloud filtering must remain in `shadow` mode.

Shadow mode still runs the detectors and reports `wouldSkip` diagnostics, but the extension
keeps the video visible. Local loopback development uses `testing` mode by default so the
filtering path can be exercised without weakening the public deployment default.

Promotion to the unlisted aggressive beta first requires the separate calibration and validation split gate in `configs/cloud_heavy_v1.json`. Public promotion to `corroborated` mode additionally requires all of the following:

1. Document each training-data source, its license or grant, redistribution rights, and any
   subject-consent requirements.
2. Record at least 10,000 representative shadow decisions, including platform, language,
   latency, predicted result, and reviewed ground truth.
3. Demonstrate a genuine automatic-hide rate no greater than 0.1%, end-to-end recall of at
   least 90%, and acceptable calibration on held-out generators and genuine sources.
4. Sign off and update `automaticVisualFilteringEligible` only after the evidence is reviewed.

Do not change the cloud rollout mode merely to make the release check pass.
