"""
Central configuration — every path, threshold, and env-var lives here.
Nothing else in the codebase should hardcode paths or magic numbers.
"""
import os
from pathlib import Path

# ── Directory roots ────────────────────────────────────────────────────────
BACKEND_DIR  = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent
MODELS_ROOT  = PROJECT_ROOT / "models" / "Volkswagen-imobilothon-5.0-QUISK"

# ── Model file paths ───────────────────────────────────────────────────────
HEAD1_MODEL       = MODELS_ROOT / "Head_1-final"   / "model" / "best.pt"
HEAD2_SEG_MODEL   = MODELS_ROOT / "H2Segmentation" / "model" / "YoloV8Segmented.pt"
HEAD3_DEPTH_MODEL = MODELS_ROOT / "H2Segmentation" / "model" / "midas_v21_small_256.pt"
HEAD4_ROAD_MODEL  = MODELS_ROOT / "H4RoadMask"     / "model" / "fast_scnn_citys.pth"
HEAD4_VEH_MODEL   = MODELS_ROOT / "H4RoadMask"     / "model" / "yolo11n-seg.pt"
HEAD5_DET_MODEL   = MODELS_ROOT / "stalledVehicle" / "models" / "yolo11n.pt"
FACE_ONNX_MODEL   = MODELS_ROOT / "privacy"        / "models" / "face_detection_model.onnx"
PLATE_PT_MODEL    = MODELS_ROOT / "privacy"        / "models" / "license_plate_detector.pt"
DEHAZE_MODEL      = MODELS_ROOT / "dehazing"       / "models" / "dehazer.pth"

# sys.path additions needed for sub-module imports
FAST_SCNN_DIR     = MODELS_ROOT / "H4RoadMask" / "Fast_SCNN"
STALLED_DIR       = MODELS_ROOT / "stalledVehicle"

# ── Database ───────────────────────────────────────────────────────────────
DB_FILE = str(BACKEND_DIR / "hazards.db")

# ── MQTT ───────────────────────────────────────────────────────────────────
MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
MQTT_PORT   = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC  = os.getenv("MQTT_TOPIC", "volkswagen/hazard")

# ── Speech-to-Text (voice verification) ───────────────────────────────────
# Set STT_PROVIDER=google to use Google Cloud Speech; default uses local Whisper
STT_PROVIDER       = os.getenv("STT_PROVIDER", "whisper")   # "whisper" | "google"
GOOGLE_SPEECH_KEY  = os.getenv("GOOGLE_SPEECH_API_KEY", "")

# ── Pipeline thresholds ────────────────────────────────────────────────────
# Confidence routing: high → alert immediately, medium → human verify, low → discard
FUSION_HIGH_THRESHOLD   = float(os.getenv("FUSION_HIGH_THRESHOLD",   "0.75"))
FUSION_MEDIUM_THRESHOLD = float(os.getenv("FUSION_MEDIUM_THRESHOLD", "0.40"))

# AKS (Adaptive Keyframe Sampling)
AKS_MOTION_THRESHOLD = float(os.getenv("AKS_MOTION_THRESHOLD", "15.0"))  # pixel diff
AKS_SLOW_SKIP        = int(os.getenv("AKS_SLOW_SKIP",   "5"))   # frames to skip at low speed
AKS_MEDIUM_SKIP      = int(os.getenv("AKS_MEDIUM_SKIP", "2"))   # frames to skip at medium speed
AKS_SPEED_SLOW_KMH   = float(os.getenv("AKS_SPEED_SLOW_KMH",   "20.0"))
AKS_SPEED_MEDIUM_KMH = float(os.getenv("AKS_SPEED_MEDIUM_KMH", "60.0"))

# SORT / stalled vehicle
STALL_FRAMES         = int(os.getenv("STALL_FRAMES",    "20"))
STALL_RESIDUAL_PX    = float(os.getenv("STALL_RESIDUAL_PX", "1.5"))

# Haversine deduplication radius
DEDUP_RADIUS_M = float(os.getenv("DEDUP_RADIUS_M", "50.0"))

# Session cleanup: expire inactive sessions after N minutes
SESSION_TTL_MIN = int(os.getenv("SESSION_TTL_MIN", "60"))

# ── CORS allowed origins ───────────────────────────────────────────────────
CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"
).split(",")
