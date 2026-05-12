import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import database

router = APIRouter(tags=["trips"])


class TripStart(BaseModel):
    session_id: Optional[str] = None


class TripEnd(BaseModel):
    session_id: str
    distance_km: float = 0
    avg_speed_km: float = 0
    hazards_avoided: int = 0
    hazards_reported: int = 0


@router.post("/trips/start")
def start_trip(body: TripStart):
    sid = body.session_id or str(uuid.uuid4())
    trip_id = database.create_trip(sid)
    return {"session_id": sid, "trip_id": trip_id, "status": "active"}


@router.post("/trips/end")
def end_trip(body: TripEnd):
    database.end_trip(
        body.session_id,
        body.distance_km,
        body.avg_speed_km,
        body.hazards_avoided,
        body.hazards_reported,
    )
    trip = database.get_trip(body.session_id)
    detections = database.get_trip_detections(body.session_id)
    return {
        "trip": trip,
        "detections": detections,
        "total_hazards_detected": len(detections),
    }


@router.get("/trips/{session_id}")
def get_trip(session_id: str):
    trip = database.get_trip(session_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip


@router.get("/trips/{session_id}/summary")
def get_trip_summary(session_id: str):
    trip = database.get_trip(session_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    detections = database.get_trip_detections(session_id)
    pending = database.get_pending_feedback(session_id)

    types_seen = {}
    for d in detections:
        t = d["hazard_type"]
        types_seen[t] = types_seen.get(t, 0) + 1

    return {
        "trip": trip,
        "detections": detections,
        "pending_feedback": pending,
        "hazard_breakdown": types_seen,
        "total_detected": len(detections),
    }
