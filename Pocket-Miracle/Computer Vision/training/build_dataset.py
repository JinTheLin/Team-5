"""Build a YOLO dataset (door, stairs) from Open Images boxes + ROD stairs images.

usage: python training/build_dataset.py data/

Before running, put the Open Images door/stairs box rows in data/oi/ (the full CSVs are large, so keep only our two classes):
  mkdir -p data/oi && cd data/oi
  curl -sL https://storage.googleapis.com/openimages/v6/oidv6-train-annotations-bbox.csv | grep -E ",(/m/02dgv|/m/01lynh)," > train.boxes.csv
  curl -sL https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv | grep -E ",(/m/02dgv|/m/01lynh)," > validation.boxes.csv
  curl -sL https://storage.googleapis.com/openimages/v5/test-annotations-bbox.csv | grep -E ",(/m/02dgv|/m/01lynh)," > test.boxes.csv
Optional: ROD stairs images (Abtinzandi/Obstacle-Detection-Dataset-YOLO on Hugging Face) in data/rod/<split>/images and labels.
The images themselves are downloaded by this script from the public Open Images bucket and resized to 640 px.
"""
import csv, io, random, shutil, sys, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image

DATA = Path(sys.argv[1])          # folder holding oi/ (and optionally rod/)
OUT = DATA / "cane_ds"
CLASSES = {"/m/02dgv": 0, "/m/01lynh": 1}   # door, stairs
PER_CLASS_TRAIN = 2500
random.seed(0)


def load(split):
    imgs = defaultdict(list)
    bad = set()
    for r in csv.reader(open(DATA / f"oi/{split}.boxes.csv")):
        image, label = r[0], r[2]
        xmin, xmax, ymin, ymax = map(float, r[4:8])
        if r[11] == "1":  # IsDepiction: drawings, toys, photos of photos
            bad.add(image)
        imgs[image].append((CLASSES[label], (xmin + xmax) / 2, (ymin + ymax) / 2, xmax - xmin, ymax - ymin))
    return {k: v for k, v in imgs.items() if k not in bad}


def pick(imgs, per_class):
    chosen = set()
    for c in CLASSES.values():
        ids = sorted(k for k, v in imgs.items() if any(b[0] == c for b in v))
        random.shuffle(ids)
        chosen.update(ids[:per_class])
    return chosen


def fetch(job):
    split, oi_split, image, boxes = job
    img_path = OUT / split / "images" / f"oi_{image}.jpg"
    if img_path.exists():
        return True
    try:
        with urllib.request.urlopen(f"https://s3.amazonaws.com/open-images-dataset/{oi_split}/{image}.jpg", timeout=30) as r:
            im = Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception:
        return False
    im.thumbnail((640, 640))
    im.save(img_path, quality=90)
    (OUT / split / "labels" / f"oi_{image}.txt").write_text(
        "".join(f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n" for c, x, y, w, h in boxes))
    return True


def main():
    for s in ("train", "val"):
        (OUT / s / "images").mkdir(parents=True, exist_ok=True)
        (OUT / s / "labels").mkdir(parents=True, exist_ok=True)
    train = load("train")
    jobs = [("train", "train", i, train[i]) for i in pick(train, PER_CLASS_TRAIN)]
    for oi_split in ("validation", "test"):
        imgs = load(oi_split)
        jobs += [("val", oi_split, i, b) for i, b in imgs.items()]
    with ThreadPoolExecutor(32) as pool:
        ok = list(pool.map(fetch, jobs))
    print(f"Open Images: {sum(ok)}/{len(jobs)} downloaded")

    # ROD stairs images (class 4 = Stairs); keep only stairs boxes. ROD valid/test -> val.
    n = 0
    for split in ("train", "valid", "test"):
        for lbl in (DATA / "rod" / split / "labels").glob("*.txt"):
            img = lbl.with_name(lbl.stem + ".jpg").parent.parent / "images" / (lbl.stem + ".jpg")
            if not img.exists() or img.stat().st_size == 0:
                continue
            rows = [l.split() for l in lbl.read_text().splitlines() if l.split() and l.split()[0] == "4"]
            if not rows:
                continue
            dst = "train" if split == "train" else "val"
            shutil.copy(img, OUT / dst / "images" / f"rod_{img.name}")
            (OUT / dst / "labels" / f"rod_{lbl.name}").write_text("".join("1 " + " ".join(r[1:5]) + "\n" for r in rows))
            n += 1
    print(f"ROD stairs images added: {n}")
    (OUT / "data.yaml").write_text(f"path: {OUT}\ntrain: train/images\nval: val/images\nnames:\n  0: door\n  1: stairs\n")
    for s in ("train", "val"):
        counts = [0, 0]
        for f in (OUT / s / "labels").glob("*.txt"):
            for l in f.read_text().splitlines():
                counts[int(l.split()[0])] += 1
        print(s, "images", len(list((OUT / s / "images").glob("*.jpg"))), "door boxes", counts[0], "stairs boxes", counts[1])


if __name__ == "__main__":
    main()
