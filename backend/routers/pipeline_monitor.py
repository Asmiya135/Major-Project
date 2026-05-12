"""
WebSocket endpoint: /ws/pipeline/{session_id}

The client (PipelineMonitor page) sends video frames as base64 JSON messages.
For each frame, this endpoint streams back step-by-step pipeline results with
annotated images so the frontend can visualise what's happening in real time.

Also handles voice verification: receives base64 audio → Whisper → feedback.
"""

import json
import base64
import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import database
import config
from services import session_state as ss
from services.pipeline_visualizer import run_visual_pipeline

router = APIRouter(tags=["pipeline_monitor"])


@router.websocket("/ws/pipeline/{session_id}")
async def pipeline_monitor_ws(websocket: WebSocket, session_id: str):
    await websocket.accept()
    state = ss.get(session_id)

    try:
        await websocket.send_text(json.dumps({
            "type": "connected",
            "session_id": session_id,
            "message": "Pipeline monitor connected. Send frames to visualise each step.",
        }))

        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "keepalive"}))
                continue

            msg = json.loads(raw)

            # ── Video frame → run full visual pipeline ──────────────────────
            if msg.get("type") == "frame":
                try:
                    import numpy as np
                    import cv2

                    frame_b64  = msg["data"]
                    lat        = float(msg.get("latitude",  19.076))
                    lon        = float(msg.get("longitude", 72.877))
                    speed_kmh  = float(msg.get("speed_kmh", 0.0))

                    raw_bytes  = base64.b64decode(frame_b64)
                    arr        = np.frombuffer(raw_bytes, np.uint8)
                    frame_bgr  = cv2.imdecode(arr, cv2.IMREAD_COLOR)

                    if frame_bgr is None:
                        await websocket.send_text(json.dumps({
                            "type": "error", "message": "Cannot decode image bytes",
                        }))
                        continue

                    async def emit(data: dict):
                        await websocket.send_text(json.dumps(data))

                    result = await run_visual_pipeline(
                        frame_bgr, state, speed_kmh, lat, lon, emit)

                    await websocket.send_text(json.dumps({
                        "type":   "pipeline_complete",
                        "result": result,
                        "aks_stats": state.aks_stats(),
                    }))

                except Exception as e:
                    await websocket.send_text(json.dumps({
                        "type": "error", "message": str(e),
                    }))

            # ── Voice feedback (Whisper) ─────────────────────────────────────
            elif msg.get("type") == "voice_feedback":
                try:
                    from services.stt import transcribe, parse_feedback_response, is_available
                    if not is_available():
                        await websocket.send_text(json.dumps({
                            "type":      "voice_result",
                            "error":     "Whisper not installed",
                            "response":  "unsure",
                            "transcript": "",
                        }))
                        continue

                    audio_bytes = base64.b64decode(msg["audio_b64"])
                    hazard_id   = int(msg.get("hazard_id", 0))
                    transcript  = transcribe(audio_bytes)
                    response    = parse_feedback_response(transcript)

                    # Persist feedback
                    if hazard_id:
                        database.save_feedback(hazard_id, session_id, response)

                    await websocket.send_text(json.dumps({
                        "type":       "voice_result",
                        "transcript": transcript,
                        "response":   response,
                        "hazard_id":  hazard_id,
                    }))
                except Exception as e:
                    await websocket.send_text(json.dumps({
                        "type": "error", "message": f"STT error: {e}",
                    }))

            # ── Ping / keepalive ─────────────────────────────────────────────
            elif msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

            # ── Get current hazards for map ──────────────────────────────────
            elif msg.get("type") == "get_hazards":
                hazards = database.list_hazards()
                await websocket.send_text(json.dumps({
                    "type":    "hazards_update",
                    "hazards": hazards,
                }))

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
