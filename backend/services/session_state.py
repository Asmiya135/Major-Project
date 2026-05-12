"""
Per-session state that lives in memory for the duration of a drive.
Each session gets its own AKS frame memory and SORT tracker instance
so that consecutive frames are processed correctly without mixing state.
"""
import time
import threading
from dataclasses import dataclass, field
from typing import Dict, Optional, Any

import config


@dataclass
class SessionPipelineState:
    session_id: str

    # ── AKS state ────────────────────────────────────────────────────────
    prev_gray: Optional[Any] = None           # grayscale of last received frame (np.ndarray)
    aks_skip_remaining: int = 0              # frames still to skip
    total_frames_received: int = 0
    total_frames_processed: int = 0

    # ── SORT tracker (Head 5) ────────────────────────────────────────────
    sort_tracker: Optional[Any] = None       # lazy-loaded Sort instance
    stalled_counters: Dict[int, int] = field(default_factory=dict)
    prev_centroids: Dict[int, tuple] = field(default_factory=dict)

    # ── Timing ───────────────────────────────────────────────────────────
    created_at: float = field(default_factory=time.time)
    last_used:  float = field(default_factory=time.time)

    def touch(self):
        self.last_used = time.time()

    def is_expired(self) -> bool:
        ttl_seconds = config.SESSION_TTL_MIN * 60
        return (time.time() - self.last_used) > ttl_seconds

    def get_tracker(self):
        """Lazy-init the SORT tracker."""
        if self.sort_tracker is None:
            try:
                import sys
                if str(config.STALLED_DIR) not in sys.path:
                    sys.path.insert(0, str(config.STALLED_DIR))
                from sort import Sort
                self.sort_tracker = Sort(max_age=30, min_hits=5, iou_threshold=0.3)
            except Exception as e:
                print(f"[Session {self.session_id}] SORT unavailable: {e}")
        return self.sort_tracker

    def aks_check(self, frame_bgr, speed_kmh: float = 0.0) -> tuple:
        """
        Adaptive Keyframe Sampling.
        Returns (should_process: bool, motion_score: float).
        motion_score is the mean pixel diff vs previous frame (0 = no motion).
        """
        import cv2
        import numpy as np
        self.total_frames_received += 1

        if self.prev_gray is None:
            self.prev_gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
            self.total_frames_processed += 1
            return True, 0.0

        if self.aks_skip_remaining > 0:
            self.aks_skip_remaining -= 1
            self.prev_gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
            return False, 0.0

        curr_gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(self.prev_gray, curr_gray)
        motion_score = float(np.mean(diff))
        self.prev_gray = curr_gray

        if motion_score >= config.AKS_MOTION_THRESHOLD:
            self.total_frames_processed += 1
            return True, motion_score

        if speed_kmh < config.AKS_SPEED_SLOW_KMH:
            self.aks_skip_remaining = config.AKS_SLOW_SKIP
        elif speed_kmh < config.AKS_SPEED_MEDIUM_KMH:
            self.aks_skip_remaining = config.AKS_MEDIUM_SKIP

        self.total_frames_processed += 1
        return True, motion_score

    def aks_should_process(self, frame_bgr, speed_kmh: float = 0.0) -> bool:
        """Compatibility wrapper — returns only the bool decision."""
        ok, _ = self.aks_check(frame_bgr, speed_kmh)
        return ok

    def aks_stats(self) -> dict:
        received  = max(1, self.total_frames_received)
        processed = self.total_frames_processed
        saved_pct = round((1 - processed / received) * 100, 1)
        return {
            "frames_received":  received,
            "frames_processed": processed,
            "frames_skipped":   received - processed,
            "compute_saving_pct": saved_pct,
        }


# ── Global registry ────────────────────────────────────────────────────────

_store: Dict[str, SessionPipelineState] = {}
_lock = threading.Lock()


def get(session_id: str) -> SessionPipelineState:
    with _lock:
        if session_id not in _store:
            _store[session_id] = SessionPipelineState(session_id=session_id)
        state = _store[session_id]
        state.touch()
        return state


def remove(session_id: str) -> None:
    with _lock:
        _store.pop(session_id, None)


def cleanup_expired() -> int:
    """Remove sessions that haven't been used within the TTL. Returns count removed."""
    with _lock:
        stale = [sid for sid, s in _store.items() if s.is_expired()]
        for sid in stale:
            del _store[sid]
        return len(stale)


def active_sessions() -> list:
    with _lock:
        return list(_store.keys())
