"""
On-car (client-side) hazard pipeline. Every model runs on the car; only confirmed hazards
leave it. One call to process_frame() runs these steps and emits an annotated image +
metrics after each one so the demo UI can show every head working:

   1  Capture & AKS        Model 1 — speed-based capture rate + duplicate-frame filter
   2  Dehaze / low-light   Model 2 — AOD-Net applied only when the frame is hazy or dark
   3  Privacy              faces + number plates blurred before anything is stored or sent
   4  H4 Road mask         Fast-SCNN: road vs pavement → on-road / off-road per hazard
   5  H3 Depth             MiDaS monocular depth → pothole depth estimate
   6  H2 Segmentation      YOLOv8-seg potholes + real-world width / length / area / distance
   7  H1 Detection         YOLO potholes, speed bumps, debris (fills H2 gaps, confirms H2)
   8  H5 Stalled vehicles  YOLO11 + SORT tracking + optical-flow stationarity
   9  Motion signals       Farneback optical flow + IMU bump
  10  Fusion engine        Model 4 — logistic fusion of all signals (FL-trained weights)
  11  Alert routing        Model 5/6 — HIGH → server/queue + Bluetooth; MEDIUM → driver verify
"""
import base64
import math
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import config
from services.edge_state import state, capture_policy, project
from services.fusion import engine

for _p in [str(config.FAST_SCNN_DIR), str(config.STALLED_DIR)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

# ── Lazy model holders ─────────────────────────────────────────────────────
_head1 = _head2 = _midas = _midas_tx = _road_model = _head5_det = None
_face_sess = _face_in = _face_out = _plate_model = _dehaze = None
_head1_path = None
_loaded = False
_load_lock = threading.Lock()
_infer_lock = threading.Lock()      # one frame through the models at a time

VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "motorbike"}


def _load_models():
    global _head1, _head2, _midas, _midas_tx, _road_model, _head5_det
    global _face_sess, _face_in, _face_out, _plate_model, _dehaze, _loaded, _head1_path
    with _load_lock:
        if _loaded:
            return
        _loaded = True

        def _try(label, fn):
            try:
                fn()
                print(f"[Pipeline] {label} ✓")
            except Exception as e:  # noqa: BLE001
                print(f"[Pipeline] {label} SKIP — {e}")

        def _h1():
            global _head1, _head1_path
            from ultralytics import YOLO
            local = config.LOCAL_MODELS_DIR / f"detector_v{engine.detector_version}.pt"
            path = local if engine.detector_version and local.exists() else config.HEAD1_MODEL
            _head1, _head1_path = YOLO(str(path)), path
        _try("H1 detection", _h1)

        def _h2():
            global _head2
            from ultralytics import YOLO
            _head2 = YOLO(str(config.HEAD2_SEG_MODEL))
        _try("H2 segmentation", _h2)

        def _h3():
            global _midas, _midas_tx
            import torch
            m = torch.hub.load("intel-isl/MiDaS", "MiDaS_small", trust_repo=True)
            m.load_state_dict(torch.load(str(config.HEAD3_DEPTH_MODEL), map_location="cpu"))
            m.eval()
            _midas = m
            _midas_tx = torch.hub.load("intel-isl/MiDaS", "transforms", trust_repo=True).small_transform
        _try("H3 MiDaS depth", _h3)

        def _h4():
            global _road_model
            import torch
            from fast_scnn import FastSCNN
            m = FastSCNN(num_classes=19)
            m.load_state_dict(torch.load(str(config.HEAD4_ROAD_MODEL), map_location="cpu"))
            m.eval()
            _road_model = m
        _try("H4 Fast-SCNN road", _h4)

        def _h5():
            global _head5_det
            from ultralytics import YOLO
            _head5_det = YOLO(str(config.HEAD5_DET_MODEL))
        _try("H5 vehicle detector", _h5)

        def _face():
            global _face_sess, _face_in, _face_out
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            s = ort.InferenceSession(str(config.FACE_ONNX_MODEL), sess_options=opts,
                                     providers=["CPUExecutionProvider"])
            _face_sess, _face_in, _face_out = s, s.get_inputs()[0].name, s.get_outputs()[0].name
        _try("Privacy face", _face)

        def _plate():
            global _plate_model
            from ultralytics import YOLO
            _plate_model = YOLO(str(config.PLATE_PT_MODEL))
        _try("Privacy plate", _plate)

        def _dh():
            global _dehaze
            import torch
            import torch.nn as nn

            class _AOD(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.relu = nn.ReLU(inplace=True)
                    self.e_conv1 = nn.Conv2d(3, 3, 1, 1, 0, bias=True)
                    self.e_conv2 = nn.Conv2d(3, 3, 3, 1, 1, bias=True)
                    self.e_conv3 = nn.Conv2d(6, 3, 5, 1, 2, bias=True)
                    self.e_conv4 = nn.Conv2d(6, 3, 7, 1, 3, bias=True)
                    self.e_conv5 = nn.Conv2d(12, 3, 3, 1, 1, bias=True)

                def forward(self, x):
                    x1 = self.relu(self.e_conv1(x))
                    x2 = self.relu(self.e_conv2(x1))
                    x3 = self.relu(self.e_conv3(torch.cat([x1, x2], 1)))
                    x4 = self.relu(self.e_conv4(torch.cat([x2, x3], 1)))
                    x5 = self.relu(self.e_conv5(torch.cat([x1, x2, x3, x4], 1)))
                    return self.relu((x5 * x) - x5 + 1)
            net = _AOD()
            net.load_state_dict(torch.load(str(config.DEHAZE_MODEL), map_location="cpu"))
            net.eval()
            _dehaze = net
        _try("Dehaze AOD-Net", _dh)
        print("[Pipeline] model loading complete")


def swap_detector(path: Path):
    """Hot-swap H1 with a fine-tuned detector downloaded from the server (federated update)."""
    global _head1, _head1_path
    from ultralytics import YOLO
    m = YOLO(str(path))
    with _infer_lock:
        _head1, _head1_path = m, path


def model_status() -> dict:
    return {
        "h1_detection": _head1 is not None, "h1_weights": Path(_head1_path).name if _head1_path else None,
        "h2_segmentation": _head2 is not None, "h3_depth": _midas is not None,
        "h4_road_mask": _road_model is not None, "h5_stalled": _head5_det is not None,
        "privacy_face": _face_sess is not None, "privacy_plate": _plate_model is not None,
        "dehazing": _dehaze is not None, "models_loaded": _loaded,
    }


def warmup():
    threading.Thread(target=_load_models, daemon=True).start()


# ── Drawing helpers ────────────────────────────────────────────────────────

def _enc(img, quality=75) -> str:
    import cv2
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf.tobytes()).decode()


