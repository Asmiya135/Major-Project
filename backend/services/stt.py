"""
Whisper Speech-to-Text for voice-based hazard verification (Step 10).

Installation (run once):
    pip install openai-whisper
    # Windows: also install ffmpeg
    #   choco install ffmpeg   (or download from ffmpeg.org and add to PATH)

Model sizes: tiny < base < small < medium < large
'base' is a good balance of accuracy and speed for on-device use.
"""

import os
import tempfile
from pathlib import Path
from typing import Optional

_model = None
_model_size = os.getenv("WHISPER_MODEL", "base")   # tiny | base | small | medium


def load_model():
    global _model
    if _model is not None:
        return _model
    try:
        import whisper
        print(f"[STT] Loading Whisper '{_model_size}' model…")
        _model = whisper.load_model(_model_size)
        print("[STT] Whisper loaded ✓")
        return _model
    except ImportError:
        raise RuntimeError(
            "Whisper not installed. Run:  pip install openai-whisper\n"
            "Also install ffmpeg (required by Whisper)."
        )


def transcribe(audio_bytes: bytes, language: Optional[str] = None) -> str:
    """
    Transcribe raw audio bytes (WAV/MP3/OGG) to text.
    Returns the transcribed string.
    """
    model = load_model()
    suffix = ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name
    try:
        opts = {"fp16": False}
        if language:
            opts["language"] = language
        result = model.transcribe(tmp_path, **opts)
        return (result.get("text") or "").strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def parse_feedback_response(text: str) -> str:
    """
    Extract yes / no / unsure from a free-form spoken response.
    Returns one of: "yes" | "no" | "unsure"
    """
    t = text.lower()

    YES_WORDS = {"yes", "yeah", "yep", "yup", "correct", "right", "true",
                 "confirm", "confirmed", "pothole", "hazard", "danger",
                 "absolutely", "definitely", "sure", "haan", "ha"}
    NO_WORDS  = {"no", "nope", "nah", "negative", "false", "wrong", "clear",
                 "empty", "nothing", "not", "none", "safe", "nahi", "na"}

    words = set(t.split())
    if words & YES_WORDS:
        return "yes"
    if words & NO_WORDS:
        return "no"
    return "unsure"


def is_available() -> bool:
    try:
        import whisper  # noqa
        return True
    except ImportError:
        return False
