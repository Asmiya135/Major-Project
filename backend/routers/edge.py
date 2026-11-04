"""
REST API of the car's edge agent: status, network switch, telemetry, offline queue,
Bluetooth V2X, route hazards, federated learning and driver verification.
"""
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

import config
from services import edge_store, sync, verification
from services.bluetooth_v2x import v2x
from services.edge_state import state
from services.fusion import engine
from websocket_manager import manager

router = APIRouter(tags=["edge"])


def full_status() -> dict:
    from services.pipeline import model_status
    return {**state.snapshot(), "outbox": edge_store.outbox_counts(), "fusion_model": engine.describe(),
            "fl_samples": len(edge_store.fl_samples()), "fl_unpushed": edge_store.fl_unpushed_count(),
            "pending_verifications": len(edge_store.list_verify("pending")), "models": model_status()}


@router.get("/edge/status")
def status():
    return full_status()


@router.get("/edge/log")
def log():
    return {"log": list(state.log)}


class NetworkIn(BaseModel):
    offline: bool


@router.post("/edge/network")
def set_network(body: NetworkIn):
    """Demo switch: simulate driving into / out of an area with no network."""
    state.forced_offline = body.offline
    sync.check_server()
    state.add_log("network", "OFFLINE (simulated) — new hazards will be queued on the car"
                  if body.offline else "network restored — flushing offline queue")
    flushed = [] if body.offline else sync.flush_outbox()
    manager.emit({"type": "network", "online": state.is_online(), "forced_offline": state.forced_offline})
    return {"online": state.is_online(), "flushed": len(flushed), "outbox": edge_store.outbox_counts()}


