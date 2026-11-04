"""
Live state of this car: telemetry (GPS / speed / heading / IMU), network status and the
capture-rate policy (Model 1). Shared by the pipeline, V2X, sync and the UI websockets.
"""
import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field

import config

EARTH_R = 6371000.0


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return EARTH_R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def project(lat, lon, heading_deg, dist_m):
    """Point dist_m ahead of (lat, lon) along heading (0 = north, 90 = east)."""
    h = math.radians(heading_deg)
    dlat = dist_m * math.cos(h) / EARTH_R
    dlon = dist_m * math.sin(h) / (EARTH_R * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lon + math.degrees(dlon)


def capture_policy(speed_kmh: float) -> dict:
    """Model 1: frames per second so each frame covers ~CAPTURE_COVERAGE_M of new road."""
    mps = max(0.0, speed_kmh) / 3.6
    raw = mps / config.CAPTURE_COVERAGE_M
    clamped = min(config.CAPTURE_MAX_FPS, max(config.CAPTURE_MIN_FPS, raw))
    fps = round(clamped, 2)
    return {
        "speed_kmh": round(speed_kmh, 1),
        "target_fps": fps,
        "interval_ms": int(1000 / fps),
        "coverage_m": config.CAPTURE_COVERAGE_M,
        "reason": (f"{mps:.1f} m/s ÷ {config.CAPTURE_COVERAGE_M:g} m per frame = {raw:.2f} fps"
                   + (f" → clamped to {fps}" if clamped != raw else "")),
    }


@dataclass
class Telemetry:
    lat: float = 19.0820
    lon: float = 72.8950
    speed_kmh: float = 0.0
    heading_deg: float = 0.0
    imu_peak: float = 0.0          # peak |vertical accel − g| in m/s² over the last second
    imu_ts: float = 0.0
    source: str = "simulated"


@dataclass
class EdgeState:
    telemetry: Telemetry = field(default_factory=Telemetry)
    forced_offline: bool = False   # demo switch: pretend the network is gone
    server_reachable: bool = False
    last_sync_ok: float = 0.0
    last_sync_error: str = ""
    bt_status: dict = field(default_factory=dict)
    log: deque = field(default_factory=lambda: deque(maxlen=200))
    lock: threading.Lock = field(default_factory=threading.Lock)

    def is_online(self) -> bool:
        return (not self.forced_offline) and self.server_reachable

    def imu_now(self) -> float:
        t = self.telemetry
        return t.imu_peak if time.time() - t.imu_ts < 2.5 else 0.0

    def update_telemetry(self, **kw):
        with self.lock:
            t = self.telemetry
            for k in ("lat", "lon", "speed_kmh", "heading_deg", "source"):
                if kw.get(k) is not None:
                    setattr(t, k, float(kw[k]) if k != "source" else kw[k])
            if kw.get("imu_peak") is not None and float(kw["imu_peak"]) > 0:
                t.imu_peak = float(kw["imu_peak"])
                t.imu_ts = time.time()

    def add_log(self, kind: str, msg: str):
        self.log.appendleft({"t": time.strftime("%H:%M:%S"), "kind": kind, "msg": msg})

    def snapshot(self) -> dict:
        t = self.telemetry
        return {
            "client_id": config.CLIENT_ID,
            "client_name": config.CLIENT_NAME,
            "server_url": config.SERVER_URL,
            "online": self.is_online(),
            "forced_offline": self.forced_offline,
            "server_reachable": self.server_reachable,
            "last_sync_error": self.last_sync_error,
            "telemetry": {"lat": t.lat, "lon": t.lon, "speed_kmh": t.speed_kmh,
                          "heading_deg": t.heading_deg, "imu_peak": round(self.imu_now(), 2),
                          "source": t.source},
            "capture_policy": capture_policy(t.speed_kmh),
            "bt": self.bt_status,
            "v2x_radius_m": config.V2X_RADIUS_M,
        }


state = EdgeState()
