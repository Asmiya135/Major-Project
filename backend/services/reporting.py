"""
Model 5 — alert system for a newly detected hazard.

Every confirmed hazard (HIGH fusion score, or MEDIUM confirmed by the driver):
  1. is written to the on-device outbox (offline queue) with its privacy-blurred photo,
  2. is uploaded to the global server immediately if the car is online — otherwise it stays
     queued and the sync loop uploads it as soon as the network is back,
  3. is broadcast to nearby cars over Bluetooth V2X (they alert inside a 15 m geofence).
"""
import uuid
from datetime import datetime

import config
import database
from services import edge_store, sync
from services.bluetooth_v2x import v2x
from services.edge_state import state
from websocket_manager import manager


def new_report_uid() -> str:
    return f"{config.CLIENT_ID}-{uuid.uuid4().hex[:12]}"


def submit(payload: dict, jpeg: bytes | None, session_id: str = "") -> dict:
    image_path = None
    if jpeg:
        p = config.OUTBOX_DIR / f"{payload['report_uid']}.jpg"
        p.write_bytes(jpeg)
        image_path = str(p)

    online = state.is_online()
    oid = edge_store.enqueue(payload, image_path, offline=not online)
    bt = v2x.broadcast_hazard(payload)

    server = None
    if online:
        for s in sync.flush_outbox():
            if s["outbox_id"] == oid:
                server = s["response"]
    status = "sent_to_server" if server else "queued_offline"
    if not server:
        state.add_log("queue", f"{payload['hazard_type']} queued offline "
                               f"({edge_store.outbox_counts()['queued']} waiting)")

    m = payload.get("metrics", {})
    det_id = database.record_detection(
        session_id or "live", (server or {}).get("cluster_id"), payload["latitude"], payload["longitude"],
        payload["hazard_type"], payload["severity"], payload["fusion_score"],
        m.get("distance_m", 0.0), m.get("lane", ""), source="vehicle",
        needs_feedback=False,
    )
    event = {
        "type": "hazard_detected", "detection_id": det_id, "outbox_id": oid,
        "report_uid": payload["report_uid"], "hazard_id": (server or {}).get("cluster_id"),
        "hazard_type": payload["hazard_type"], "severity": payload["severity"],
        "confidence": payload["fusion_score"], "distance_m": m.get("distance_m", 0.0),
        "lane": m.get("lane", ""), "latitude": payload["latitude"], "longitude": payload["longitude"],
        "routing": payload["routing"], "verified": payload.get("verified", False),
        "delivery": status, "cluster_action": (server or {}).get("cluster_action"),
        "bt_transports": bt["transports"], "needs_feedback": False,
        "time": datetime.now().strftime("%H:%M:%S"),
    }
    manager.emit(event)
    manager.emit({"type": "outbox", **edge_store.outbox_counts()})
    return {"outbox_id": oid, "delivery": status, "server": server, "bluetooth": bt}
