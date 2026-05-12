from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import database

router = APIRouter(tags=["feedback"])


class FeedbackIn(BaseModel):
    hazard_id: int
    session_id: str
    response: str   # "yes" | "no" | "unsure"


@router.post("/feedback")
def submit_feedback(body: FeedbackIn):
    if body.response not in ("yes", "no", "unsure"):
        raise HTTPException(status_code=422, detail="response must be yes, no, or unsure")
    h = database.get_hazard(body.hazard_id)
    if not h:
        raise HTTPException(status_code=404, detail="Hazard not found")
    database.save_feedback(body.hazard_id, body.session_id, body.response)
    return {"status": "saved", "hazard_id": body.hazard_id, "response": body.response}


@router.get("/feedback/pending/{session_id}")
def pending_feedback(session_id: str):
    items = database.get_pending_feedback(session_id)
    return {"pending": items}
