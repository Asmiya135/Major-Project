"""
Per-session pipeline memory for one camera stream: the AKS reference frame, frame
counters, the SORT vehicle tracker (stalled-vehicle head) and the hazard tracker that
gives the fusion engine its "tracking persistence" signal and stops the same pothole
being reported on every frame.
"""
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import config


def iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


@dataclass
class HazardTrack:
    id: int
    hazard_type: str
    bbox: list
    hits: int = 1
    last_frame: int = 0
    reported: bool = False
    verify_requested: bool = False


@dataclass
class SessionPipelineState:
    session_id: str

    # ── Model 1: capture / AKS ──────────────────────────────────────────
    prev_small: Optional[Any] = None       # grayscale 320-px copy of last processed frame
    consecutive_skips: int = 0
    frames_captured: int = 0
    frames_processed: int = 0
    frames_skipped_dup: int = 0
    frames_dropped_busy: int = 0
    capture_times: deque = field(default_factory=lambda: deque(maxlen=20))

    # ── H5 SORT vehicle tracker ─────────────────────────────────────────
    sort_tracker: Optional[Any] = None
    vehicle_hist: Dict[int, dict] = field(default_factory=dict)

    # ── Hazard tracks (persistence + report-once) ───────────────────────
    hazard_tracks: list = field(default_factory=list)
    next_track_id: int = 1

    created_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)

    def touch(self):
        self.last_used = time.time()

    def is_expired(self) -> bool:
        return (time.time() - self.last_used) > config.SESSION_TTL_MIN * 60

    def get_tracker(self):
        if self.sort_tracker is None:
            import sys
            if str(config.STALLED_DIR) not in sys.path:
                sys.path.insert(0, str(config.STALLED_DIR))
            from sort import Sort
            # processed frames arrive ~1/s, so tracks must survive with few hits
            self.sort_tracker = Sort(max_age=4, min_hits=1, iou_threshold=0.2)
        return self.sort_tracker

    def note_capture(self):
        self.frames_captured += 1
        self.capture_times.append(time.time())

    def measured_fps(self) -> float:
        t = list(self.capture_times)
        if len(t) < 2 or t[-1] == t[0]:
            return 0.0
        return round((len(t) - 1) / (t[-1] - t[0]), 2)

    def match_hazard(self, hazard_type: str, bbox: list) -> HazardTrack:
        frame = self.frames_processed
        best, best_iou = None, 0.0
        for tr in self.hazard_tracks:
            if tr.hazard_type != hazard_type or frame - tr.last_frame > 10:
                continue
            v = iou(tr.bbox, bbox)
            if v > best_iou:
                best, best_iou = tr, v
        if best is not None and best_iou >= 0.2:
            if best.last_frame != frame:
                best.hits += 1
            best.bbox, best.last_frame = bbox, frame
            return best
        tr = HazardTrack(id=self.next_track_id, hazard_type=hazard_type, bbox=bbox, last_frame=frame)
        self.next_track_id += 1
        self.hazard_tracks.append(tr)
        self.hazard_tracks = [t for t in self.hazard_tracks if frame - t.last_frame <= 30]
        return tr

    def stats(self) -> dict:
        cap = max(1, self.frames_captured)
        return {
            "frames_captured": self.frames_captured,
            "frames_processed": self.frames_processed,
            "frames_skipped_duplicate": self.frames_skipped_dup,
            "frames_dropped_busy": self.frames_dropped_busy,
            "compute_saving_pct": round((1 - self.frames_processed / cap) * 100, 1),
            "measured_capture_fps": self.measured_fps(),
        }


_store: Dict[str, SessionPipelineState] = {}
_lock = threading.Lock()


def get(session_id: str) -> SessionPipelineState:
    with _lock:
        if session_id not in _store:
            _store[session_id] = SessionPipelineState(session_id=session_id)
        s = _store[session_id]
        s.touch()
        return s


def remove(session_id: str) -> None:
    with _lock:
        _store.pop(session_id, None)


def cleanup_expired() -> int:
    with _lock:
        stale = [sid for sid, s in _store.items() if s.is_expired()]
        for sid in stale:
            del _store[sid]
        return len(stale)


def active_sessions() -> list:
    with _lock:
        return list(_store.keys())
