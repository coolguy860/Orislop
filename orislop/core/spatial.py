import os
import json
import numpy as np
from PIL import Image
from datetime import datetime

import torch
from transformers import pipeline, CLIPProcessor, CLIPModel

# =========================
# CONFIG
# =========================

BASE_DIR = "orislop_dataset"
AI_DIR = os.path.join(BASE_DIR, "AI")
REAL_DIR = os.path.join(BASE_DIR, "REAL")
UNCERTAIN_DIR = os.path.join(BASE_DIR, "UNCERTAIN")
LOG_FILE = os.path.join(BASE_DIR, "log.jsonl")

os.makedirs(AI_DIR, exist_ok=True)
os.makedirs(REAL_DIR, exist_ok=True)
os.makedirs(UNCERTAIN_DIR, exist_ok=True)

# decision thresholds
AI_THRESHOLD = 0.75
REAL_THRESHOLD = 0.25
AGREEMENT_STD = 0.20

# =========================
# STARTUP
# =========================

print("\n==============================")
print(" ORISLOP SPATIAL ENSEMBLE v1")
print("==============================\n")

# =========================
# MODELS (ONLY 3, CLEAN)
# =========================

print("Loading models...\n")

# 1. AI detector (primary classifier)
ai_detector = pipeline(
    "image-classification",
    model="umm-maybe/AI-image-detector"
)

# 2. Secondary ViT detector (same task, different learned biases)
vit_detector = pipeline(
    "image-classification",
    model="dima806/deepfake_vs_real_image_detection"
)

# 3. CLIP semantic realism judge
clip_model_id = "openai/clip-vit-base-patch32"
clip_processor = CLIPProcessor.from_pretrained(clip_model_id)
clip_model = CLIPModel.from_pretrained(clip_model_id)

device = "cuda" if torch.cuda.is_available() else "cpu"
clip_model.to(device)

TEXT = ["a real photograph", "an AI generated image"]

print("Models loaded.\n")

# =========================
# HELPERS
# =========================

def normalize(label, score):
    label = label.lower()
    score = float(score)
    return 1 - score if "real" in label else score


def predict_ai(img):
    out = ai_detector(img)[0]
    return normalize(out["label"], out["score"])


def predict_vit(img):
    out = vit_detector(img)[0]
    return normalize(out["label"], out["score"])


def predict_clip(img):
    inputs = clip_processor(
        text=TEXT,
        images=img,
        return_tensors="pt"
    ).to(device)

    with torch.no_grad():
        logits = clip_model(**inputs).logits_per_image[0]
        probs = logits.softmax(dim=0)

    return float(probs[1])

# =========================
# FUSION (STABLE RULE SYSTEM)
# =========================

def fuse(scores):
    mean = float(np.mean(scores))
    std = float(np.std(scores))

    if std < AGREEMENT_STD:
        if mean > AI_THRESHOLD:
            return "AI", mean, std
        if mean < REAL_THRESHOLD:
            return "REAL", mean, std

    return "UNCERTAIN", mean, std

# =========================
# SAVE + LOG
# =========================

def save_image(path, label):
    name = os.path.basename(path)

    if label == "AI":
        out = os.path.join(AI_DIR, name)
    elif label == "REAL":
        out = os.path.join(REAL_DIR, name)
    else:
        out = os.path.join(UNCERTAIN_DIR, name)

    try:
        from shutil import copy
        copy(path, out)
    except:
        pass


def log(path, scores, label, mean, std):
    entry = {
        "time": str(datetime.now()),
        "image": path,
        "scores": scores,
        "label": label,
        "mean": mean,
        "std": std
    }

    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")

# =========================
# MAIN LOOP (FIXED)
# =========================

print("READY — ENTER IMAGE PATHS\n")

while True:
    path = input("Image path (or exit): ").strip()

    if path.lower() == "exit":
        break

    if not os.path.exists(path):
        print("File not found.\n")
        continue

    try:
        img = Image.open(path).convert("RGB")

        s1 = predict_ai(img)
        s2 = predict_vit(img)
        s3 = predict_clip(img)

        scores = [s1, s2, s3]

        label, mean, std = fuse(scores)

        print("\n--- RESULTS ---")
        print("AI model :", round(s1, 3))
        print("ViT      :", round(s2, 3))
        print("CLIP     :", round(s3, 3))

        print("\nFINAL:", label)
        print("mean:", round(mean, 3), "std:", round(std, 3))

        save_image(path, label)
        log(path, scores, label, mean, std)

        print("Saved.\n")

    except Exception as e:
        print("ERROR:", e)