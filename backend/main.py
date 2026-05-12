"""
Volkswagen Intelligent Hazard Detection — Backend API
Run: uvicorn main:app --reload --port 8000
"""
import json
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import config
import database
from websocket_manager import manager
from routers import hazards, trips, feedback, detect, system, pipeline_monitor, voice_verify
from services import session_state as ss


# ── Startup / shutdown ─────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    _seed_demo_hazards()
    # Periodic session cleanup task
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


def _seed_demo_hazards():
    """Five demo hazards near Mumbai so the map isn't empty on first run."""
    if database.list_hazards():
        return
    seeds = [
        (19.0760, 72.8777, "pothole",        0.91, "high"),
        (19.0820, 72.8820, "debris",          0.72, "medium"),
        (19.0700, 72.8700, "pothole",         0.65, "medium"),
        (19.0880, 72.8900, "bump",            0.80, "low"),
        (19.0640, 72.8650, "stalled_vehicle", 0.88, "high"),
    ]
    for lat, lon, t, conf, sev in seeds:
        database.insert_hazard(lat, lon, t, conf, sev)


async def _cleanup_loop():
    """Remove expired sessions every 10 minutes."""
    while True:
        await asyncio.sleep(600)
        removed = ss.cleanup_expired()
        if removed:
            print(f"[Cleanup] Removed {removed} expired sessions")


# ── App ────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Volkswagen Hazard Detection API",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(hazards.router,          prefix="/api")
app.include_router(trips.router,            prefix="/api")
app.include_router(feedback.router,         prefix="/api")
app.include_router(detect.router,           prefix="/api")
app.include_router(system.router,           prefix="/api")
app.include_router(voice_verify.router,     prefix="/api")
app.include_router(pipeline_monitor.router)   # mounts /ws/pipeline/{id}


# ── WebSocket drive feed ───────────────────────────────────────────────────

@app.websocket("/ws/drive/{session_id}")
async def websocket_drive(websocket: WebSocket, session_id: str):
    await manager.connect(websocket, session_id)
    # Ensure session state exists for this drive
    ss.get(session_id)

    try:
        await manager.send(session_id, {
            "type": "connected",
            "session_id": session_id,
            "message": "Drive session started. AI pipeline active.",
        })

        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                msg = json.loads(raw)

                if msg.get("type") == "ping":
                    await manager.send(session_id, {"type": "pong"})

                elif msg.get("type") == "speed_update":
                    speed = float(msg.get("speed_kmh", 0))
                    # Adaptive capture rate recommendation
                    rate = 5.0 if speed < 20 else (3.0 if speed < 60 else 2.0)
                    await manager.send(session_id, {
                        "type": "capture_rate", "capture_rate_s": rate,
                    })

                elif msg.get("type") == "location_update":
                    lat = float(msg.get("latitude",  0))
                    lon = float(msg.get("longitude", 0))
                    # Warn about any known hazard within 200 m
                    nearby = database.find_nearby_hazard(lat, lon, threshold_m=200)
                    if nearby:
                        h = database.get_hazard(nearby)
                        if h:
                            await manager.send(session_id, {
                                "type":    "hazard_alert",
                                "hazard":  h,
                                "message": f"Caution: {h['hazard_type']} ahead",
                            })

                elif msg.get("type") == "aks_stats_request":
                    state = ss.get(session_id)
                    await manager.send(session_id, {
                        "type":     "aks_stats",
                        "stats":    state.aks_stats(),
                        "tracking": len(state.stalled_counters),
                    })

            except asyncio.TimeoutError:
                await manager.send(session_id, {"type": "keepalive"})

    except WebSocketDisconnect:
        manager.disconnect(session_id)
    except Exception:
        manager.disconnect(session_id)


@app.get("/")
def root():
    return {
        "name":    "Volkswagen Hazard Detection API",
        "version": "3.0.0",
        "docs":    "/docs",
        "active_sessions": len(ss.active_sessions()),
    }
