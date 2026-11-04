"""
CLIENT (car) edge-agent configuration. Each car runs its own copy of this agent.
Every path, threshold, and env-var lives here — nothing else hardcodes them.

Run two cars on one machine:
  CLIENT_ID=car-A EDGE_PORT=8001  python -m uvicorn main:app --port 8001
  CLIENT_ID=car-B EDGE_PORT=8002  python -m uvicorn main:app --port 8002
"""
import os
from pathlib import Path

# ── Identity ───────────────────────────────────────────────────────────────
CLIENT_ID   = os.getenv("CLIENT_ID", "car-A")
CLIENT_NAME = os.getenv("CLIENT_NAME", CLIENT_ID)
EDGE_PORT   = int(os.getenv("EDGE_PORT", "8001"))

# Global server this car syncs with
SERVER_URL  = os.getenv("SERVER_URL", "http://localhost:8000").rstrip("/")
SERVER_TIMEOUT_S = float(os.getenv("SERVER_TIMEOUT_S", "3.0"))
SYNC_INTERVAL_S  = float(os.getenv("SYNC_INTERVAL_S", "3.0"))

# ── Directory roots ────────────────────────────────────────────────────────
BACKEND_DIR  = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent
MODELS_ROOT  = PROJECT_ROOT / "Volkswagen-imobilothon-5.0-QUISK"
CLIENT_DATA_DIR = Path(os.getenv("CLIENT_DATA_DIR", str(BACKEND_DIR / "client_data" / CLIENT_ID)))
OUTBOX_DIR   = CLIENT_DATA_DIR / "outbox"
VERIFY_DIR   = CLIENT_DATA_DIR / "verify"
LOCAL_MODELS_DIR = CLIENT_DATA_DIR / "models"
for _d in (CLIENT_DATA_DIR, OUTBOX_DIR, VERIFY_DIR, LOCAL_MODELS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ── Model file paths ───────────────────────────────────────────────────────
HEAD1_MODEL       = MODELS_ROOT / "Head_1-final"   / "model" / "best.pt"
HEAD2_SEG_MODEL   = MODELS_ROOT / "H2Segmentation" / "model" / "YoloV8Segmented.pt"
HEAD3_DEPTH_MODEL = MODELS_ROOT / "H2Segmentation" / "model" / "midas_v21_small_256.pt"
HEAD4_ROAD_MODEL  = MODELS_ROOT / "H4RoadMask"     / "model" / "fast_scnn_citys.pth"
HEAD5_DET_MODEL   = MODELS_ROOT / "stalledVehicle" / "models" / "yolo11n.pt"
FACE_ONNX_MODEL   = MODELS_ROOT / "privacy"        / "models" / "face_detection_model.onnx"
PLATE_PT_MODEL    = MODELS_ROOT / "privacy"        / "models" / "license_plate_detector.pt"
DEHAZE_MODEL      = MODELS_ROOT / "dehazing"       / "models" / "dehazer.pth"

FAST_SCNN_DIR     = MODELS_ROOT / "H4RoadMask" / "Fast_SCNN"
STALLED_DIR       = MODELS_ROOT / "stalledVehicle"

# ── Local databases ────────────────────────────────────────────────────────
DB_FILE    = str(CLIENT_DATA_DIR / "trips.db")       # trips + per-drive detections
EDGE_DB    = str(CLIENT_DATA_DIR / "edge.db")        # outbox, route cache, V2X, FL samples
FUSION_WEIGHTS_FILE = CLIENT_DATA_DIR / "fusion_model.json"

# ── Model 1: capture-rate policy + AKS duplicate filter ────────────────────
# Target FPS = speed (m/s) / metres of road each frame should cover, clamped.
CAPTURE_COVERAGE_M = float(os.getenv("CAPTURE_COVERAGE_M", "5.0"))
CAPTURE_MIN_FPS    = float(os.getenv("CAPTURE_MIN_FPS", "0.5"))
CAPTURE_MAX_FPS    = float(os.getenv("CAPTURE_MAX_FPS", "4.0"))
# A frame whose mean pixel difference from the last processed frame is below this is a duplicate
AKS_DUP_THRESHOLD  = float(os.getenv("AKS_DUP_THRESHOLD", "4.0"))
# …but never skip more than this many in a row (forced keyframe)
AKS_MAX_CONSECUTIVE_SKIPS = int(os.getenv("AKS_MAX_CONSECUTIVE_SKIPS", "4"))

# ── Model 2: dehaze / low-light gating ─────────────────────────────────────
HAZE_DARK_CHANNEL_T = float(os.getenv("HAZE_DARK_CHANNEL_T", "0.45"))  # mean dark channel (0-1)
LOW_LIGHT_T         = float(os.getenv("LOW_LIGHT_T", "0.28"))          # mean brightness (0-1)

# ── Model 3: monocular ground-plane geometry (for size / distance estimates)
CAM_HEIGHT_M   = float(os.getenv("CAM_HEIGHT_M", "1.3"))
CAM_HFOV_DEG   = float(os.getenv("CAM_HFOV_DEG", "70"))
HORIZON_FRAC   = float(os.getenv("HORIZON_FRAC", "0.45"))   # horizon row / image height
MAX_RANGE_M    = float(os.getenv("MAX_RANGE_M", "60"))
DEPTH_CM_SCALE = float(os.getenv("DEPTH_CM_SCALE", "25"))   # MiDaS contrast → cm calibration
ON_ROAD_RATIO  = float(os.getenv("ON_ROAD_RATIO", "0.3"))

# H5 stalled vehicle
STALL_FRAMES       = int(os.getenv("STALL_FRAMES", "5"))      # processed frames a vehicle must persist
STALL_STATIONARITY = float(os.getenv("STALL_STATIONARITY", "0.6"))

# ── Model 4/5/6: fusion thresholds (weights themselves come from federated learning)
FUSION_HIGH_THRESHOLD   = float(os.getenv("FUSION_HIGH_THRESHOLD",   "0.75"))
FUSION_MEDIUM_THRESHOLD = float(os.getenv("FUSION_MEDIUM_THRESHOLD", "0.40"))
FUSION_FEATURES = [
    "detection_conf", "track_persistence", "seg_area", "depth",
    "on_road", "optical_flow", "imu_bump",
]
FUSION_INITIAL_WEIGHTS = [3.0, 1.2, 1.0, 1.2, 1.5, 0.6, 1.5]
FUSION_INITIAL_BIAS    = -4.0

# ── V2X over Bluetooth ─────────────────────────────────────────────────────
# Cars alert each other directly (no network). A receiving car raises an alert
# when it is within V2X_RADIUS_M (haversine) of the broadcast hazard.
V2X_RADIUS_M  = float(os.getenv("V2X_RADIUS_M", "15"))
# auto  = real Bluetooth RFCOMM to BT_PEERS when available + local BT simulation
# rfcomm = real Bluetooth only, sim = simulation only
BT_MODE       = os.getenv("BT_MODE", "auto")
BT_PEERS      = [p.strip() for p in os.getenv("BT_PEERS", "").split(",") if p.strip()]  # peer MACs
BT_CHANNEL    = int(os.getenv("BT_CHANNEL", "4"))
BT_SIM_GROUP  = os.getenv("BT_SIM_GROUP", "239.255.42.99")
BT_SIM_PORT   = int(os.getenv("BT_SIM_PORT", "50999"))
# Interface the BT simulation uses: 127.0.0.1 = cars on this laptop only;
# "lan" = this laptop's Wi-Fi/LAN address, so cars on other laptops hear it too (fallback
# when real Bluetooth pairing isn't available in a multi-laptop demo)
BT_SIM_IFACE  = os.getenv("BT_SIM_IFACE", "127.0.0.1")

# Known hazards on the planned route: alert once per cluster when this close
ROUTE_ALERT_M = float(os.getenv("ROUTE_ALERT_M", "150"))

# ── Federated learning (client side) ───────────────────────────────────────
FL_LOCAL_EPOCHS   = int(os.getenv("FL_LOCAL_EPOCHS", "60"))
FL_LR             = float(os.getenv("FL_LR", "0.3"))
FL_PROX_MU        = float(os.getenv("FL_PROX_MU", "0.5"))
# Human-in-the-loop: at most one question per frame, and none while this many are unanswered
MAX_PENDING_VERIFY = int(os.getenv("MAX_PENDING_VERIFY", "3"))
FL_AUTO_PUSH_EVERY = int(os.getenv("FL_AUTO_PUSH_EVERY", "2"))   # new labelled samples per push

# ── GenAI verification prompt (falls back to a template without an API key)
GENAI_MODEL     = os.getenv("GENAI_MODEL", "claude-opus-5-5")
GENAI_TIMEOUT_S = float(os.getenv("GENAI_TIMEOUT_S", "15"))

# ── Speech-to-Text (voice verification) ───────────────────────────────────
STT_PROVIDER = os.getenv("STT_PROVIDER", "whisper")

SESSION_TTL_MIN = int(os.getenv("SESSION_TTL_MIN", "60"))
# Load all models at startup (set 0 for a car that only receives Bluetooth alerts in the demo)
WARMUP_MODELS = os.getenv("WARMUP_MODELS", "1") == "1"

CORS_ORIGIN_REGEX = os.getenv("CORS_ORIGIN_REGEX", r"https?://(localhost|127\.0\.0\.1)(:\d+)?")
