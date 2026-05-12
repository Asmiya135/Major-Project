"""
/api/detect   — POST multipart image, runs full pipeline, returns structured result.
/api/detect/base64 — POST base64 image (browser webcam fallback).

Both endpoints are session-aware: they use session_state for AKS + SORT tracking
so consecutive frames from the same drive share memory of previous frames.
"""
import base64
from fastapi import APIRouter, UploadFile, File, Form, HTTPException

import database
from websocket_manager import manager
from services import session_state as ss
import config

router = APIRouter(tags=["detect"])


# ── Helpers ────────────────────────────────────────────────────────────────

def _lane_from_bbox(bbox: list, frame_w: int) -> str:
    if not bbox or frame_w == 0:
        return "Unknown lane"
    cx = (bbox[0] + bbox[2]) / 2
    frac = cx / frame_w
    if frac < 0.33:
        return "Left lane"
    if frac < 0.67:
        return "Center lane"
    return "Right lane"


def _rough_distance(bbox: list, frame_w: int, frame_h: int) -> float:
    """Estimate metres to hazard from bounding-box area ratio."""
    if not bbox:
        return 100.0
    box_area = abs(bbox[2]-bbox[0]) * abs(bbox[3]-bbox[1])
    ratio = box_area / max(frame_w * frame_h, 1)
    return max(5.0, 200.0 * (1.0 - ratio))


async def _run_pipeline_on_frame(raw_bytes: bytes, session_id: str,
                                  lat: float, lon: float, speed_kmh: float):
    """Decode bytes → run AKS check → run ML pipeline → persist + push."""
    # ── Lazy import heavy deps (cv2, numpy) ──────────────────────────────
    try:
        import numpy as np
        import cv2
    except ImportError as e:
        raise HTTPException(status_code=503, detail=f"ML deps missing: {e}")

    arr   = np.frombuffer(raw_bytes, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=422, detail="Cannot decode image")

    frame_h, frame_w = frame.shape[:2]
    state = ss.get(session_id)

    # ── AKS: skip redundant frames ────────────────────────────────────────
    if not state.aks_should_process(frame, speed_kmh):
        return {
            "session_id":   session_id,
            "skipped_by_aks": True,
            "aks_stats":    state.aks_stats(),
            "hazard_events": [],
        }

    # ── Full ML pipeline ──────────────────────────────────────────────────
    from services.pipeline import run as pipeline_run
    result = pipeline_run(frame, session_state=state)

    hazard_events = []
    routing = result.get("routing", "DISCARD")

    # DISCARD → nothing to save
    if routing == "DISCARD" or not result.get("hazard_type"):
        return {
            "session_id":     session_id,
            "skipped_by_aks": False,
            "routing":        routing,
            "pipeline":       result,
            "aks_stats":      result.get("aks_stats", {}),
            "hazard_events":  [],
        }

    htype    = result["hazard_type"]
    severity = result["severity"]
    conf     = result["fusion_score"]
    needs_fb = (routing == "MEDIUM")

    # Best bbox for lane / distance
    best_det = max(result["detections"], key=lambda d: d["confidence"]) if result["detections"] else {}
    bbox     = best_det.get("bbox", [])
    lane     = _lane_from_bbox(bbox, frame_w)
    dist_m   = _rough_distance(bbox, frame_w, frame_h)

    # ── Persist hazard (global map) ───────────────────────────────────────
    nearby_id = database.find_nearby_hazard(lat, lon, config.DEDUP_RADIUS_M, htype)
    if nearby_id:
        database.update_hazard(nearby_id, lat, lon, conf)
        hazard_id = nearby_id
    else:
        hazard_id = database.insert_hazard(lat, lon, htype, conf, severity)

    # ── Record detection in trip timeline ────────────────────────────────
    det_id = database.record_detection(
        session_id, hazard_id, lat, lon,
        htype, severity, conf, dist_m, lane,
        source="vehicle", needs_feedback=needs_fb,
    )

    # ── Also record any stalled vehicles from tracker ─────────────────────
    for trk in result.get("tracking", []):
        if trk["is_stalled"]:
            sv_id = database.find_nearby_hazard(lat, lon, config.DEDUP_RADIUS_M, "stalled_vehicle")
            if not sv_id:
                sv_id = database.insert_hazard(lat, lon, "stalled_vehicle",
                                                trk["confidence"], "high")
            database.record_detection(
                session_id, sv_id, lat, lon,
                "stalled_vehicle", "high", trk["confidence"], dist_m, lane,
                source="vehicle", needs_feedback=False,
            )

    event = {
        "type":          "hazard_detected",
        "detection_id":  det_id,
        "hazard_id":     hazard_id,
        "hazard_type":   htype,
        "severity":      severity,
        "confidence":    conf,
        "distance_m":    round(dist_m, 1),
        "lane":          lane,
        "latitude":      lat,
        "longitude":     lon,
        "needs_feedback": needs_fb,
        "routing":       routing,
        "tracking":      result.get("tracking", []),
    }
    hazard_events.append(event)

    # ── Push to driver via WebSocket ──────────────────────────────────────
    await manager.send(session_id, event)

    return {
        "session_id":     session_id,
        "skipped_by_aks": False,
        "routing":        routing,
        "pipeline":       result,
        "aks_stats":      result.get("aks_stats", {}),
        "hazard_events":  hazard_events,
    }


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/detect")
async def detect_image(
    file:       UploadFile = File(...),
    session_id: str   = Form(...),
    latitude:   float = Form(19.0760),
    longitude:  float = Form(72.8777),
    speed_kmh:  float = Form(0.0),
):
    raw = await file.read()
    return await _run_pipeline_on_frame(raw, session_id, latitude, longitude, speed_kmh)


@router.post("/detect/base64")
async def detect_base64(
    image_b64:  str   = Form(...),
    session_id: str   = Form(...),
    latitude:   float = Form(19.0760),
    longitude:  float = Form(72.8777),
    speed_kmh:  float = Form(0.0),
):
    try:
        raw = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid base64 payload")
    return await _run_pipeline_on_frame(raw, session_id, latitude, longitude, speed_kmh)


@router.get("/detect/session/{session_id}/stats")
def session_stats(session_id: str):
    """Return AKS + tracking stats for a live session."""
    state = ss.get(session_id)
    return {
        "session_id": session_id,
        "aks":        state.aks_stats(),
        "active_tracks": len(state.stalled_counters),
        "stalled_vehicles": sum(
            1 for c in state.stalled_counters.values() if c >= config.STALL_FRAMES
        ),
    }
