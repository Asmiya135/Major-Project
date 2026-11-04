"""
WebSocket /ws/pipeline/{session_id} — live camera / dashcam-video processing on the car.

Client → edge:
  {"type":"frame", "data": <base64 JPEG>}       one captured camera frame
  {"type":"process_video", "video_id": "..."}   process an uploaded dashcam video
  {"type":"stop_video"}
Edge → client:
  frame_ack, step_start, step_result (one per pipeline step), pipeline_complete,
  video_* progress, plus every global event (status, verify_request, bt_alert …).

Frames are captured at the speed-dependent rate (Model 1). If the models are still busy
with the previous frame, only the newest waiting frame is kept (older ones are dropped).
"""
import asyncio
import base64
import json
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services import session_state as ss
from services.edge_state import state, capture_policy
from websocket_manager import manager

router = APIRouter(tags=["pipeline"])


@router.websocket("/ws/pipeline/{session_id}")
async def pipeline_ws(websocket: WebSocket, session_id: str):
    await websocket.accept()
    key = manager.register(websocket)
    sess = ss.get(session_id)
    loop = asyncio.get_running_loop()
    out_q: asyncio.Queue = asyncio.Queue()
    pending = {"frame": None}
    wake = asyncio.Event()
    video_task = {"task": None}

    def emit(msg: dict):
        loop.call_soon_threadsafe(out_q.put_nowait, msg)

    async def sender():
        while True:
            msg = await out_q.get()
            await manager.send(key, msg)        # shares the socket's send lock with broadcasts

    async def run_one(frame_bgr):
        from services.pipeline import process_frame
        result = await asyncio.to_thread(process_frame, frame_bgr, sess, emit, session_id)
        emit({"type": "pipeline_complete", "result": result, "stats": sess.stats()})
        return result

    async def worker():
        while True:
            await wake.wait()
            wake.clear()
            frame, pending["frame"] = pending["frame"], None
            if frame is None:
                continue
            try:
                await run_one(frame)
            except Exception as e:  # noqa: BLE001
                emit({"type": "error", "message": f"pipeline error: {e}"})
            if pending["frame"] is not None:
                wake.set()

    async def process_video(msg):
        import cv2
        from routers.detect import video_store
        path = video_store.get(msg.get("video_id", ""))
        if not path or not os.path.exists(path):
            emit({"type": "error", "message": "Video not found on the car. Please re-upload."})
            return
        cap = cv2.VideoCapture(path)
        vfps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
        emit({"type": "video_start", "total_frames": total, "video_fps": round(vfps, 2)})
        idx = processed = 0
        try:
            while True:
                # Model 1 on video: sample the file at the speed-dependent rate
                pol = capture_policy(state.telemetry.speed_kmh)
                step = max(1, round(vfps / pol["target_fps"]))
                ok = True
                for _ in range(step):
                    ok, frame = cap.read()
                    idx += 1
                    if not ok:
                        break
                if not ok:
                    break
                sess.note_capture()
                processed += 1
                emit({"type": "video_frame_start", "frame_number": processed, "raw_frame": idx,
                      "total_frames": total, "sample_every": step, "target_fps": pol["target_fps"],
                      "video_time_s": round(idx / vfps, 1)})
                await run_one(frame)
        finally:
            cap.release()
            emit({"type": "video_complete", "frames_processed": processed, "stats": sess.stats()})

    send_task = asyncio.create_task(sender())
    work_task = asyncio.create_task(worker())
    emit({"type": "connected", "session_id": session_id, "capture_policy":
          capture_policy(state.telemetry.speed_kmh), "status": state.snapshot()})
    try:
        while True:
            msg = json.loads(await websocket.receive_text())
            t = msg.get("type")
            if t == "frame":
                import cv2
                import numpy as np
                frame = cv2.imdecode(np.frombuffer(base64.b64decode(msg["data"]), np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    emit({"type": "error", "message": "cannot decode frame"})
                    continue
                sess.note_capture()
                if pending["frame"] is not None:
                    sess.frames_dropped_busy += 1
                pending["frame"] = frame
                wake.set()
                emit({"type": "frame_ack", "stats": sess.stats(),
                      "capture_policy": capture_policy(state.telemetry.speed_kmh)})
            elif t == "process_video":
                if video_task["task"] and not video_task["task"].done():
                    video_task["task"].cancel()
                video_task["task"] = asyncio.create_task(process_video(msg))
            elif t == "stop_video":
                if video_task["task"]:
                    video_task["task"].cancel()
                    emit({"type": "video_complete", "stopped": True, "stats": sess.stats()})
            elif t == "reset_session":
                ss.remove(session_id)
                sess = ss.get(session_id)
            elif t == "ping":
                emit({"type": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        manager.disconnect(key)
        for task in (send_task, work_task, video_task["task"]):
            if task:
                task.cancel()