def _jpeg(img, quality=88) -> bytes:
    import cv2
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()


def _small(img, w=560):
    import cv2
    h, cw = img.shape[:2]
    return img if cw <= w else cv2.resize(img, (w, int(h * w / cw)))


def _panel(img, lines, color=(255, 255, 255), origin=(8, 8)):
    """Semi-transparent info box in the top-left corner."""
    import cv2
    out = img.copy()
    if not lines:
        return out
    scale = max(0.45, img.shape[1] / 1400)
    lh = int(22 * scale / 0.5)
    w = max(cv2.getTextSize(l, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)[0][0] for l in lines) + 16
    h = lh * len(lines) + 10
    x, y = origin
    roi = out[y:y + h, x:x + w]
    if roi.size:
        out[y:y + h, x:x + w] = (roi * 0.35).astype(roi.dtype)
    for i, line in enumerate(lines):
        cv2.putText(out, line, (x + 8, y + lh * (i + 1)), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)
    return out


def _tag(img, bbox, lines, color):
    """Box + multi-line label with a filled background, placed above (or inside) the box."""
    import cv2
    x1, y1, x2, y2 = map(int, bbox)
    th = max(2, img.shape[1] // 400)
    cv2.rectangle(img, (x1, y1), (x2, y2), color, th)
    scale = max(0.42, img.shape[1] / 1600)
    lh = int(20 * scale / 0.45)
    w = max(cv2.getTextSize(l, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)[0][0] for l in lines) + 10
    h = lh * len(lines) + 6
    ty = y1 - h if y1 - h > 0 else y1
    tx = min(max(0, x1), max(0, img.shape[1] - w))
    cv2.rectangle(img, (tx, ty), (tx + w, ty + h), color, -1)
    for i, line in enumerate(lines):
        cv2.putText(img, line, (tx + 5, ty + lh * (i + 1) - 2), cv2.FONT_HERSHEY_SIMPLEX, scale,
                    (0, 0, 0), 1, cv2.LINE_AA)
    return img


def _canon(name: str) -> str:
    n = name.lower().replace(" ", "_")
    if "pothole" in n:
        return "pothole"
    if "bump" in n or "speed" in n:
        return "speed_bump"
    if "debris" in n:
        return "debris"
    return n


def _lane(bbox, w) -> str:
    cx = (bbox[0] + bbox[2]) / 2 / max(1, w)
    return "Left lane" if cx < 0.33 else ("Center lane" if cx < 0.67 else "Right lane")


def _iou(a, b):
    from services.session_state import iou
    return iou(a, b)


# ── Measurement helpers ────────────────────────────────────────────────────

def _ground_metrics(bbox, w, h, fill=1.0) -> dict:
    """
    Flat-road pinhole model: a pixel row y below the horizon y_h sees the road at
    distance Z = f·H / (y − y_h). Gives distance, width (m), length (m) and area (m²).
    """
    f = (w / 2) / math.tan(math.radians(config.CAM_HFOV_DEG / 2))
    yh = config.HORIZON_FRAC * h

    def z_at(y):
        dy = y - yh
        return config.MAX_RANGE_M if dy <= 1 else min(config.MAX_RANGE_M, f * config.CAM_HEIGHT_M / dy)

    x1, y1, x2, y2 = bbox
    z_near = z_at(y2)
    z_far = z_at(max(y1, yh + 2))
    width = min(8.0, (x2 - x1) * z_near / f)
    length = min(10.0, max(0.05, z_far - z_near))
    return {"distance_m": round(z_near, 1), "width_m": round(width, 2), "length_m": round(length, 2),
            "area_m2": round(width * length * fill, 2)}


def _severity(htype, depth_cm, area_m2) -> str:
    if htype == "stalled_vehicle":
        return "high"
    if htype == "speed_bump":
        return "medium"
    if depth_cm >= 8 or area_m2 >= 0.5:
        return "high"
    if depth_cm >= 4 or area_m2 >= 0.2:
        return "medium"
    return "low"


def _region_stats(mask_bool, road, sidewalk, depth_n):
    """on-road ratio, pavement ratio and depth contrast (mask vs surrounding ring) for one hazard."""
    import cv2
    import numpy as np
    area = int(mask_bool.sum())
    out = {"on_road_ratio": None, "pavement_ratio": None, "depth_contrast": None}
    if area == 0:
        return out
    if road is not None:
        k = np.ones((15, 15), np.uint8)
        out["on_road_ratio"] = round(float(np.logical_and(mask_bool, cv2.dilate(road, k) > 0).sum() / area), 3)
        out["pavement_ratio"] = round(float(np.logical_and(mask_bool, sidewalk > 0).sum() / area), 3)
    if depth_n is not None:
        m8 = mask_bool.astype(np.uint8)
        ring = cv2.dilate(m8, np.ones((31, 31), np.uint8)) - m8
        if ring.sum() > 0:
            out["depth_contrast"] = round(float(min(1.0, abs(depth_n[ring > 0].mean() - depth_n[mask_bool].mean()) * 4)), 3)
    return out


# ── Main entry ─────────────────────────────────────────────────────────────

def process_frame(frame_bgr, sess, emit, session_id: str = "") -> dict:
    """Runs on a worker thread. emit(dict) pushes step messages to the UI."""
    import cv2
    import numpy as np

    _load_models()
    tel = state.telemetry
    h, w = frame_bgr.shape[:2]
    policy = capture_policy(tel.speed_kmh)

    def run_step(n, name, fn):
        emit({"type": "step_start", "step": n, "name": name})
        t0 = time.time()
        status, data = fn()
        emit({"type": "step_result", "step": n, "name": name, "status": status,
              "duration_ms": int((time.time() - t0) * 1000), "data": data})

    # ── 1. Capture & AKS ────────────────────────────────────────────────
    small = cv2.cvtColor(cv2.resize(frame_bgr, (320, int(320 * h / w))), cv2.COLOR_BGR2GRAY)
    prev_small = sess.prev_small
    diff = float(np.mean(cv2.absdiff(prev_small, small))) if prev_small is not None and prev_small.shape == small.shape else None
    is_dup = diff is not None and diff < config.AKS_DUP_THRESHOLD
    forced = is_dup and sess.consecutive_skips >= config.AKS_MAX_CONSECUTIVE_SKIPS
    process = (not is_dup) or forced
    if process:
        sess.consecutive_skips = 0
        sess.frames_processed += 1
    else:
        sess.consecutive_skips += 1
        sess.frames_skipped_dup += 1
    decision = ("PROCESS (first frame)" if diff is None else
                "PROCESS (forced keyframe)" if forced else
                "PROCESS (new content)" if process else "SKIP (duplicate)")

    def s1():
        img = _panel(frame_bgr, [
            f"Speed {tel.speed_kmh:.0f} km/h -> target {policy['target_fps']} fps",
            f"  ({policy['reason']})",
            f"Measured capture rate: {sess.measured_fps()} fps",
            f"Change vs last processed: {'-' if diff is None else f'{diff:.1f}'} (dup < {config.AKS_DUP_THRESHOLD})",
            f"Decision: {decision}",
        ], color=(80, 255, 80) if process else (80, 160, 255))
        return ("processed" if process else "skipped"), {
            "speed_kmh": tel.speed_kmh, "target_fps": policy["target_fps"], "policy": policy["reason"],
            "measured_capture_fps": sess.measured_fps(), "frame_change": None if diff is None else round(diff, 2),
            "duplicate_threshold": config.AKS_DUP_THRESHOLD, "decision": decision,
            **sess.stats(), "images": {"capture": _enc(_small(img))},
        }
    run_step(1, "Capture & AKS", s1)
    if not process:
        return {"routing": "AKS_SKIP", "fusion_score": 0.0, "hazard_type": None, "severity": "none",
                "candidates": 0, "actions": [], "stats": sess.stats()}

    flow = None
    if prev_small is not None and prev_small.shape == small.shape:
        flow = cv2.calcOpticalFlowFarneback(prev_small, small, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    sess.prev_small = small

    with _infer_lock:
        return _infer(frame_bgr, sess, emit, run_step, flow, policy, session_id)


def _infer(frame_bgr, sess, emit, run_step, flow, policy, session_id):
    import cv2
    import numpy as np
    tel = state.telemetry
    h, w = frame_bgr.shape[:2]
    ctx = {}

    # ── 2. Dehaze / low light (only when needed) ────────────────────────
    def s2():
        f = frame_bgr.astype(np.float32) / 255.0
        dark = cv2.erode(f.min(axis=2), np.ones((15, 15), np.uint8))
        haze = float(dark.mean())
        bright = float(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY).mean() / 255.0)
        reasons = []
        if haze > config.HAZE_DARK_CHANNEL_T:
            reasons.append(f"hazy (dark-channel {haze:.2f} > {config.HAZE_DARK_CHANNEL_T})")
        if bright < config.LOW_LIGHT_T:
            reasons.append(f"low light (brightness {bright:.2f} < {config.LOW_LIGHT_T})")
        out = frame_bgr
        if reasons and _dehaze is not None:
            import torch
            work = _small(frame_bgr, 640)            # AOD-Net at 640 px keeps this step real-time
            t = torch.from_numpy(cv2.cvtColor(work, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)).float().unsqueeze(0) / 255.0
            with torch.no_grad():
                o = _dehaze(t).clamp(0, 1).squeeze(0).numpy().transpose(1, 2, 0)
            out = cv2.resize(cv2.cvtColor((o * 255).astype(np.uint8), cv2.COLOR_RGB2BGR), (w, h))
            if bright < config.LOW_LIGHT_T:
                lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)
                lab[:, :, 0] = cv2.createCLAHE(2.5, (8, 8)).apply(lab[:, :, 0])
                out = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        ctx["frame"] = out
        applied = bool(reasons) and _dehaze is not None
        label = ["Dehaze APPLIED: " + "; ".join(reasons)] if applied else \
                [f"Clear frame - dehaze not needed (haze {haze:.2f}, brightness {bright:.2f})"]
        return ("enhanced" if applied else "not_needed"), {
            "haze_score": round(haze, 3), "brightness": round(bright, 3), "applied": applied,
            "reason": "; ".join(reasons) or "clear", "model_loaded": _dehaze is not None,
            "images": {"before": _enc(_small(frame_bgr)), "after": _enc(_small(_panel(out, label)))},
        }
    run_step(2, "Dehaze", s2)

    # ── 3. Privacy blur ─────────────────────────────────────────────────
    def s3():
        frame = ctx["frame"].copy()
        boxes = []
        if _face_sess is not None:
            img = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), (640, 640))
            inp = np.expand_dims(img.transpose(2, 0, 1).astype(np.float32) / 255.0, 0)
            preds = np.squeeze(_face_sess.run([_face_out], {_face_in: inp})[0]).T
            for p in preds:
                if len(p) >= 5 and p[4] > 0.35:
                    xc, yc, bw, bh = p[:4]
                    boxes.append(("face", [int((xc - bw / 2) * w / 640), int((yc - bh / 2) * h / 640),
                                           int((xc + bw / 2) * w / 640), int((yc + bh / 2) * h / 640)]))
        if _plate_model is not None:
            for b in _plate_model(frame, verbose=False)[0].boxes.xyxy.cpu().numpy():
                boxes.append(("plate", [int(v) for v in b[:4]]))
        for _, (x1, y1, x2, y2) in boxes:
            x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
            if x2 > x1 and y2 > y1:
                frame[y1:y2, x1:x2] = cv2.GaussianBlur(frame[y1:y2, x1:x2], (55, 55), 30)
        ctx["priv"] = frame
        vis = frame.copy()
        for kind, b in boxes:
            _tag(vis, b, [f"{kind} blurred"], (0, 220, 255))
        nf = sum(1 for k, _ in boxes if k == "face")
        npl = sum(1 for k, _ in boxes if k == "plate")
        return "done", {"faces_blurred": nf, "plates_blurred": npl,
                        "images": {"privacy": _enc(_small(_panel(vis, [f"Faces blurred: {nf}  Plates blurred: {npl}",
                                                                          "Only this blurred frame is ever stored/sent"])))}}
    run_step(3, "Privacy", s3)
    frame = ctx["priv"]

    # ── 4. H4 Road mask ─────────────────────────────────────────────────
    def s4():
        road = side = None
        vis = frame.copy()
        if _road_model is not None:
            import torch
            inp = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), (1024, 512))
            t = torch.from_numpy(inp.transpose(2, 0, 1)).unsqueeze(0).float() / 255.0
            with torch.no_grad():
                cls = torch.argmax(_road_model(t)[0], dim=1).squeeze().numpy().astype(np.uint8)
            cls = cv2.resize(cls, (w, h), interpolation=cv2.INTER_NEAREST)
            road, side = (cls == 0).astype(np.uint8), (cls == 1).astype(np.uint8)
            vis[road > 0] = (vis[road > 0] * 0.5 + np.array([0, 200, 0]) * 0.5).astype(np.uint8)
            vis[side > 0] = (vis[side > 0] * 0.5 + np.array([200, 120, 0]) * 0.5).astype(np.uint8)
        ctx["road"], ctx["side"] = road, side
        rc = float(road.mean() * 100) if road is not None else 0.0
        sc = float(side.mean() * 100) if side is not None else 0.0
        return ("done" if road is not None else "skipped"), {
            "model_loaded": _road_model is not None, "road_coverage_pct": round(rc, 1),
            "pavement_coverage_pct": round(sc, 1),
            "images": {"road_mask": _enc(_small(_panel(vis, [f"GREEN = road surface ({rc:.0f}%)",
                                                                f"BLUE = pavement/sidewalk ({sc:.0f}%)"])))}}
    run_step(4, "H4 Road Mask", s4)

    # ── 5. H3 Depth ─────────────────────────────────────────────────────
    def s5():
        depth_n = None
        vis = frame.copy()
        if _midas is not None:
            import torch
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            with torch.no_grad():
                pred = _midas(_midas_tx(rgb))
                pred = torch.nn.functional.interpolate(pred.unsqueeze(1), size=rgb.shape[:2],
                                                       mode="bilinear", align_corners=False).squeeze()
            d = pred.cpu().numpy()
            depth_n = (d - d.min()) / max(1e-6, d.max() - d.min())
            vis = cv2.applyColorMap((depth_n * 255).astype(np.uint8), cv2.COLORMAP_PLASMA)
        ctx["depth"] = depth_n
        return ("done" if depth_n is not None else "skipped"), {
            "model_loaded": _midas is not None,
            "images": {"depth_map": _enc(_small(_panel(vis, ["MiDaS relative depth: bright = near, dark = far",
                                                               "Pothole depth = depth contrast vs surrounding road"])))}}
    run_step(5, "H3 Depth", s5)
    road, side, depth_n = ctx["road"], ctx["side"], ctx["depth"]
    candidates = []

    def _measure(htype, bbox, mask_bool, conf, source):
        x1, y1, x2, y2 = bbox
        bbox_area = max(1, (x2 - x1) * (y2 - y1))
        area_px = int(mask_bool.sum())
        rs = _region_stats(mask_bool, road, side, depth_n)
        g = _ground_metrics(bbox, w, h, fill=min(1.0, area_px / bbox_area))
        depth_cm = round((rs["depth_contrast"] or 0.0) * config.DEPTH_CM_SCALE, 1)
        on_ratio = rs["on_road_ratio"]
        on_road = True if on_ratio is None else on_ratio >= config.ON_ROAD_RATIO
        surface = "unknown" if on_ratio is None else (
            "ON ROAD" if on_road else ("ON PAVEMENT" if (rs["pavement_ratio"] or 0) > on_ratio else "OFF ROAD"))
        return {
            "hazard_type": htype, "bbox": [int(v) for v in bbox], "det_conf": round(conf, 3), "source": source,
            "area_px": area_px, "area_frac": area_px / (w * h), "depth_contrast": rs["depth_contrast"],
            "metrics": {**g, "depth_cm": depth_cm, "on_road": on_road, "surface": surface,
                        "on_road_ratio": on_ratio, "pavement_ratio": rs["pavement_ratio"],
                        "lane": _lane(bbox, w)},
        }

    def _label_lines(c):
        m = c["metrics"]
        return [f"{c['hazard_type'].upper()} {c['det_conf']:.0%} [{c['source']}]",
                f"W {m['width_m']}m x L {m['length_m']}m  area {m['area_m2']}m2",
                f"depth ~{m['depth_cm']}cm  dist {m['distance_m']}m",
                f"{m['surface']}  {m['lane']}"]

    # ── 6. H2 Segmentation ──────────────────────────────────────────────
    def s6():
        vis = frame.copy()
        if _head2 is not None:
            res = _head2(frame, verbose=False)[0]
            if res.masks is not None:
                for i, mt in enumerate(res.masks.data):
                    m = cv2.resize(mt.cpu().numpy(), (w, h), interpolation=cv2.INTER_NEAREST) > 0.5
                    c = _measure(_canon(res.names[int(res.boxes.cls[i])]), list(map(int, res.boxes.xyxy[i])),
                                 m, float(res.boxes.conf[i]), "H2-seg")
                    candidates.append(c)
                    vis[m] = (vis[m] * 0.45 + np.array([0, 0, 230]) * 0.55).astype(np.uint8)
                    _tag(vis, c["bbox"], _label_lines(c), (60, 60, 255))
        segs = [c for c in candidates if c["source"] == "H2-seg"]
        return ("done" if _head2 is not None else "skipped"), {
            "model_loaded": _head2 is not None, "potholes_segmented": len(segs),
            "detections": [{"type": c["hazard_type"], "confidence": c["det_conf"], **c["metrics"]} for c in segs],
            "images": {"segmentation": _enc(_small(_panel(vis, [f"H2 pothole masks: {len(segs)}",
                                                                   "size from flat-road camera model (est.)"])))}}
    run_step(6, "H2 Segmentation", s6)

    # ── 7. H1 Detection ─────────────────────────────────────────────────
    def s7():
        vis = frame.copy()
        dets = []
        if _head1 is not None:
            res = _head1(frame, verbose=False)[0]
            for b in res.boxes:
                htype = _canon(res.names[int(b.cls[0])])
                conf = float(b.conf[0])
                bbox = list(map(int, b.xyxy[0]))
                dets.append({"type": htype, "confidence": round(conf, 3), "bbox": bbox})
                match = next((c for c in candidates if c["hazard_type"] == htype and _iou(c["bbox"], bbox) > 0.3), None)
                if match:
                    match["det_conf"] = round(max(match["det_conf"], conf), 3)
                    match["source"] = "H2+H1"
                    _tag(vis, bbox, [f"{htype} {conf:.0%}", "confirms H2 mask"], (0, 200, 255))
                else:
                    x1, y1, x2, y2 = bbox
                    m = np.zeros((h, w), bool)
                    m[max(0, y1):y2, max(0, x1):x2] = True
                    c = _measure(htype, bbox, m, conf, "H1-det")
                    candidates.append(c)
                    _tag(vis, bbox, _label_lines(c), (0, 165, 255))
        return ("done" if _head1 is not None else "skipped"), {
            "model_loaded": _head1 is not None, "weights": Path(_head1_path).name if _head1_path else None,
            "detections": dets,
            "images": {"detection": _enc(_small(_panel(vis, [f"H1 detections: {len(dets)} (pothole / speed bump / debris)"])))}}
    run_step(7, "H1 Detection", s7)

    # Optical-flow helpers (flow computed on the 320-px frame)
    fs = 320 / w
    mag = None
    global_mag = 0.0
    if flow is not None:
        mag = np.linalg.norm(flow, axis=2)
        global_mag = float(np.median(mag[mag.shape[0] // 2:, :]))

    def bbox_flow(b):
        if mag is None:
            return None
        x1, y1, x2, y2 = [int(v * fs) for v in b]
        roi = mag[max(0, y1):max(y1 + 1, y2), max(0, x1):max(x1 + 1, x2)]
        return float(roi.mean()) if roi.size else None

    # ── 8. H5 stalled vehicles ──────────────────────────────────────────
    def s8():
        vis = frame.copy()
        tracks_out = []
        if _head5_det is not None:
            res = _head5_det(frame, verbose=False)[0]
            dets = [[*map(float, b.xyxy[0]), float(b.conf[0])] for b in res.boxes
                    if res.names[int(b.cls[0])] in VEHICLE_CLASSES]
            names = {i: res.names[int(b.cls[0])] for i, b in enumerate(res.boxes)}
            tracker = sess.get_tracker()
            arr = np.array(dets) if dets else np.empty((0, 5))
            for trk in tracker.update(arr, frame_shape=(h, w)):
                x1, y1, x2, y2, tid = map(int, trk)
                bbox = [x1, y1, x2, y2]
                hist = sess.vehicle_hist.setdefault(tid, {"hits": 0, "stat": [], "conf": 0.0})
                hist["hits"] += 1
                best = max(dets, key=lambda d: _iou(d[:4], bbox), default=None)
                hist["conf"] = best[4] if best else hist["conf"]
                bf = bbox_flow(bbox)
                if bf is None:
                    stat = 0.5
                elif global_mag >= 0.5:      # we are moving: a stalled car flows like the road
                    stat = min(1.0, (bf / global_mag) / 0.8)
                else:                        # we are stopped: a stalled car does not move at all
                    stat = 1.0 - min(1.0, bf / 1.5)
                hist["stat"] = (hist["stat"] + [stat])[-5:]
                mean_stat = sum(hist["stat"]) / len(hist["stat"])
                on_ratio = None
                if road is not None:
                    yb = min(h - 1, y2)
                    strip = road[max(0, yb - 10):yb + 1, max(0, x1):x2]
                    on_ratio = float(strip.mean()) if strip.size else 0.0
                on_road = True if on_ratio is None else on_ratio >= config.ON_ROAD_RATIO
                stalled = hist["hits"] >= config.STALL_FRAMES and mean_stat >= config.STALL_STATIONARITY and on_road
                g = _ground_metrics(bbox, w, h)
                tracks_out.append({"track_id": tid, "frames_tracked": hist["hits"],
                                   "stationarity": round(mean_stat, 2), "on_road": on_road,
                                   "is_stalled": stalled, "distance_m": g["distance_m"]})
                clr = (0, 0, 255) if stalled else (0, 200, 0)
                _tag(vis, bbox, [f"ID{tid} {'STALLED' if stalled else 'moving'}",
                                 f"tracked {hist['hits']}/{config.STALL_FRAMES} fr  still {mean_stat:.2f}",
                                 f"{'on road' if on_road else 'off road'}  {g['distance_m']}m"], clr)
                if stalled:
                    m = np.zeros((h, w), bool)
                    m[max(0, y1):y2, max(0, x1):x2] = True
                    c = _measure("stalled_vehicle", bbox, m, hist["conf"], "H5-track")
                    c["stationarity"] = mean_stat
                    c["track_hits"] = hist["hits"]
                    c["metrics"]["on_road"] = on_road
                    c["metrics"]["surface"] = "ON ROAD" if on_road else "OFF ROAD"
                    c["metrics"]["depth_cm"] = 0.0
                    candidates.append(c)
        nst = sum(t["is_stalled"] for t in tracks_out)
        return ("done" if _head5_det is not None else "skipped"), {
            "model_loaded": _head5_det is not None, "vehicles_tracked": len(tracks_out), "stalled": nst,
            "rule": f"stalled = tracked ≥{config.STALL_FRAMES} frames AND stationarity ≥{config.STALL_STATIONARITY} AND on road",
            "tracks": tracks_out,
            "images": {"tracking": _enc(_small(_panel(vis, [f"Vehicles tracked (SORT): {len(tracks_out)}  STALLED: {nst}",
                                                               "stationarity from optical flow vs road motion"])))}}
    run_step(8, "H5 Stalled Vehicles", s8)

    # ── 9. Motion signals: optical flow + IMU ───────────────────────────
    imu = state.imu_now()

    def s9():
        if mag is not None:
            hsv = np.zeros((*mag.shape, 3), np.uint8)
            ang = np.arctan2(flow[..., 1], flow[..., 0])
            hsv[..., 0] = ((ang + np.pi) * 90 / np.pi).astype(np.uint8)
            hsv[..., 1] = 255
            hsv[..., 2] = np.clip(mag * 25, 0, 255).astype(np.uint8)
            vis = cv2.resize(cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR), (w, h))
        else:
            vis = frame.copy()
        for c in candidates:
            bf = bbox_flow(c["bbox"])
            c["flow_mag"] = bf
            if c["hazard_type"] == "stalled_vehicle":
                c["flow_signal"] = c.get("stationarity", 0.5)
            elif bf is None or global_mag < 0.3:
                c["flow_signal"] = 0.5          # no ego-motion → neutral evidence
            else:
                c["flow_signal"] = min(1.0, (bf / global_mag) / 1.5)
            _tag(vis, c["bbox"], [f"{c['hazard_type']} flow {'-' if bf is None else f'{bf:.1f}'}px "
                                  f"-> {c['flow_signal']:.2f}"], (255, 255, 255))
        imu_sig = min(1.0, imu / 5.0)
        lines = [f"Ego-motion (road flow median): {global_mag:.2f} px/frame" if mag is not None else
                 "Optical flow: needs a previous processed frame",
                 f"IMU vertical peak: {imu:.1f} m/s2 -> bump signal {imu_sig:.2f}"]
        return "done", {"global_flow_px": round(global_mag, 3), "imu_peak_ms2": round(imu, 2),
                        "imu_signal": round(imu_sig, 2), "has_previous_frame": mag is not None,
                        "images": {"optical_flow": _enc(_small(_panel(vis, lines)))}}
    run_step(9, "Motion: Flow + IMU", s9)

    # ── 10. Fusion engine ───────────────────────────────────────────────
    def s10():
        vis = frame.copy()
        fused = []
        for c in candidates:
            tr = sess.match_hazard(c["hazard_type"], c["bbox"])
            c["track"] = tr
            persistence = c.get("track_hits", tr.hits) / (config.STALL_FRAMES if c["hazard_type"] == "stalled_vehicle" else 3)
            on_ratio = c["metrics"]["on_road_ratio"]
            signals = {
                "detection_conf": c["det_conf"],
                "track_persistence": round(min(1.0, persistence), 3),
                "seg_area": round(min(1.0, c["area_frac"] / 0.03), 3),
                "depth": round(c["depth_contrast"] if c["depth_contrast"] is not None else 0.0, 3)
                         if c["hazard_type"] != "stalled_vehicle" else 0.5,
                "on_road": 0.5 if on_ratio is None and c["hazard_type"] != "stalled_vehicle"
                           else (1.0 if c["metrics"]["on_road"] else 0.0),
                "optical_flow": round(c.get("flow_signal", 0.5), 3),
                "imu_bump": round(min(1.0, imu / 5.0), 3) if c["hazard_type"] != "stalled_vehicle" else 0.0,
            }
            f = engine.score(signals)
            c["signals"], c["fusion"] = signals, f
            c["severity"] = _severity(c["hazard_type"], c["metrics"]["depth_cm"], c["metrics"]["area_m2"])
            clr = {"HIGH": (0, 0, 255), "MEDIUM": (0, 200, 255)}.get(f["routing"], (160, 160, 160))
            _tag(vis, c["bbox"], [f"{c['hazard_type']}  score {f['score']:.2f} -> {f['routing']}",
                                  f"track #{tr.id} seen {tr.hits}x  sev {c['severity']}"], clr)
            fused.append({"hazard_type": c["hazard_type"], "track_id": tr.id, "source": c["source"],
                          "severity": c["severity"], "metrics": c["metrics"], **f})
        best = max(fused, key=lambda x: x["score"], default=None)
        return (best["routing"] if best else "DISCARD"), {
            "candidates": fused, "model_version": engine.version, "model_source": engine.source,
            "thresholds": {"high": config.FUSION_HIGH_THRESHOLD, "medium": config.FUSION_MEDIUM_THRESHOLD},
            "formula": "score = sigmoid(bias + Σ weight × signal)",
            "images": {"fusion": _enc(_small(_panel(vis, [
                f"Fusion model v{engine.version} ({engine.source})",
                f"HIGH >= {config.FUSION_HIGH_THRESHOLD}  MEDIUM >= {config.FUSION_MEDIUM_THRESHOLD}  else discard"])))}}
    run_step(10, "Fusion Engine", s10)

    # ── 11. Alert routing ───────────────────────────────────────────────
    actions = []

    def s11():
        from services import edge_store, reporting, verification
        asked = len(edge_store.list_verify("pending")) >= config.MAX_PENDING_VERIFY
        for c in sorted(candidates, key=lambda x: -x["fusion"]["score"]):
            tr, f = c["track"], c["fusion"]
            if f["routing"] == "DISCARD":
                actions.append({"hazard_type": c["hazard_type"], "track_id": tr.id, "action": "discarded",
                                "score": f["score"]})
                continue
            if tr.reported or (f["routing"] == "MEDIUM" and tr.verify_requested):
                actions.append({"hazard_type": c["hazard_type"], "track_id": tr.id, "score": f["score"],
                                "action": "already handled for this track (no duplicate report)"})
                continue
            lat, lon = project(tel.lat, tel.lon, tel.heading_deg, c["metrics"]["distance_m"])
            payload = {
                "report_uid": reporting.new_report_uid(), "client_id": config.CLIENT_ID,
                "client_name": config.CLIENT_NAME, "hazard_type": c["hazard_type"], "severity": c["severity"],
                "latitude": round(lat, 7), "longitude": round(lon, 7), "car_lat": tel.lat, "car_lon": tel.lon,
                "fusion_score": f["score"], "routing": f["routing"], "verified": False,
                "signals": c["signals"], "metrics": c["metrics"], "bbox": c["bbox"],
                "frame_w": w, "frame_h": h, "fusion_model_version": engine.version,
                "detected_at": datetime.utcnow().isoformat(timespec="seconds"),
            }
            full = _jpeg(frame)
            if f["routing"] == "HIGH":
                tr.reported = True
                r = reporting.submit(payload, full, session_id)
                actions.append({"hazard_type": c["hazard_type"], "track_id": tr.id, "score": f["score"],
                                "action": "reported", "delivery": r["delivery"],
                                "cluster": (r["server"] or {}).get("cluster_id"),
                                "cluster_action": (r["server"] or {}).get("cluster_action"),
                                "bluetooth": r["bluetooth"]["transports"]})
            elif asked:
                actions.append({"hazard_type": c["hazard_type"], "track_id": tr.id, "score": f["score"],
                                "action": "MEDIUM — waiting (driver already has a question open)"})
            else:
                asked = True                      # one driver question per frame
                tr.verify_requested = True
                crop = frame.copy()
                _tag(crop, c["bbox"], [f"{c['hazard_type']}?  {f['score']:.0%}"], (0, 200, 255))
                vid = verification.create(payload, full, _jpeg(_small(crop, 640)), session_id)
                actions.append({"hazard_type": c["hazard_type"], "track_id": tr.id, "score": f["score"],
                                "action": "driver verification requested (not sent yet)", "verify_id": vid})
        status = ("reported" if any(a["action"] == "reported" for a in actions) else
                  "verify" if any("verification" in a["action"] for a in actions) else "no_hazard")
        return status, {"actions": actions, "online": state.is_online(),
                        "car_position": [tel.lat, tel.lon], "heading_deg": tel.heading_deg}
    run_step(11, "Alert Routing", s11)

    best = max(candidates, key=lambda c: c["fusion"]["score"], default=None)
    return {
        "routing": best["fusion"]["routing"] if best else "DISCARD",
        "fusion_score": best["fusion"]["score"] if best else 0.0,
        "hazard_type": best["hazard_type"] if best else None,
        "severity": best["severity"] if best else "none",
        "candidates": len(candidates), "actions": actions, "stats": sess.stats(),
    }
