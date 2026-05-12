"""
Unified 11-step ML inference pipeline.
Steps:
  1.  AKS     — caller decides whether to invoke (session_state.aks_should_process)
  2.  Dehaze  — AOD-Net haze removal
  3.  Privacy — face + plate Gaussian blur (on-device, before any upload)
  4.  H4 Road — Fast-SCNN road mask
  5.  H3 Depth— MiDaS monocular depth
  6.  H2 Seg  — YOLOv8 pothole segmentation + area/depth scoring
  7.  H1 Det  — YOLOv10 object detection (fills gaps H2 misses)
  8.  H5 Track— SORT stalled-vehicle tracking (uses session state)
  9.  Fusion  — weighted combination of all head outputs
  10. Routing — HIGH / MEDIUM / LOW decision for alert vs verify vs discard
  11. Return  — structured result dict

All model paths come from config.py — nothing is hardcoded here.
"""

import sys
from pathlib import Path
from typing import Optional, TYPE_CHECKING

import config

# Ensure Fast-SCNN and SORT are importable
for _p in [str(config.FAST_SCNN_DIR), str(config.STALLED_DIR)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

if TYPE_CHECKING:
    import numpy as np

# ── Lazy model holders ─────────────────────────────────────────────────────
_head1 = None          # YOLOv10 detection
_head2 = None          # YOLOv8 segmentation
_midas = None          # MiDaS depth
_midas_tx = None       # MiDaS transform
_road_model = None     # Fast-SCNN
_veh_model = None      # YOLOv11 vehicle seg
_head5_det = None      # YOLOv11 for stall detection
_face_sess = None      # ONNX face detector
_face_in = None
_face_out = None
_plate_model = None    # YOLO plate detector
_dehaze = None         # AOD-Net
_loaded = False


def _load_models():
    global _head1, _head2, _midas, _midas_tx, _road_model, _veh_model
    global _head5_det, _face_sess, _face_in, _face_out, _plate_model, _dehaze, _loaded
    if _loaded:
        return
    _loaded = True  # set first to avoid re-entry on import errors

    def _try(label, fn):
        try:
            fn()
            print(f"[Pipeline] {label} ✓")
        except Exception as e:
            print(f"[Pipeline] {label} SKIP — {e}")

    # Head 1
    def _h1():
        global _head1
        from ultralytics import YOLO
        if config.HEAD1_MODEL.exists():
            _head1 = YOLO(str(config.HEAD1_MODEL))
    _try("Head 1 (Detection)", _h1)

    # Head 2
    def _h2():
        global _head2
        from ultralytics import YOLO
        if config.HEAD2_SEG_MODEL.exists():
            _head2 = YOLO(str(config.HEAD2_SEG_MODEL))
    _try("Head 2 (Segmentation)", _h2)

    # Head 3 — MiDaS
    def _h3():
        global _midas, _midas_tx
        import torch
        if config.HEAD3_DEPTH_MODEL.exists():
            m = torch.hub.load("intel-isl/MiDaS", "MiDaS_small", trust_repo=True)
            m.load_state_dict(torch.load(str(config.HEAD3_DEPTH_MODEL), map_location="cpu"))
            m.eval()
            _midas = m
            _midas_tx = torch.hub.load("intel-isl/MiDaS", "transforms", trust_repo=True).small_transform
    _try("Head 3 (MiDaS Depth)", _h3)

    # Head 4 — road mask
    def _h4road():
        global _road_model
        import torch
        from fast_scnn import FastSCNN
        if config.HEAD4_ROAD_MODEL.exists():
            m = FastSCNN(num_classes=19)
            m.load_state_dict(torch.load(str(config.HEAD4_ROAD_MODEL), map_location="cpu"))
            m.eval()
            _road_model = m
    _try("Head 4 (Fast-SCNN road)", _h4road)

    def _h4veh():
        global _veh_model
        from ultralytics import YOLO
        if config.HEAD4_VEH_MODEL.exists():
            _veh_model = YOLO(str(config.HEAD4_VEH_MODEL))
    _try("Head 4 (vehicle seg)", _h4veh)

    # Head 5 — stalled vehicle detector
    def _h5():
        global _head5_det
        from ultralytics import YOLO
        if config.HEAD5_DET_MODEL.exists():
            _head5_det = YOLO(str(config.HEAD5_DET_MODEL))
    _try("Head 5 (stalled det)", _h5)

    # Privacy — face ONNX
    def _face():
        global _face_sess, _face_in, _face_out
        import onnxruntime as ort
        if config.FACE_ONNX_MODEL.exists():
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            s = ort.InferenceSession(str(config.FACE_ONNX_MODEL), sess_options=opts,
                                     providers=["CPUExecutionProvider"])
            _face_sess = s
            _face_in  = s.get_inputs()[0].name
            _face_out = s.get_outputs()[0].name
    _try("Privacy (face ONNX)", _face)

    # Privacy — plate YOLO
    def _plate():
        global _plate_model
        from ultralytics import YOLO
        if config.PLATE_PT_MODEL.exists():
            _plate_model = YOLO(str(config.PLATE_PT_MODEL))
    _try("Privacy (plate YOLO)", _plate)

    # Dehazing
    def _dh():
        global _dehaze
        import torch, torch.nn as nn
        if not config.DEHAZE_MODEL.exists():
            return
        class _AOD(nn.Module):
            def __init__(self):
                super().__init__()
                self.relu   = nn.ReLU(inplace=True)
                self.e1 = nn.Conv2d(3,  3, 1, 1, 0, bias=True)
                self.e2 = nn.Conv2d(3,  3, 3, 1, 1, bias=True)
                self.e3 = nn.Conv2d(6,  3, 5, 1, 2, bias=True)
                self.e4 = nn.Conv2d(6,  3, 7, 1, 3, bias=True)
                self.e5 = nn.Conv2d(12, 3, 3, 1, 1, bias=True)
            def forward(self, x):
                x1 = self.relu(self.e1(x))
                x2 = self.relu(self.e2(x1))
                x3 = self.relu(self.e3(torch.cat([x1,x2], 1)))
                x4 = self.relu(self.e4(torch.cat([x2,x3], 1)))
                x5 = self.relu(self.e5(torch.cat([x1,x2,x3,x4], 1)))
                return self.relu((x5 * x) - x5 + 1)
        net = _AOD()
        net.load_state_dict(torch.load(str(config.DEHAZE_MODEL), map_location="cpu"))
        net.eval()
        _dehaze = net
    _try("Dehazing (AOD-Net)", _dh)

    print("[Pipeline] Model loading complete.")


# ── Helper: privacy blur ───────────────────────────────────────────────────

def _blur(frame, x1, y1, x2, y2, k=55):
    import cv2
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
    if x2 > x1 and y2 > y1:
        frame[y1:y2, x1:x2] = cv2.GaussianBlur(frame[y1:y2, x1:x2], (k, k), 30)
    return frame


def _privacy_blur(frame):
    import numpy as np
    import cv2
    # Face detection (ONNX)
    if _face_sess:
        img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img_r = cv2.resize(img, (640, 640))
        inp = np.expand_dims(img_r.transpose(2,0,1).astype(np.float32)/255.0, 0)
        preds = np.squeeze(_face_sess.run([_face_out], {_face_in: inp})[0]).T
        h, w = frame.shape[:2]
        for p in preds:
            if len(p) >= 5 and p[4] > 0.35:
                xc, yc, bw, bh = p[:4]
                frame = _blur(frame,
                    int((xc-bw/2)*w/640), int((yc-bh/2)*h/640),
                    int((xc+bw/2)*w/640), int((yc+bh/2)*h/640))
    # Plate detection (YOLO)
    if _plate_model:
        res = _plate_model(frame, verbose=False)[0]
        for box in res.boxes.xyxy.cpu().numpy():
            frame = _blur(frame, *map(int, box[:4]))
    return frame


# ── Helper: dehaze ────────────────────────────────────────────────────────

def _dehaze_frame(frame):
    if _dehaze is None:
        return frame
    try:
        import torch, cv2, numpy as np
        from torchvision import transforms
        from PIL import Image
        pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        t = transforms.ToTensor()(pil).unsqueeze(0)
        with torch.no_grad():
            out = _dehaze(t)
        return cv2.cvtColor(
            np.array(transforms.ToPILImage()(out.squeeze(0).clamp(0,1))),
            cv2.COLOR_RGB2BGR)
    except Exception:
        return frame


# ── Helper: severity ──────────────────────────────────────────────────────

def _severity(area_px: int, depth: float) -> str:
    if area_px > 5000 or depth > 0.7:
        return "high"
    if area_px > 1500 or depth > 0.4:
        return "medium"
    return "low"


# ── Main entry ────────────────────────────────────────────────────────────

def run(frame_bgr, session_state=None) -> dict:
    """
    Run the full pipeline on one BGR frame.

    session_state: optional SessionPipelineState for SORT tracking.
    Returns a dict with:
      detections, severity, hazard_type, fusion_score, on_road,
      depth_score, routing (HIGH/MEDIUM/LOW/DISCARD),
      tracking (list of tracked vehicles with stall status),
      aks_stats (if session_state provided)
    """
    import numpy as np
    import cv2

    _load_models()

    result = {
        "detections":  [],
        "severity":    "none",
        "hazard_type": None,
        "fusion_score": 0.0,
        "on_road":     True,
        "depth_score": 0.0,
        "routing":     "DISCARD",
        "tracking":    [],
        "aks_stats":   session_state.aks_stats() if session_state else {},
    }

    h, w = frame_bgr.shape[:2]

    # ── Step 2: Dehaze ────────────────────────────────────────────────────
    frame = _dehaze_frame(frame_bgr)

    # ── Step 3: Privacy blur ──────────────────────────────────────────────
    frame = _privacy_blur(frame.copy())

    # ── Step 4: Road mask ─────────────────────────────────────────────────
    road_binary = None
    if _road_model is not None:
        try:
            import torch
            inp_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            inp_r   = cv2.resize(inp_rgb, (1024, 512))
            inp_t   = torch.from_numpy(inp_r.transpose(2,0,1)).unsqueeze(0).float() / 255.0
            with torch.no_grad():
                seg_out = _road_model(inp_t)[0]
                mask    = torch.argmax(seg_out, dim=1).squeeze().numpy()
            road_binary = cv2.resize(
                (mask == 0).astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
        except Exception as e:
            print(f"[Pipeline] Road mask failed: {e}")

    # ── Step 5: MiDaS depth ───────────────────────────────────────────────
    depth_map = None
    if _midas is not None and _midas_tx is not None:
        try:
            import torch
            img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            batch   = _midas_tx(img_rgb)
            with torch.no_grad():
                pred = _midas(batch)
                pred = torch.nn.functional.interpolate(
                    pred.unsqueeze(1), size=img_rgb.shape[:2],
                    mode="bilinear", align_corners=False).squeeze()
            depth_map = pred.cpu().numpy()
        except Exception as e:
            print(f"[Pipeline] MiDaS failed: {e}")

    # ── Step 6: Head 2 — segmentation ────────────────────────────────────
    seg_objects = []
    if _head2 is not None:
        try:
            res = _head2(frame, verbose=False)[0]
            if res.masks is not None:
                for i, mask_t in enumerate(res.masks.data):
                    conf      = float(res.boxes.conf[i])
                    cls_name  = res.names[int(res.boxes.cls[i])]
                    mask_np   = cv2.resize(mask_t.cpu().numpy(), (w, h),
                                           interpolation=cv2.INTER_NEAREST)
                    area_px   = int(np.sum(mask_np > 0.5))

                    # On-road ratio
                    on_road_r = 1.0
                    if road_binary is not None:
                        dil = cv2.dilate(road_binary, np.ones((15,15), np.uint8))
                        inter = np.logical_and(mask_np > 0.5, dil > 0)
                        on_road_r = float(inter.sum() / (mask_np.sum() + 1e-5))

                    # Mean depth in masked region
                    mean_d = 0.0
                    if depth_map is not None:
                        norm_d = cv2.normalize(depth_map, None, 0, 1, cv2.NORM_MINMAX)
                        px     = mask_np > 0.5
                        if px.sum() > 0:
                            mean_d = float(np.mean(norm_d[px]))

                    x1, y1, x2, y2 = map(int, res.boxes.xyxy[i])
                    seg_objects.append({
                        "type":         cls_name,
                        "confidence":   round(conf, 3),
                        "area_px":      area_px,
                        "depth_score":  round(mean_d, 3),
                        "on_road_ratio": round(on_road_r, 3),
                        "severity":     _severity(area_px, mean_d),
                        "bbox":         [x1, y1, x2, y2],
                        "source":       "seg",
                    })
        except Exception as e:
            print(f"[Pipeline] Head 2 failed: {e}")

    # ── Step 7: Head 1 — detection (gap-fill) ────────────────────────────
    det_objects = []
    if _head1 is not None:
        try:
            res = _head1(frame, verbose=False)[0]
            seen_types = {o["type"] for o in seg_objects}
            for box in res.boxes:
                cls_name = res.names[int(box.cls[0])]
                if cls_name in seen_types:
                    continue   # seg already covered it
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                det_objects.append({
                    "type":          cls_name,
                    "confidence":    round(conf, 3),
                    "area_px":       0,
                    "depth_score":   0.0,
                    "on_road_ratio": 1.0,
                    "severity":      "medium",
                    "bbox":          [x1, y1, x2, y2],
                    "source":        "det",
                })
        except Exception as e:
            print(f"[Pipeline] Head 1 failed: {e}")

    all_objects = seg_objects + det_objects

    # ── Step 8: Head 5 — SORT stalled-vehicle tracking ───────────────────
    tracking_results = []
    if session_state is not None and _head5_det is not None:
        try:
            h5_res = _head5_det(frame, verbose=False)[0]
            VEHICLE_CLASSES = {"car", "truck", "bus", "motorbike", "motorcycle"}
            dets_for_sort = []
            for box in h5_res.boxes:
                nm = h5_res.names[int(box.cls[0])]
                if nm in VEHICLE_CLASSES:
                    x1, y1, x2, y2 = map(float, box.xyxy[0])
                    dets_for_sort.append([x1, y1, x2, y2, float(box.conf[0])])

            tracker = session_state.get_tracker()
            if tracker is not None:
                import numpy as np
                dets_arr = np.array(dets_for_sort) if dets_for_sort else np.empty((0, 5))
                tracks   = tracker.update(dets_arr, frame_shape=(h, w))
                active_ids = set()
                for trk in tracks:
                    tx1, ty1, tx2, ty2, tid = map(int, trk)
                    tid_key = int(tid)
                    active_ids.add(tid_key)
                    session_state.stalled_counters[tid_key] = \
                        session_state.stalled_counters.get(tid_key, 0) + 1
                    is_stalled = \
                        session_state.stalled_counters[tid_key] >= config.STALL_FRAMES
                    tracking_results.append({
                        "track_id":   tid_key,
                        "bbox":       [tx1, ty1, tx2, ty2],
                        "is_stalled": is_stalled,
                        "persistence": session_state.stalled_counters[tid_key],
                    })
                    if is_stalled:
                        # Surface stalled vehicle as a detection
                        all_objects.append({
                            "type":          "stalled_vehicle",
                            "confidence":    min(1.0, session_state.stalled_counters[tid_key] / config.STALL_FRAMES),
                            "area_px":       abs(tx2-tx1) * abs(ty2-ty1),
                            "depth_score":   0.5,
                            "on_road_ratio": 1.0,
                            "severity":      "high",
                            "bbox":          [tx1, ty1, tx2, ty2],
                            "source":        "tracking",
                        })
                # Clean up lost tracks
                for lost_id in list(session_state.stalled_counters.keys()):
                    if lost_id not in active_ids:
                        del session_state.stalled_counters[lost_id]
        except Exception as e:
            print(f"[Pipeline] Head 5 tracking failed: {e}")

    result["tracking"] = tracking_results

    # ── Step 9: Fusion scoring ────────────────────────────────────────────
    if not all_objects:
        result["routing"] = "DISCARD"
        return result

    # Weight each detection by source confidence
    best = max(all_objects, key=lambda o: o["confidence"])
    c_detect  = best["confidence"]
    c_road    = float(np.mean([o.get("on_road_ratio", 1.0) for o in all_objects]))
    c_depth   = float(np.mean([o.get("depth_score",   0.0) for o in all_objects]))
    c_track   = 0.0
    for o in all_objects:
        if o.get("source") == "tracking":
            # Tracking confidence: ramp up over persistence frames
            c_track = max(c_track, o["confidence"])

    # Fusion weights: detection(0.4) + road(0.2) + depth(0.2) + tracking(0.2)
    road_penalty = 1.0 if c_road >= 0.3 else 0.5
    fusion = (
        0.40 * c_detect
        + 0.20 * road_penalty
        + 0.20 * min(c_depth * 2, 1.0)   # depth normalised to ~0-1
        + 0.20 * c_track
    )
    fusion = round(min(fusion, 1.0), 3)

    sev_map  = {"high": 3, "medium": 2, "low": 1}
    top_sev  = max(all_objects, key=lambda o: sev_map.get(o.get("severity","low"), 1))

    result.update({
        "detections":   all_objects,
        "fusion_score": fusion,
        "severity":     top_sev["severity"],
        "hazard_type":  best["type"],
        "on_road":      c_road >= 0.3,
        "depth_score":  round(c_depth, 3),
    })

    # ── Step 10: Routing decision ─────────────────────────────────────────
    if fusion >= config.FUSION_HIGH_THRESHOLD:
        result["routing"] = "HIGH"       # alert + federated update
    elif fusion >= config.FUSION_MEDIUM_THRESHOLD:
        result["routing"] = "MEDIUM"     # human verification required
    else:
        result["routing"] = "DISCARD"    # not hazardous

    return result


def model_status() -> dict:
    """Return which models are currently loaded."""
    return {
        "head1_detection":   _head1 is not None,
        "head2_segmentation": _head2 is not None,
        "head3_depth":       _midas is not None,
        "head4_road_mask":   _road_model is not None,
        "head4_vehicle_seg": _veh_model is not None,
        "head5_stalled":     _head5_det is not None,
        "privacy_face":      _face_sess is not None,
        "privacy_plate":     _plate_model is not None,
        "dehazing":          _dehaze is not None,
        "models_loaded":     _loaded,
    }
