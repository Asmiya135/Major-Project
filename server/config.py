"""
Global server configuration — one server shared by every car (client).
Every path, threshold and env-var lives here.
"""
import os
from pathlib import Path

SERVER_DIR = Path(__file__).parent
PROJECT_ROOT = SERVER_DIR.parent
DATA_DIR = Path(os.getenv("SERVER_DATA_DIR", str(SERVER_DIR / "data")))
IMAGES_DIR = DATA_DIR / "images"
MODELS_DIR = DATA_DIR / "models"
DATASET_DIR = DATA_DIR / "yolo_dataset"
for _d in (DATA_DIR, IMAGES_DIR, MODELS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

DB_FILE = str(DATA_DIR / "server.db")
PORT = int(os.getenv("SERVER_PORT", "8000"))

# ── Haversine clustering ───────────────────────────────────────────────────
# Reports of the same hazard type closer than this are one cluster → one alert.
CLUSTER_RADIUS_M = float(os.getenv("CLUSTER_RADIUS_M", "25"))
# DBSCAN (full recluster) parameters
DBSCAN_EPS_M = float(os.getenv("DBSCAN_EPS_M", "25"))
DBSCAN_MIN_PTS = int(os.getenv("DBSCAN_MIN_PTS", "1"))
# Stalled vehicles are transient — hide clusters not re-reported for this long
STALLED_TTL_MIN = int(os.getenv("STALLED_TTL_MIN", "120"))
# Route corridor: hazards within this distance of the route polyline are "on route"
ROUTE_CORRIDOR_M = float(os.getenv("ROUTE_CORRIDOR_M", "40"))

# ── Federated learning (fusion engine weights) ─────────────────────────────
FL_FEATURES = [
    "detection_conf", "track_persistence", "seg_area", "depth",
    "on_road", "optical_flow", "imu_bump",
]
FL_INITIAL_WEIGHTS = [3.0, 1.2, 1.0, 1.2, 1.5, 0.6, 1.5]
FL_INITIAL_BIAS = -4.0
# Aggregate automatically once this many client updates are pending
FL_MIN_UPDATES = int(os.getenv("FL_MIN_UPDATES", "1"))
FUSION_HIGH = float(os.getenv("FUSION_HIGH_THRESHOLD", "0.75"))
FUSION_MEDIUM = float(os.getenv("FUSION_MEDIUM_THRESHOLD", "0.40"))

# ── Detector fine-tune on driver-verified photos (optional, CPU-heavy) ─────
BASE_DETECTOR = PROJECT_ROOT / "Volkswagen-imobilothon-5.0-QUISK" / "Head_1-final" / "model" / "best.pt"
DETECTOR_CLASSES = ["pothole", "speed_bump", "debris"]   # must match Head-1 class order
DETECTOR_EPOCHS = int(os.getenv("DETECTOR_EPOCHS", "3"))
DETECTOR_IMGSZ = int(os.getenv("DETECTOR_IMGSZ", "320"))
DETECTOR_MIN_SAMPLES = int(os.getenv("DETECTOR_MIN_SAMPLES", "2"))

CORS_ORIGIN_REGEX = os.getenv("CORS_ORIGIN_REGEX", r"https?://(localhost|127\.0\.0\.1)(:\d+)?")
