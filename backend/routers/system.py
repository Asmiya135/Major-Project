from fastapi import APIRouter

from services import edge_store, session_state as ss
from services.edge_state import state
from websocket_manager import manager

router = APIRouter(tags=["system"])


@router.get("/system/status")
def system_status():
    from services.pipeline import model_status
    pipe = model_status()
    return {
        "status": "ok",
        "client_id": state.snapshot()["client_id"],
        "cameras": True,
        "gps": True,
        "map": True,
        "hazards_synced": state.is_online() or bool(edge_store.route_cache()),
        "network": True,          # offline is a supported mode, not a blocker
        "online": state.is_online(),
        "sensors": True,
        "pipeline": pipe,
        "active_ui_sockets": len(manager.active_sessions()),
        "active_pipeline_sessions": len(ss.active_sessions()),
    }


@router.get("/system/health")
def health():
    return {"status": "healthy", "role": "client-edge"}