class TelemetryIn(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None
    speed_kmh: Optional[float] = None
    heading_deg: Optional[float] = None
    imu_peak: Optional[float] = None
    source: Optional[str] = None


@router.post("/edge/telemetry")
def telemetry(body: TelemetryIn):
    state.update_telemetry(**body.model_dump())
    v2x.check_geofence()
    return state.snapshot()


# ── Offline queue ──────────────────────────────────────────────────────────

@router.get("/edge/outbox")
def outbox():
    return {"items": edge_store.list_outbox(), **edge_store.outbox_counts()}


@router.post("/edge/outbox/flush")
def flush():
    sync.check_server()
    return {"sent": len(sync.flush_outbox()), **edge_store.outbox_counts()}


# ── Bluetooth V2X ──────────────────────────────────────────────────────────

@router.get("/v2x/status")
def v2x_status():
    return {"bt": state.bt_status, "peer_hazards": edge_store.peer_hazards()}


class V2XTestIn(BaseModel):
    hazard_type: str = "pothole"
    offset_m: float = 5.0     # place the test hazard this far ahead of the car


@router.post("/v2x/test")
def v2x_test(body: V2XTestIn):
    from services.edge_state import project
    t = state.telemetry
    lat, lon = project(t.lat, t.lon, t.heading_deg, body.offset_m)
    return v2x.broadcast_hazard({"hazard_type": body.hazard_type, "severity": "high",
                                 "latitude": lat, "longitude": lon, "fusion_score": 0.9})


# ── Demo drive: simulated detection of the pre-mapped hazard ───────────────

class DemoDetectIn(BaseModel):
    hazard_type: str = "pothole"
    latitude: float
    longitude: float
    distance_m: float = 20.0      # how far ahead of the car the "camera" sees it


_DEMO_SIGNALS = {"detection_conf": 0.88, "track_persistence": 1.0, "seg_area": 0.6, "depth": 0.55,
                 "on_road": 1.0, "optical_flow": 0.7, "imu_bump": 0.0}


def _demo_photo() -> bytes | None:
    """A real pothole photo for the server report (crop of the project's H1 sample image)."""
    try:
        import cv2
        img = cv2.imread(str(config.MODELS_ROOT / "images" / "H1.png"))
        ok, buf = cv2.imencode(".jpg", img[0:335, 372:990])
        return buf.tobytes() if ok else None
    except Exception:  # noqa: BLE001
        return None


@router.post("/demo/detect")
def demo_detect(body: DemoDetectIn):
    """Simulated road: the car 'sees' the pre-mapped hazard. Scored by the real fusion engine and
    sent the normal way — server (or offline queue) + Bluetooth V2X to nearby cars."""
    import uuid
    from datetime import datetime
    from services import reporting
    f = engine.score(_DEMO_SIGNALS)
    t = state.telemetry
    payload = {
        "report_uid": reporting.new_report_uid(), "client_id": config.CLIENT_ID,
        "client_name": config.CLIENT_NAME, "hazard_type": body.hazard_type, "severity": "high",
        "latitude": body.latitude, "longitude": body.longitude, "car_lat": t.lat, "car_lon": t.lon,
        "fusion_score": f["score"], "routing": "HIGH", "verified": False, "signals": _DEMO_SIGNALS,
        "metrics": {"distance_m": round(body.distance_m, 1), "width_m": 0.9, "length_m": 0.7, "area_m2": 0.44,
                    "depth_cm": 7.5, "on_road": True, "surface": "ON ROAD", "lane": "Center lane",
                    "source": "demo-simulated-road"},
        "bbox": [], "frame_w": 0, "frame_h": 0, "fusion_model_version": engine.version,
        "detected_at": datetime.utcnow().isoformat(timespec="seconds"), "demo_id": uuid.uuid4().hex[:8],
    }
    state.add_log("demo", f"simulated camera detected {body.hazard_type} {body.distance_m:.0f} m ahead "
                          f"(fusion {f['score']:.2f})")
    result = reporting.submit(payload, _demo_photo(), "demo")
    return {"fusion": f, **result}


# ── Hazards (known + on route) ─────────────────────────────────────────────

class RouteIn(BaseModel):
    coords: list[list[float]]


@router.post("/route/hazards")
def route_hazards(body: RouteIn):
    """Download hazards on the planned route from the server and cache them for offline use."""
    return sync.fetch_route_hazards(body.coords)


@router.get("/hazards")
def hazards():
    return {"hazards": sync.all_server_hazards(), "online": state.is_online()}


# ── Federated learning ─────────────────────────────────────────────────────

@router.get("/fl/status")
def fl_status():
    s = edge_store.fl_samples()
    return {"model": engine.describe(), "samples": len(s), "positives": sum(x["label"] for x in s),
            "unpushed": edge_store.fl_unpushed_count(), "auto_push_every": config.FL_AUTO_PUSH_EVERY}


@router.post("/fl/push")
def fl_push():
    sync.check_server()
    return sync.push_update()


@router.post("/fl/pull")
def fl_pull():
    sync.check_server()
    m = sync.pull_model()
    return {"server_model": m, "local_model": engine.describe()}


# ── Driver verification (human in the loop) ───────────────────────────────

@router.get("/verify/pending")
def verify_pending():
    items = edge_store.list_verify("pending")
    for v in items:
        v.pop("payload", None)
    return {"pending": items}


class AnswerIn(BaseModel):
    response: str     # yes | no | unsure


@router.post("/verify/{vid}/answer")
def verify_answer(vid: int, body: AnswerIn):
    if body.response not in ("yes", "no", "unsure"):
        raise HTTPException(422, "response must be yes, no or unsure")
    return verification.answer(vid, body.response, "(button)")


@router.post("/verify/{vid}/voice")
async def verify_voice(vid: int, audio: UploadFile = File(...)):
    from services.stt import is_available, parse_feedback_response, transcribe
    if not is_available():
        raise HTTPException(503, "Whisper not installed — use the Yes / No buttons")
    import asyncio
    text = await asyncio.to_thread(transcribe, await audio.read())
    return verification.answer(vid, parse_feedback_response(text), text)


@router.get("/verify/{vid}/image")
def verify_image(vid: int):
    v = edge_store.get_verify(vid)
    if not v or not v["image_path"]:
        raise HTTPException(404, "not found")
    return FileResponse(v["image_path"], media_type="image/jpeg")
