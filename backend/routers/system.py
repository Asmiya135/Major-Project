from fastapi import APIRouter
from websocket_manager import manager
from services import session_state as ss

router = APIRouter(tags=["system"])


@router.get("/system/status")
def system_status():
    try:
        from services.pipeline import model_status
        pipe = model_status()
    except Exception:
        pipe = {"models_loaded": False}
    return {
        "status":        "ok",
        "cameras":       True,
        "gps":           True,
        "map":           True,
        "hazards_synced": True,
        "network":       True,
        "sensors":       True,
        "pipeline":      pipe,
        "active_drive_sessions": len(manager.active_sessions()),
        "active_pipeline_sessions": len(ss.active_sessions()),
    }


@router.get("/system/health")
def health():
    return {"status": "healthy"}
