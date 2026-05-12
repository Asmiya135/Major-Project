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
        cur = c.cursor()
        cur.executescript("""
            CREATE TABLE IF NOT EXISTS hazards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                hazard_type TEXT NOT NULL,
                confidence REAL NOT NULL,
                severity TEXT DEFAULT 'medium',
                count INTEGER DEFAULT 1,
                first_seen TEXT,
                last_seen TEXT,
                verified INTEGER DEFAULT 0
            );

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

            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hazard_id INTEGER,
                session_id TEXT,
                response TEXT NOT NULL,
                timestamp TEXT,
                FOREIGN KEY(hazard_id) REFERENCES hazards(id)
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


# ─── Hazards ───────────────────────────────────────────────────────────────

def list_hazards(hazard_type=None, severity=None, since_hours=None):
    query = "SELECT id, latitude, longitude, hazard_type, confidence, severity, count, first_seen, last_seen, verified FROM hazards WHERE 1=1"
    params = []
    if hazard_type:
        query += " AND hazard_type = ?"
        params.append(hazard_type)
    if severity:
        query += " AND severity = ?"
        params.append(severity)
    if since_hours:
        cutoff = datetime.utcnow().isoformat()
        query += " AND last_seen >= datetime(?, '-{} hours')".format(int(since_hours))
        params.append(cutoff)
    with _LOCK, _conn() as c:
        rows = c.execute(query, params).fetchall()
    keys = ["id", "latitude", "longitude", "hazard_type", "confidence", "severity",
            "count", "first_seen", "last_seen", "verified"]
    return [dict(zip(keys, r)) for r in rows]


def insert_hazard(lat, lon, hazard_type, confidence, severity="medium"):
    now = datetime.utcnow().isoformat()
    with _LOCK, _conn() as c:
        cur = c.execute(
            "INSERT INTO hazards (latitude, longitude, hazard_type, confidence, severity, count, first_seen, last_seen) VALUES (?,?,?,?,?,1,?,?)",
            (lat, lon, hazard_type, confidence, severity, now, now)
        )
        c.commit()
        return cur.lastrowid


def update_hazard(hazard_id, new_lat, new_lon, new_confidence):
    now = datetime.utcnow().isoformat()
    with _LOCK, _conn() as c:
        row = c.execute("SELECT confidence, count FROM hazards WHERE id=?", (hazard_id,)).fetchone()
        if row:
            old_conf, old_count = row
            merged = (old_conf * old_count + new_confidence) / (old_count + 1)
            c.execute(
                "UPDATE hazards SET latitude=?, longitude=?, confidence=?, count=count+1, last_seen=? WHERE id=?",
                (new_lat, new_lon, round(merged, 4), now, hazard_id)
            )
            c.commit()


def find_nearby_hazard(lat, lon, threshold_m=50, hazard_type=None):
    from math import radians, sin, cos, sqrt, atan2
    hazards = list_hazards(hazard_type=hazard_type)
    for h in hazards:
        dlat = radians(h["latitude"] - lat)
        dlon = radians(h["longitude"] - lon)
        a = sin(dlat/2)**2 + cos(radians(lat)) * cos(radians(h["latitude"])) * sin(dlon/2)**2
        d = 6371000 * 2 * atan2(sqrt(a), sqrt(1 - a))
        if d <= threshold_m:
            return h["id"]
    return None


def get_hazard(hazard_id):
    with _LOCK, _conn() as c:
        row = c.execute(
            "SELECT id, latitude, longitude, hazard_type, confidence, severity, count, first_seen, last_seen, verified FROM hazards WHERE id=?",
            (hazard_id,)
        ).fetchone()
    if not row:
        return None
    keys = ["id", "latitude", "longitude", "hazard_type", "confidence", "severity",
            "count", "first_seen", "last_seen", "verified"]
    return dict(zip(keys, row))


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


def get_pending_feedback(session_id):
    with _LOCK, _conn() as c:
        rows = c.execute(
            "SELECT d.id, d.hazard_id, d.hazard_type, d.timestamp FROM detections d WHERE d.session_id=? AND d.needs_feedback=1 AND d.id NOT IN (SELECT hazard_id FROM feedback WHERE session_id=?) ORDER BY d.timestamp DESC LIMIT 5",
            (session_id, session_id)
        ).fetchall()
    return [{"detection_id": r[0], "hazard_id": r[1], "hazard_type": r[2], "timestamp": r[3]} for r in rows]


# ─── Feedback ──────────────────────────────────────────────────────────────

def save_feedback(hazard_id, session_id, response):
    now = datetime.utcnow().isoformat()
    with _LOCK, _conn() as c:
        c.execute(
            "INSERT INTO feedback (hazard_id, session_id, response, timestamp) VALUES (?,?,?,?)",
            (hazard_id, session_id, response, now)
        )
        if response == "yes":
            c.execute("UPDATE hazards SET verified=1, count=count+1 WHERE id=?", (hazard_id,))
        elif response == "no":
            c.execute("UPDATE hazards SET confidence=confidence*0.5 WHERE id=?", (hazard_id,))
        c.commit()
