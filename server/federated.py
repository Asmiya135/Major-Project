"""
Federated learning on the server.

1. Fusion-engine FL (FedAvg): each car trains the fusion engine's logistic-regression
   weights on its *own* driver-verified samples and uploads only the weights (never the
   raw yes/no data). The server averages them, weighted by sample count, evaluates the
   result on the verified reports it holds, and publishes a new model version that
   every car downloads.

2. Detector fine-tune (optional): the driver-verified photos uploaded with MEDIUM→confirmed
   reports become a YOLO dataset; Head-1 is fine-tuned on it and the new weights are
   offered to cars as a detector update.
"""
import math
import shutil
import threading
import traceback

import config
import db


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))


def score(weights, bias, signals: dict) -> float:
    z = bias + sum(w * float(signals.get(f, 0.0)) for w, f in zip(weights, config.FL_FEATURES))
    return _sigmoid(z)


def evaluate_on_verified(weights, bias) -> dict:
    """Server-side performance measure: how the model scores driver-confirmed hazards."""
    verified = [r for r in db.list_reports(limit=10000, verified_only=True) if isinstance(r["signals"], dict)]
    if not verified:
        return {"verified_samples": 0}
    scores = [score(weights, bias, r["signals"]) for r in verified]
    return {
        "verified_samples": len(scores),
        "mean_score_on_verified": round(sum(scores) / len(scores), 4),
        "recall_at_high": round(sum(s >= config.FUSION_HIGH for s in scores) / len(scores), 4),
        "recall_at_medium": round(sum(s >= config.FUSION_MEDIUM for s in scores) / len(scores), 4),
    }


def current_model() -> dict:
    m = db.latest_model()
    det = db.latest_ready_detector()
    return {
        "version": m["version"],
        "features": config.FL_FEATURES,
        "weights": m["weights"],
        "bias": m["bias"],
        "metrics": m["metrics"],
        "created_at": m["created_at"],
        "thresholds": {"high": config.FUSION_HIGH, "medium": config.FUSION_MEDIUM},
        "detector_version": det["version"] if det else 0,
    }


def aggregate(force: bool = False) -> dict:
    """FedAvg over every pending client update. Returns the new model (or a reason it didn't run)."""
    pending = db.pending_updates()
    if not pending or (len(pending) < config.FL_MIN_UPDATES and not force):
        return {"aggregated": False, "pending": len(pending), "reason": "not enough client updates"}

    total = sum(max(1, u["n_samples"]) for u in pending)
    n_f = len(config.FL_FEATURES)
    w = [0.0] * n_f
    b = 0.0
    loss = acc = 0.0
    for u in pending:
        share = max(1, u["n_samples"]) / total
        for i in range(n_f):
            w[i] += share * float(u["weights"][i])
        b += share * float(u["bias"])
        lm = u.get("local_metrics") or {}
        loss += share * float(lm.get("loss", 0.0))
        acc += share * float(lm.get("accuracy", 0.0))

    prev = db.latest_model()
    version = prev["version"] + 1
    w = [round(x, 5) for x in w]
    metrics = {
        "fedavg_clients": len({u["client_id"] for u in pending}),
        "fedavg_updates": len(pending),
        "fedavg_samples": total,
        "client_weighted_accuracy": round(acc, 4),
        "client_weighted_loss": round(loss, 4),
        "server_eval": evaluate_on_verified(w, b),
        "server_eval_previous": evaluate_on_verified(prev["weights"], prev["bias"]),
    }
    db.insert_model(version, w, round(b, 5), metrics, len(pending), total, 0)
    db.mark_updates_aggregated([u["id"] for u in pending], version)
    return {"aggregated": True, "model": current_model()}


# ── Detector fine-tune on verified photos ──────────────────────────────────

_job_lock = threading.Lock()


def _build_dataset() -> int:
    """Write verified (and HIGH-confidence) photos + their bounding boxes as a YOLO dataset."""
    if config.DATASET_DIR.exists():
        shutil.rmtree(config.DATASET_DIR)
    n = 0
    for split in ("train", "val"):
        (config.DATASET_DIR / "images" / split).mkdir(parents=True, exist_ok=True)
        (config.DATASET_DIR / "labels" / split).mkdir(parents=True, exist_ok=True)

    for r in db.list_reports(limit=10000):
        if r["hazard_type"] not in config.DETECTOR_CLASSES or not r["image_file"]:
            continue
        if not (r["verified"] or r["routing"] == "HIGH"):
            continue
        img = config.IMAGES_DIR / r["image_file"]
        bbox, fw, fh = r["bbox"], r["frame_w"], r["frame_h"]
        if not img.exists() or not bbox or len(bbox) != 4 or not fw or not fh:
            continue
        x1, y1, x2, y2 = bbox
        cls = config.DETECTOR_CLASSES.index(r["hazard_type"])
        line = f"{cls} {((x1 + x2) / 2) / fw:.6f} {((y1 + y2) / 2) / fh:.6f} {(x2 - x1) / fw:.6f} {(y2 - y1) / fh:.6f}\n"
        for split in ("train", "val"):   # tiny demo set: validate on the same images
            shutil.copy(img, config.DATASET_DIR / "images" / split / img.name)
            (config.DATASET_DIR / "labels" / split / (img.stem + ".txt")).write_text(line)
        n += 1

    (config.DATASET_DIR / "data.yaml").write_text(
        f"path: {config.DATASET_DIR.as_posix()}\ntrain: images/train\nval: images/val\n"
        f"names: {config.DETECTOR_CLASSES}\n")
    return n


def _train_detector(version: int):
    try:
        n = _build_dataset()
        db.upsert_detector_job(version, n_images=n)
        if n < config.DETECTOR_MIN_SAMPLES:
            db.upsert_detector_job(version, status="failed", finished_at=db.now_iso(),
                                   error=f"need ≥{config.DETECTOR_MIN_SAMPLES} labelled photos, have {n}")
            return
        from ultralytics import YOLO
        prev = db.latest_ready_detector()
        base = config.MODELS_DIR / prev["weights_file"] if prev else config.BASE_DETECTOR
        model = YOLO(str(base))
        results = model.train(
            data=str(config.DATASET_DIR / "data.yaml"), epochs=config.DETECTOR_EPOCHS,
            imgsz=config.DETECTOR_IMGSZ, batch=4, device="cpu", workers=0, plots=False,
            project=str(config.MODELS_DIR / "runs"), name=f"v{version}", exist_ok=True, verbose=False,
        )
        best = config.MODELS_DIR / "runs" / f"v{version}" / "weights" / "best.pt"
        out = config.MODELS_DIR / f"detector_v{version}.pt"
        shutil.copy(best, out)
        rd = getattr(results, "results_dict", {}) or {}
        metrics = {k.replace("metrics/", ""): round(float(v), 4) for k, v in rd.items() if isinstance(v, (int, float))}
        db.upsert_detector_job(version, status="ready", weights_file=out.name, metrics=metrics,
                               finished_at=db.now_iso())
    except Exception as e:
        traceback.print_exc()
        db.upsert_detector_job(version, status="failed", error=str(e), finished_at=db.now_iso())
    finally:
        _job_lock.release()


def start_detector_training() -> dict:
    if not _job_lock.acquire(blocking=False):
        return {"started": False, "reason": "a training job is already running"}
    jobs = db.list_detector_jobs()
    version = (jobs[0]["version"] + 1) if jobs else 1
    db.upsert_detector_job(version, status="training", started_at=db.now_iso())
    threading.Thread(target=_train_detector, args=(version,), daemon=True).start()
    return {"started": True, "version": version}
