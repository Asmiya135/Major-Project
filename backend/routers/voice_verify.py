"""
REST endpoint for voice-based hazard verification (Step 10 of pipeline).
Driver uploads a short audio clip; Whisper transcribes it; Bayesian trust update
applied to the hazard confidence.
"""

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from pydantic import BaseModel

import database
from services.stt import transcribe, parse_feedback_response, is_available

router = APIRouter(tags=["voice_verify"])


@router.get("/voice/status")
def whisper_status():
    return {
        "whisper_available": is_available(),
        "install_cmd": "pip install openai-whisper" if not is_available() else None,
    }


@router.post("/voice/verify")
async def voice_verify(
    audio:      UploadFile = File(...),
    hazard_id:  int        = Form(...),
    session_id: str        = Form(...),
):
    """
    Upload a WAV/MP3/OGG audio clip.
    Returns transcript, parsed response (yes/no/unsure), and updated hazard confidence.
    """
    if not is_available():
        raise HTTPException(
            status_code=503,
            detail="Whisper not installed. Run: pip install openai-whisper"
        )

    hazard = database.get_hazard(hazard_id)
    if not hazard:
        raise HTTPException(status_code=404, detail="Hazard not found")

    audio_bytes = await audio.read()
    transcript  = transcribe(audio_bytes)
    response    = parse_feedback_response(transcript)

    database.save_feedback(hazard_id, session_id, response)
    updated = database.get_hazard(hazard_id)

    return {
        "transcript":          transcript,
        "response":            response,
        "hazard_id":           hazard_id,
        "old_confidence":      hazard["confidence"],
        "new_confidence":      updated["confidence"] if updated else hazard["confidence"],
        "hazard_verified":     response == "yes",
    }
