"""
Volkswagen Hazard Detection — CLIENT EDGE AGENT (runs on each car).

Run (one per car):
  set CLIENT_ID=car-A && python -m uvicorn main:app --port 8001
  set CLIENT_ID=car-B && python -m uvicorn main:app --port 8002

Every ML model runs here, on the car. The car talks to the one global server
(SERVER_URL) when it has network, and to nearby cars over Bluetooth when it doesn't.
"""
import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import config
import database
from routers import detect, edge, pipeline_monitor, system, trips
from services import edge_store, session_state as ss, sync
from services.bluetooth_v2x import v2x
from services.edge_state import state, haversine_m
from websocket_manager import manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    edge_store.init()
    manager.set_loop(asyncio.get_running_loop())
    v2x.start()
    state.add_log("boot", f"{config.CLIENT_ID} edge agent up — server {config.SERVER_URL}")
    tasks = [asyncio.create_task(sync.sync_loop()),
             asyncio.create_task(_status_loop()),
             asyncio.create_task(_cleanup_loop())]
    if config.WARMUP_MODELS:
        from services.pipeline import warmup
        warmup()
    yield
    for t in tasks:
        t.cancel()


async def _status_loop():
    """Push the car's live status (network, queue, BT, capture policy, FL model) to every UI."""
    while True:
        await asyncio.sleep(1.0)
        if manager.active_sessions():
            try:
                await manager.broadcast({"type": "status", **edge.full_status()})
            except Exception:  # noqa: BLE001
                pass


async def _cleanup_loop():
    while True:
        await asyncio.sleep(600)
        ss.cleanup_expired()


app = FastAPI(title=f"VW Hazard Detection — Car edge agent ({config.CLIENT_ID})", version="4.0.0",
              lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=config.CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trips.router, prefix="/api")
app.include_router(detect.router, prefix="/api")
app.include_router(system.router, prefix="/api")
app.include_router(edge.router, prefix="/api")
app.include_router(pipeline_monitor.router)


# ── Known-hazard alerts along the route (works offline from the cache) ─────
_route_alerted: set = set()


def _route_alerts() -> list:
    t = state.telemetry
    out = []
    for h in edge_store.route_cache():
        if h["id"] in _route_alerted:
            continue
        d = haversine_m(t.lat, t.lon, h["latitude"], h["longitude"])
        if d <= config.ROUTE_ALERT_M:
            _route_alerted.add(h["id"])     # one alert per server cluster
            out.append({
                "type": "hazard_alert", "hazard": h, "distance_m": round(d),
                "message": f"⚠ {h['hazard_type'].replace('_', ' ').title()} in {d:.0f} m — "
                           f"{h['severity']} severity ({h.get('count', 1)} reports)",
            })
    return out


@app.websocket("/ws/events")
async def events_ws(websocket: WebSocket):
    """UI ⇄ car: the UI streams telemetry in; the car streams every event out."""
    key = await manager.connect(websocket)
    await manager.send(key, {"type": "connected", **edge.full_status()})
    try:
        while True:
            try:
                msg = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=30.0))
            except asyncio.TimeoutError:
                await manager.send(key, {"type": "keepalive"})
                continue
            t = msg.get("type")
            if t == "telemetry":
                state.update_telemetry(**{k: msg.get(k) for k in
                                          ("lat", "lon", "speed_kmh", "heading_deg", "imu_peak", "source")})
                v2x.check_geofence()
                for a in _route_alerts():
                    await manager.broadcast(a)
            elif t == "reset_route_alerts":
                _route_alerted.clear()
            elif t == "ping":
                await manager.send(key, {"type": "pong"})
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        manager.disconnect(key)


@app.get("/")
def root():
    return {"service": "vw-hazard-car-edge", "client_id": config.CLIENT_ID, "server": config.SERVER_URL,
            "docs": "/docs"}
