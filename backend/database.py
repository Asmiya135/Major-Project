"""Local trip log for this car: trips and the hazards detected during each one."""
import sqlite3
import threading
from datetime import datetime

import config

DB_FILE = config.DB_FILE
_LOCK = threading.Lock()


def _conn():
    return sqlite3.connect(DB_FILE, check_same_thread=False)


def init_db():
    with _LOCK, _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS trips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                start_time TEXT,
                end_time TEXT,
                distance_km REAL DEFAULT 0,
                avg_speed_km REAL DEFAULT 0,
                hazards_avoided INTEGER DEFAULT 0,
                hazards_reported INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active'
            );

            CREATE TABLE IF NOT EXISTS detections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                hazard_id INTEGER,
                latitude REAL,
                longitude REAL,
                hazard_type TEXT,
                severity TEXT,
                confidence REAL,
                distance_m REAL,
                lane TEXT,
                source TEXT DEFAULT 'vehicle',
                timestamp TEXT,
                needs_feedback INTEGER DEFAULT 0
            );
        """)
        c.commit()


# ─── Trips ─────────────────────────────────────────────────────────────────

def create_trip(session_id):
    now = datetime.utcnow().isoformat()
    with _LOCK, _conn() as c:
        try:
            cur = c.execute(
                "INSERT INTO trips (session_id, start_time, status) VALUES (?,?,'active')",
                (session_id, now)
            )
            c.commit()
            return cur.lastrowid
        except sqlite3.IntegrityError:
            row = c.execute("SELECT id FROM trips WHERE session_id=?", (session_id,)).fetchone()
            return row[0] if row else None


def end_trip(session_id, distance_km=0, avg_speed=0, hazards_avoided=0, hazards_reported=0):
    now = datetime.utcnow().isoformat()
    with _LOCK, _conn() as c:
        c.execute(
            "UPDATE trips SET end_time=?, status='completed', distance_km=?, avg_speed_km=?, hazards_avoided=?, hazards_reported=? WHERE session_id=?",
            (now, distance_km, avg_speed, hazards_avoided, hazards_reported, session_id)
        )
        c.commit()


def get_trip(session_id):
    with _LOCK, _conn() as c:
        row = c.execute(
            "SELECT id, session_id, start_time, end_time, distance_km, avg_speed_km, hazards_avoided, hazards_reported, status FROM trips WHERE session_id=?",
            (session_id,)
        ).fetchone()
    if not row:
        return None
    keys = ["id", "session_id", "start_time", "end_time", "distance_km", "avg_speed_km",
            "hazards_avoided", "hazards_reported", "status"]
    return dict(zip(keys, row))


# ─── Detections (per-drive hazard events) ──────────────────────────────────

def record_detection(session_id, hazard_id, lat, lon, hazard_type, severity,
                     confidence, distance_m, lane, source="vehicle", needs_feedback=False):
    now = datetime.utcnow().isoformat()
    with _LOCK, _conn() as c:
        cur = c.execute(
            """INSERT INTO detections
               (session_id, hazard_id, latitude, longitude, hazard_type, severity,
                confidence, distance_m, lane, source, timestamp, needs_feedback)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (session_id, hazard_id, lat, lon, hazard_type, severity,
             confidence, distance_m, lane, source, now, int(needs_feedback))
        )
        c.commit()
        return cur.lastrowid


def get_trip_detections(session_id):
    with _LOCK, _conn() as c:
        rows = c.execute(
            "SELECT id, hazard_id, latitude, longitude, hazard_type, severity, confidence, distance_m, lane, source, timestamp, needs_feedback FROM detections WHERE session_id=? ORDER BY timestamp DESC",
            (session_id,)
        ).fetchall()
    keys = ["id", "hazard_id", "latitude", "longitude", "hazard_type", "severity",
            "confidence", "distance_m", "lane", "source", "timestamp", "needs_feedback"]
    return [dict(zip(keys, r)) for r in rows]
