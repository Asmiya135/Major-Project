"""
/api/detect               — POST one image, run the on-car pipeline, return the result (scripts / tests)
/api/detect/video/upload  — POST a dashcam video; process it via /ws/pipeline {"type":"process_video"}
"""
import asyncio
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from services import session_state as ss

router = APIRouter(tags=["detect"])

_VIDEO_TEMP_DIR = Path(tempfile.gettempdir()) / "vw_hazard_videos"
_VIDEO_TEMP_DIR.mkdir(exist_ok=True)
video_store: dict[str, str] = {}


@router.post("/detect")
async def detect_image(file: UploadFile = File(...), session_id: str = Form("api")):
    import cv2
    import numpy as np
    from services.pipeline import process_frame
    frame = cv2.imdecode(np.frombuffer(await file.read(), np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(422, "Cannot decode image")
    sess = ss.get(session_id)
    sess.note_capture()
    steps = []
    result = await asyncio.to_thread(process_frame, frame, sess, steps.append, session_id)
    summary = [{k: v for k, v in s.items() if k != "data"} | {
        "data": {k: v for k, v in s.get("data", {}).items() if k != "images"}}
        for s in steps if s["type"] == "step_result"]
    return {"result": result, "steps": summary}


@router.post("/detect/video/upload")
async def upload_video(file: UploadFile = File(...), session_id: str = Form(...)):
    video_id = uuid.uuid4().hex[:12]
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    dest = _VIDEO_TEMP_DIR / f"{video_id}{suffix}"
    raw = await file.read()
    dest.write_bytes(raw)
    video_store[video_id] = str(dest)
    total_frames, fps = 0, 30.0
    try:
        import cv2
        cap = cv2.VideoCapture(str(dest))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        cap.release()
    except Exception:  # noqa: BLE001
        pass
    return {"video_id": video_id, "session_id": session_id, "filename": file.filename,
            "total_frames": total_frames, "fps": round(fps, 2), "size_bytes": len(raw)}
