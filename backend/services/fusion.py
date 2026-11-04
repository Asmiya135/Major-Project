"""
Model 4 — Fusion engine.

Combines every head's signal into one hazard score with a logistic model:
    score = sigmoid(bias + Σ wᵢ · signalᵢ)
Signals (all 0–1): detection confidence, tracking persistence, segmentation area,
depth estimate, on-road flag, optical-flow consistency, IMU bump.

The weights are not fixed: they are the parameters trained by federated learning.
Each car fine-tunes them on its driver-verified samples, uploads only the weights,
and downloads the server's FedAvg result (a new version) on every sync.
"""
import json
import math
import threading

import config

_lock = threading.Lock()


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))


class FusionEngine:
    def __init__(self):
        self.features = list(config.FUSION_FEATURES)
        self.weights = list(config.FUSION_INITIAL_WEIGHTS)
        self.bias = config.FUSION_INITIAL_BIAS
        self.version = 1
        self.detector_version = 0
        self.metrics: dict = {}
        self.source = "initial"
        self._load()

    # ── persistence ──────────────────────────────────────────────────────
    def _load(self):
        f = config.FUSION_WEIGHTS_FILE
        if f.exists():
            try:
                d = json.loads(f.read_text())
                if len(d["weights"]) == len(self.features):
                    self.weights, self.bias = d["weights"], d["bias"]
                    self.version = d.get("version", 1)
                    self.detector_version = d.get("detector_version", 0)
                    self.metrics = d.get("metrics", {})
                    self.source = d.get("source", "server")
            except (ValueError, KeyError):
                pass

    def _save(self):
        config.FUSION_WEIGHTS_FILE.write_text(json.dumps(self.describe(), indent=2))

    def describe(self) -> dict:
        return {
            "version": self.version, "features": self.features, "weights": self.weights,
            "bias": self.bias, "metrics": self.metrics, "source": self.source,
            "detector_version": self.detector_version,
            "thresholds": {"high": config.FUSION_HIGH_THRESHOLD, "medium": config.FUSION_MEDIUM_THRESHOLD},
        }

    def apply_global(self, model: dict) -> bool:
        """Install a newer FedAvg model from the server. Returns True if it changed."""
        with _lock:
            if model.get("version", 0) <= self.version:
                return False
            self.weights = [float(w) for w in model["weights"]]
            self.bias = float(model["bias"])
            self.version = int(model["version"])
            self.metrics = model.get("metrics", {})
            self.source = "server-fedavg"
            self._save()
            return True

    # ── inference ────────────────────────────────────────────────────────
    def score(self, signals: dict) -> dict:
        contribs = []
        z = self.bias
        for f, w in zip(self.features, self.weights):
            v = float(signals.get(f, 0.0))
            c = w * v
            z += c
            contribs.append({"signal": f, "value": round(v, 3), "weight": round(w, 3), "contribution": round(c, 3)})
        s = _sigmoid(z)
        if s >= config.FUSION_HIGH_THRESHOLD:
            routing = "HIGH"
        elif s >= config.FUSION_MEDIUM_THRESHOLD:
            routing = "MEDIUM"
        else:
            routing = "DISCARD"
        return {"score": round(s, 4), "logit": round(z, 3), "bias": round(self.bias, 3),
                "contributions": contribs, "routing": routing, "model_version": self.version}

    # ── local federated training ─────────────────────────────────────────
    def train_local(self, samples: list) -> dict:
        """
        FedProx: gradient descent on binary cross-entropy plus μ/2·‖w − w_global‖², starting from the global weights.
        Does NOT replace the live weights — the server's FedAvg result does that.
        """
        X = [[float(s["features"].get(f, 0.0)) for f in self.features] for s in samples]
        y = [int(s["label"]) for s in samples]
        w = list(self.weights)
        b = self.bias
        n = len(X)
        for _ in range(config.FL_LOCAL_EPOCHS):
            gw = [0.0] * len(w)
            gb = 0.0
            for xi, yi in zip(X, y):
                p = _sigmoid(b + sum(wj * xj for wj, xj in zip(w, xi)))
                err = p - yi
                for j, xj in enumerate(xi):
                    gw[j] += err * xj
                gb += err
            # FedProx proximal term keeps a small local dataset from dragging the model far from the global one
            w = [wj - config.FL_LR * (g / n + config.FL_PROX_MU * (wj - w0))
                 for wj, g, w0 in zip(w, gw, self.weights)]
            b -= config.FL_LR * (gb / n + config.FL_PROX_MU * (b - self.bias))

        def evaluate(ww, bb):
            loss = acc = 0.0
            for xi, yi in zip(X, y):
                p = min(1 - 1e-6, max(1e-6, _sigmoid(bb + sum(a * c for a, c in zip(ww, xi)))))
                loss += -(yi * math.log(p) + (1 - yi) * math.log(1 - p))
                acc += int((p >= config.FUSION_MEDIUM_THRESHOLD) == bool(yi))
            return round(loss / n, 4), round(acc / n, 4)

        loss0, acc0 = evaluate(self.weights, self.bias)
        loss1, acc1 = evaluate(w, b)
        return {
            "weights": [round(v, 5) for v in w], "bias": round(b, 5), "n_samples": n,
            "local_metrics": {"loss": loss1, "accuracy": acc1, "loss_before": loss0,
                              "accuracy_before": acc0, "positives": sum(y), "negatives": n - sum(y)},
        }


engine = FusionEngine()
