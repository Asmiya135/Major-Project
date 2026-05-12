"""
Step-by-step pipeline execution with annotated image generation.
Each step runs the same underlying models as pipeline.py (shared lazy globals),
then draws annotations onto the frame and encodes the result as a base64 JPEG
so the frontend can display what is happening at every stage.

Every step emits a dict:
  { step, name, status, duration_ms, data: { metrics..., images: {key: b64_jpeg} } }
"""

import sys
import time
import base64
from typing import Callable, Awaitable

import config

# Make Fast-SCNN and SORT importable
for _p in [str(config.FAST_SCNN_DIR), str(config.STALLED_DIR)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ── Image helpers ──────────────────────────────────────────────────────────

def _enc(img, quality: int = 72) -> str:
    """BGR cv2 image → base64 JPEG string."""
    import cv2
    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf.tobytes()).decode()


def _resize(img, w: int = 480):
    """Proportionally resize to max width w (keeps aspect ratio)."""
    import cv2
    h, cw = img.shape[:2]
    if cw <= w:
        return img
    return cv2.resize(img, (w, int(h * w / cw)))


def _overlay_text(img, lines: list, color=(255, 255, 255)):
    import cv2
    out = img.copy()
    for i, line in enumerate(lines):
        cv2.putText(out, line, (10, 24 + i * 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3)
        cv2.putText(out, line, (10, 24 + i * 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 1)
    return out


# ── Main entry ─────────────────────────────────────────────────────────────

async def run_visual_pipeline(
    frame_bgr,
    session_state,
    speed_kmh: float,
    latitude: float,
    longitude: float,
    emit: Callable[[dict], Awaitable[None]],
) -> dict:
    """
    Run the full 11-step pipeline, emitting a step_result message after each step.
    Returns the final fused result dict (same shape as pipeline.run()).
    """
    import cv2
    import numpy as np

    # Import shared model globals from pipeline.py so we never load models twice
    from services import pipeline as P
    P._load_models()

    h, w = frame_bgr.shape[:2]

    async def step_done(step_n: int, name: str, status: str,
                        duration_ms: int, data: dict):
        await emit({
            "type":        "step_result",
            "step":        step_n,
            "name":        name,
            "status":      status,
            "duration_ms": duration_ms,
            "data":        data,
        })

    # ── Step 1: AKS ────────────────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 1, "name": "AKS"})
    should_process, motion_score = session_state.aks_check(frame_bgr, speed_kmh)
    aks_img = _overlay_text(frame_bgr.copy(), [
        f"Motion: {motion_score:.1f} px",
        f"Threshold: {config.AKS_MOTION_THRESHOLD} px",
        "PROCESS" if should_process else f"SKIP (next {session_state.aks_skip_remaining})",
    ], color=(0, 255, 0) if should_process else (0, 80, 255))
    stats = session_state.aks_stats()
    await step_done(1, "AKS", "processed" if should_process else "skipped",
        int((time.time() - t0) * 1000), {
            "motion_score":       round(motion_score, 2),
            "threshold":          config.AKS_MOTION_THRESHOLD,
            "was_processed":      should_process,
            "frames_received":    stats["frames_received"],
            "frames_processed":   stats["frames_processed"],
            "compute_saving_pct": stats["compute_saving_pct"],
            "images": {"frame": _enc(_resize(aks_img))},
        })

    if not should_process:
        return {"routing": "AKS_SKIP", "fusion_score": 0.0, "detections": []}

    # ── Step 2: Composite (single-camera pass-through with metadata) ────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 2, "name": "Composite"})
    comp_img = _overlay_text(frame_bgr.copy(), [
        f"Resolution: {w}x{h}",
        "Fisheye correction: N/A (single cam)",
        "IPM: pass-through",
    ])
    await step_done(2, "Composite", "done", int((time.time() - t0) * 1000), {
        "resolution": f"{w}x{h}",
        "cameras": 1,
        "images": {"composite": _enc(_resize(comp_img))},
    })

    # ── Step 3: Dehaze ──────────────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 3, "name": "Dehaze"})
    before_img = frame_bgr.copy()
    frame = P._dehaze_frame(frame_bgr)
    diff_mean = float(np.mean(np.abs(frame.astype(np.float32) - before_img.astype(np.float32))))
    enhanced = P._dehaze is not None
    await step_done(3, "Dehaze", "enhanced" if enhanced else "skipped",
        int((time.time() - t0) * 1000), {
            "model_loaded": enhanced,
            "pixel_change": round(diff_mean, 2),
            "images": {
                "before": _enc(_resize(before_img)),
                "after":  _enc(_resize(frame)),
            },
        })

    # ── Step 4: Privacy blur ────────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 4, "name": "Privacy"})
    pre_privacy = frame.copy()
    frame_priv = P._privacy_blur(frame.copy())
    faces_detected  = P._face_sess is not None
    plates_detected = P._plate_model is not None
    await step_done(4, "Privacy", "done", int((time.time() - t0) * 1000), {
        "face_model_active":  faces_detected,
        "plate_model_active": plates_detected,
        "images": {
            "before": _enc(_resize(pre_privacy)),
            "after":  _enc(_resize(frame_priv)),
        },
    })

    # ── Step 5: H4 Road Mask ────────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 5, "name": "H4 Road Mask"})
    road_binary = None
    road_coverage = 0.0
    road_vis = frame_priv.copy()
    if P._road_model is not None:
        try:
            import torch
            inp_rgb = cv2.cvtColor(frame_priv, cv2.COLOR_BGR2RGB)
            inp_r   = cv2.resize(inp_rgb, (1024, 512))
            inp_t   = torch.from_numpy(inp_r.transpose(2,0,1)).unsqueeze(0).float() / 255.0
            with torch.no_grad():
                seg = P._road_model(inp_t)[0]
                mask = torch.argmax(seg, dim=1).squeeze().numpy()
            road_binary = cv2.resize((mask == 0).astype(np.uint8), (w, h),
                                     interpolation=cv2.INTER_NEAREST)
            road_coverage = float(road_binary.sum() / (w * h) * 100)
            # Visualise: green overlay on road pixels
            overlay = road_vis.copy()
            overlay[road_binary > 0] = (overlay[road_binary > 0] * 0.5
                                        + np.array([0, 180, 0]) * 0.5).astype(np.uint8)
            road_vis = overlay
        except Exception as e:
            road_vis = _overlay_text(frame_priv.copy(), [f"Road mask error: {e}"])
    road_vis = _overlay_text(road_vis, [
        f"Road coverage: {road_coverage:.1f}%",
        "Green = drivable surface",
    ])
    await step_done(5, "H4 Road Mask",
        "done" if P._road_model is not None else "skipped",
        int((time.time() - t0) * 1000), {
            "model_loaded":   P._road_model is not None,
            "road_coverage_pct": round(road_coverage, 1),
            "images": {"road_mask": _enc(_resize(road_vis))},
        })

    # ── Step 6: H3 Depth ────────────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 6, "name": "H3 Depth"})
    depth_map = None
    mean_depth = 0.0
    depth_vis  = frame_priv.copy()
    if P._midas is not None and P._midas_tx is not None:
        try:
            import torch
            img_rgb  = cv2.cvtColor(frame_priv, cv2.COLOR_BGR2RGB)
            batch    = P._midas_tx(img_rgb)
            with torch.no_grad():
                pred = P._midas(batch)
                pred = torch.nn.functional.interpolate(
                    pred.unsqueeze(1), size=img_rgb.shape[:2],
                    mode="bilinear", align_corners=False).squeeze()
            depth_map = pred.cpu().numpy()
            mean_depth = float(np.mean(depth_map))
            # Colourmap: closer = warmer
            norm = cv2.normalize(depth_map, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
            depth_vis = cv2.applyColorMap(norm, cv2.COLORMAP_PLASMA)
        except Exception as e:
            depth_vis = _overlay_text(frame_priv.copy(), [f"Depth error: {e}"])
    depth_vis = _overlay_text(depth_vis, [
        f"Mean depth: {mean_depth:.3f}",
        "Warm = near, Cool = far",
    ])
    await step_done(6, "H3 Depth",
        "done" if P._midas is not None else "skipped",
        int((time.time() - t0) * 1000), {
            "model_loaded": P._midas is not None,
            "mean_depth":   round(mean_depth, 3),
            "images": {"depth_map": _enc(_resize(depth_vis))},
        })

    # ── Step 7: H2 Segmentation ─────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 7, "name": "H2 Segmentation"})
    seg_objects = []
    seg_vis = frame_priv.copy()
    if P._head2 is not None:
        try:
            res = P._head2(frame_priv, verbose=False)[0]
            if res.masks is not None:
                for i, mask_t in enumerate(res.masks.data):
                    conf = float(res.boxes.conf[i])
                    cls  = res.names[int(res.boxes.cls[i])]
                    msk  = cv2.resize(mask_t.cpu().numpy(), (w, h),
                                      interpolation=cv2.INTER_NEAREST)
                    area = int(np.sum(msk > 0.5))
                    on_r = 1.0
                    if road_binary is not None:
                        dil  = cv2.dilate(road_binary, np.ones((15,15), np.uint8))
                        inter = np.logical_and(msk > 0.5, dil > 0)
                        on_r = float(inter.sum() / (msk.sum() + 1e-5))
                    # Overlay mask
                    color = np.array([0, 0, 200], dtype=np.uint8)
                    seg_vis[msk > 0.5] = (seg_vis[msk > 0.5] * 0.5 + color * 0.5).astype(np.uint8)
                    x1, y1, x2, y2 = map(int, res.boxes.xyxy[i])
                    cv2.rectangle(seg_vis, (x1, y1), (x2, y2), (0, 200, 0), 2)
                    cv2.putText(seg_vis, f"{cls} {conf:.0%} {area}px",
                                (x1, max(18, y1-6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,255,0), 1)
                    seg_objects.append({
                        "type": cls, "confidence": round(conf, 3),
                        "area_px": area, "on_road_ratio": round(on_r, 3),
                    })
        except Exception as e:
            seg_vis = _overlay_text(frame_priv.copy(), [f"Seg error: {e}"])
    seg_vis = _overlay_text(seg_vis, [f"Potholes detected: {len(seg_objects)}"])
    await step_done(7, "H2 Segmentation",
        "done" if P._head2 is not None else "skipped",
        int((time.time() - t0) * 1000), {
            "model_loaded": P._head2 is not None,
            "detections":   seg_objects,
            "images": {"segmentation": _enc(_resize(seg_vis))},
        })

    # ── Step 8: H1 Detection ────────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 8, "name": "H1 Detection"})
    det_objects = []
    det_vis = frame_priv.copy()
    if P._head1 is not None:
        try:
            res = P._head1(frame_priv, verbose=False)[0]
            for box in res.boxes:
                cls  = res.names[int(box.cls[0])]
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                clr  = (0, 165, 255)
                cv2.rectangle(det_vis, (x1, y1), (x2, y2), clr, 2)
                cv2.putText(det_vis, f"{cls} {conf:.0%}",
                            (x1, max(18, y1-6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, clr, 2)
                det_objects.append({"type": cls, "confidence": round(conf, 3),
                                    "bbox": [x1, y1, x2, y2]})
        except Exception as e:
            det_vis = _overlay_text(frame_priv.copy(), [f"Det error: {e}"])
    det_vis = _overlay_text(det_vis, [f"Objects detected: {len(det_objects)}"])
    await step_done(8, "H1 Detection",
        "done" if P._head1 is not None else "skipped",
        int((time.time() - t0) * 1000), {
            "model_loaded": P._head1 is not None,
            "detections":   det_objects,
            "images": {"detection": _enc(_resize(det_vis))},
        })

    # ── Step 9: H5 Stalled Vehicle Tracking ─────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 9, "name": "H5 Tracking"})
    tracks_data = []
    track_vis   = frame_priv.copy()
    if P._head5_det is not None:
        try:
            h5_res = P._head5_det(frame_priv, verbose=False)[0]
            VCLS = {"car", "truck", "bus", "motorbike", "motorcycle"}
            dets_for_sort = [
                [*map(float, box.xyxy[0]), float(box.conf[0])]
                for box in h5_res.boxes
                if h5_res.names[int(box.cls[0])] in VCLS
            ]
            tracker = session_state.get_tracker()
            if tracker is not None:
                dets_arr = np.array(dets_for_sort) if dets_for_sort \
                           else np.empty((0, 5))
                tracks = tracker.update(dets_arr, frame_shape=(h, w))
                for trk in tracks:
                    tx1, ty1, tx2, ty2, tid = map(int, trk)
                    tid_key = int(tid)
                    session_state.stalled_counters[tid_key] = \
                        session_state.stalled_counters.get(tid_key, 0) + 1
                    stalled = session_state.stalled_counters[tid_key] >= config.STALL_FRAMES
                    clr = (0, 0, 220) if stalled else (0, 220, 0)
                    cv2.rectangle(track_vis, (tx1, ty1), (tx2, ty2), clr, 2)
                    label = f"ID{tid_key} {'STALLED' if stalled else 'moving'}"
                    cv2.putText(track_vis, label, (tx1, max(18, ty1-6)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, clr, 2)
                    tracks_data.append({
                        "track_id":   tid_key,
                        "is_stalled": stalled,
                        "persistence": session_state.stalled_counters[tid_key],
                    })
        except Exception as e:
            track_vis = _overlay_text(frame_priv.copy(), [f"Tracking error: {e}"])
    track_vis = _overlay_text(track_vis, [
        f"Tracks: {len(tracks_data)}",
        f"Stalled: {sum(1 for t in tracks_data if t['is_stalled'])}",
    ])
    await step_done(9, "H5 Tracking",
        "done" if P._head5_det is not None else "skipped",
        int((time.time() - t0) * 1000), {
            "model_loaded": P._head5_det is not None,
            "tracks":       tracks_data,
            "images": {"tracking": _enc(_resize(track_vis))},
        })

    # ── Step 10: Fusion ──────────────────────────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 10, "name": "Fusion"})
    all_objects = seg_objects + [
        {**d, "source": "det", "area_px": 0, "depth_score": 0.0, "on_road_ratio": 1.0, "severity": "medium"}
        for d in det_objects
        if d["type"] not in {o["type"] for o in seg_objects}
    ]
    for trk in tracks_data:
        if trk["is_stalled"]:
            all_objects.append({
                "type": "stalled_vehicle",
                "confidence": min(1.0, trk["persistence"] / config.STALL_FRAMES),
                "area_px": 0, "depth_score": 0.5, "on_road_ratio": 1.0, "severity": "high"
            })

    fusion_score = 0.0
    routing      = "DISCARD"
    best_type    = None
    best_sev     = "none"
    component_scores = {
        "detection": 0.0, "road": 0.0,
        "depth": 0.0, "tracking": 0.0,
    }

    if all_objects:
        best = max(all_objects, key=lambda o: o.get("confidence", 0))
        c_detect = best.get("confidence", 0)
        c_road   = float(np.mean([o.get("on_road_ratio", 1.0) for o in all_objects]))
        c_depth  = float(np.mean([o.get("depth_score", 0.0) for o in all_objects]))
        c_track  = max((o["confidence"] for o in all_objects
                        if o.get("type") == "stalled_vehicle"), default=0.0)
        road_penalty = 1.0 if c_road >= 0.3 else 0.5
        fusion_score = round(
            0.40 * c_detect
            + 0.20 * road_penalty
            + 0.20 * min(c_depth * 2, 1.0)
            + 0.20 * c_track, 3)
        component_scores = {
            "detection": round(c_detect, 3),
            "road":      round(c_road,   3),
            "depth":     round(c_depth,  3),
            "tracking":  round(c_track,  3),
        }
        best_type = best.get("type")
        sev_map  = {"high": 3, "medium": 2, "low": 1}
        best_sev = max(all_objects,
                       key=lambda o: sev_map.get(o.get("severity", "low"), 1)).get("severity", "none")
        if fusion_score >= config.FUSION_HIGH_THRESHOLD:
            routing = "HIGH"
        elif fusion_score >= config.FUSION_MEDIUM_THRESHOLD:
            routing = "MEDIUM"

    await step_done(10, "Fusion", routing, int((time.time() - t0) * 1000), {
        "fusion_score":      fusion_score,
        "component_scores":  component_scores,
        "routing":           routing,
        "best_hazard_type":  best_type,
        "severity":          best_sev,
        "total_detections":  len(all_objects),
    })

    # ── Step 11: Alert (persist + WS push) ───────────────────────────────────
    t0 = time.time()
    await emit({"type": "step_start", "step": 11, "name": "Alert"})
    hazard_id = None
    alert_status = "discarded"

    if routing in ("HIGH", "MEDIUM") and best_type:
        import database
        nearby_id = database.find_nearby_hazard(
            latitude, longitude, config.DEDUP_RADIUS_M, best_type)
        if nearby_id:
            database.update_hazard(nearby_id, latitude, longitude, fusion_score)
            hazard_id = nearby_id
            alert_status = "merged"
        else:
            hazard_id = database.insert_hazard(
                latitude, longitude, best_type, fusion_score, best_sev)
            alert_status = "created"

    needs_verify = routing == "MEDIUM"
    await step_done(11, "Alert", alert_status, int((time.time() - t0) * 1000), {
        "hazard_id":     hazard_id,
        "hazard_type":   best_type,
        "severity":      best_sev,
        "latitude":      latitude,
        "longitude":     longitude,
        "needs_human_verification": needs_verify,
        "routing":       routing,
    })

    return {
        "detections":  all_objects,
        "fusion_score": fusion_score,
        "severity":    best_sev,
        "hazard_type": best_type,
        "on_road":     True,
        "routing":     routing,
        "hazard_id":   hazard_id,
    }
