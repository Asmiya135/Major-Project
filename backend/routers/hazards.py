from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional
import database

router = APIRouter(tags=["hazards"])


class HazardIn(BaseModel):
    latitude: float
    longitude: float
    confidence: float
    hazard_type: str
    severity: str = "medium"
    session_id: Optional[str] = None


@router.get("/hazards")
def get_hazards(
    hazard_type: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    since_hours: Optional[int] = Query(None),
):
    return {"hazards": database.list_hazards(hazard_type, severity, since_hours)}


@router.get("/hazards/{hazard_id}")
def get_hazard(hazard_id: int):
    h = database.get_hazard(hazard_id)
    if not h:
        raise HTTPException(status_code=404, detail="Hazard not found")
    return h


@router.post("/hazards")
def upload_hazard(h: HazardIn):
    nearby_id = database.find_nearby_hazard(h.latitude, h.longitude, threshold_m=50, hazard_type=h.hazard_type)
    if nearby_id:
        database.update_hazard(nearby_id, h.latitude, h.longitude, h.confidence)
        return {"status": "merged", "hazard_id": nearby_id}
    new_id = database.insert_hazard(h.latitude, h.longitude, h.hazard_type, h.confidence, h.severity)
    return {"status": "created", "hazard_id": new_id}
