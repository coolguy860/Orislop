# Orislop spatial fusion v2

Version 2 replaces the unsaved/random ViT pooler used by the legacy checkpoint
with the deterministic pretrained CLS token. Legacy `fusion_model_final.pt`
weights are intentionally incompatible and are rejected by the runtime.

1. Extract each Parquet split with `scripts/extract_spatial_parquet.py`.
2. Train with `training/orislop_spatial/train_fusion_v2.py`, passing disjoint
   train, validation, and test manifests.
3. Upload `fusion_model_cls_v2.pt` to `gonnerthetooner/orislop-fusion`.

Temperature and the automatic-hide operating threshold are selected only from
the validation split. The test split is evaluated once with that frozen
operating point.

The locally packaged checkpoint was trained with 2,592 train images, calibrated
with 288 validation images, and evaluated on 320 untouched test images. Its
test ROC-AUC is 0.9315. At the validation-selected 0.1%-FPR operating target it
produced 0/152 genuine false positives and 87/168 fake detections. The
validation set contains only 137 genuine examples, so a much larger shadow set
is still required before claiming that the true false-positive rate is 0.1%.
