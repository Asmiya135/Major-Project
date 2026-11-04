"""
Model 6 — GenAI verification question for MEDIUM-confidence hazards.

Claude looks at the (privacy-blurred) frame and the pipeline's measurements and writes one
short spoken question for the driver ("Is there a pothole in the left lane about 9 m ahead?").
Without credentials or network the question falls back to a template, so the human-in-the-loop
step always works in the demo.
"""
import base64

import config

_LABEL = {"pothole": "pothole", "speed_bump": "unmarked speed bump", "debris": "debris",
          "stalled_vehicle": "stalled vehicle"}


def template_question(h: dict) -> str:
    m = h.get("metrics", {})
    what = _LABEL.get(h["hazard_type"], h["hazard_type"].replace("_", " "))
    where = (m.get("lane") or "ahead").lower()
    dist = m.get("distance_m")
    tail = f", about {dist:.0f} metres ahead" if isinstance(dist, (int, float)) else ""
    return f"I may have spotted a {what} in the {where}{tail}. Is it really there? Please say yes or no."


def generate_question(h: dict, jpeg: bytes) -> tuple[str, str]:
    """Returns (question, source) where source is the model id or 'template'."""
    try:
        import anthropic
    except ImportError:
        return template_question(h), "template"
    m = h.get("metrics", {})
    facts = (
        f"Pipeline guess: {h['hazard_type']} (fusion score {h.get('fusion_score', 0):.2f}, below the auto-report threshold). "
        f"Lane: {m.get('lane')}. Estimated distance: {m.get('distance_m')} m. "
        f"Estimated size: {m.get('width_m')} m wide x {m.get('length_m')} m long, depth ~{m.get('depth_cm')} cm. "
        f"On road: {m.get('on_road')}."
    )
    try:
        client = anthropic.Anthropic(timeout=config.GENAI_TIMEOUT_S, max_retries=0)
        resp = client.beta.messages.create(
            model=config.GENAI_MODEL,
            max_tokens=300,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=("You help a driver confirm road hazards detected by a dashcam. Write ONE short, "
                    "friendly question (max 25 words) that will be read aloud. Describe what and where "
                    "the hazard is using the image and the facts, and end by asking the driver to answer "
                    "yes or no. Output only the question."),
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.standard_b64encode(jpeg).decode()}},
                {"type": "text", "text": facts},
            ]}],
        )
    except Exception:  # noqa: BLE001 — missing key, offline, rate limit: fall back to template
        return template_question(h), "template"
    if resp.stop_reason == "refusal":
        return template_question(h), "template"
    text = " ".join(b.text for b in resp.content if b.type == "text").strip()
    return (text or template_question(h)), (resp.model if text else "template")
