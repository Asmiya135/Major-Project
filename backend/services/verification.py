"""
Model 6 — human in the loop for MEDIUM-confidence hazards.

The hazard is NOT sent anywhere yet. The driver sees the photo, hears a GenAI-written
question and answers by voice (Whisper) or by tapping Yes / No:
  yes    → reported like a HIGH hazard (server + offline queue + Bluetooth), photo becomes
           a verified training image on the server, and a positive federated-learning sample
  no     → discarded; stored only as a negative federated-learning sample on this car
  unsure → discarded, no label
"""
import base64
import threading

import config
from services import edge_store, genai, reporting, sync
from websocket_manager import manager


def create(payload: dict, full_jpeg: bytes, crop_jpeg: bytes, session_id: str) -> int:
    img_path = config.VERIFY_DIR / f"{payload['report_uid']}.jpg"
    img_path.write_bytes(full_jpeg)
    question = genai.template_question(payload)
    vid = edge_store.add_verify({**payload, "_session_id": session_id}, str(img_path), question, "template")
    crop_b64 = base64.b64encode(crop_jpeg).decode()
    manager.emit({
        "type": "verify_request", "verify_id": vid, "hazard_type": payload["hazard_type"],
        "fusion_score": payload["fusion_score"], "severity": payload["severity"],
        "metrics": payload.get("metrics", {}), "question": question, "question_source": "template",
        "generating": True, "image_b64": crop_b64,
    })

    def _gen():
        q, src = genai.generate_question(payload, full_jpeg)
        edge_store.set_verify_question(vid, q, src)
        manager.emit({"type": "verify_question", "verify_id": vid, "question": q,
                      "question_source": src, "generating": False})
    threading.Thread(target=_gen, daemon=True).start()
    return vid


def answer(vid: int, response: str, transcript: str = "") -> dict:
    v = edge_store.get_verify(vid)
    if not v:
        return {"error": "not found"}
    if v["status"] != "pending":
        return {"error": f"already answered: {v['status']}"}
    edge_store.answer_verify(vid, response, transcript)
    payload = dict(v["payload"])
    session_id = payload.pop("_session_id", "")
    result = {"verify_id": vid, "response": response, "transcript": transcript}

    if response == "yes":
        payload["verified"] = True
        payload["routing"] = "MEDIUM_CONFIRMED"
        jpeg = open(v["image_path"], "rb").read() if v["image_path"] else None
        result["report"] = reporting.submit(payload, jpeg, session_id)
        edge_store.add_fl_sample(payload["signals"], 1, "driver_yes")
    elif response == "no":
        edge_store.add_fl_sample(payload["signals"], 0, "driver_no")

    result["fl_samples"] = len(edge_store.fl_samples())
    manager.emit({"type": "verify_result", **result})
    sync.maybe_auto_push()
    return result
