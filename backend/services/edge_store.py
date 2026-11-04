"""
On-device SQLite store for one car:
  outbox        — hazard reports waiting for (or already sent to) the server — the offline queue
  route_cache   — known hazards downloaded for the planned route (works offline)
  peer_hazards  — hazards received from nearby cars over Bluetooth V2X
  verify        — MEDIUM-confidence detections awaiting the driver's yes/no
  fl_samples    — driver-labelled fusion-signal vectors for local federated training
"""
import json
import sqlite3
import threading
from datetime import datetime

import config

_LOCK = threading.RLock()


def _conn():
    c = sqlite3.connect(config.EDGE_DB, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def now_iso():
    return datetime.utcnow().isoformat(timespec="seconds")


def _row(r):
    if r is None:
        return None
    d = dict(r)
    for k in ("payload", "data", "features", "server_response"):
        if isinstance(d.get(k), str):
            try:
                d[k] = json.loads(d[k])
            except ValueError:
                pass
    return d


def init():
    with _LOCK, _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_uid TEXT UNIQUE,
                payload TEXT,
                image_path TEXT,
                status TEXT DEFAULT 'queued',
                queued_offline INTEGER DEFAULT 0,
                attempts INTEGER DEFAULT 0,
                last_error TEXT,
                server_response TEXT,
                created_at TEXT,
                sent_at TEXT
            );
            CREATE TABLE IF NOT EXISTS route_cache (
                cluster_id INTEGER PRIMARY KEY,
                data TEXT,
                distance_along_m REAL,
                fetched_at TEXT
            );
            CREATE TABLE IF NOT EXISTS peer_hazards (
                msg_id TEXT PRIMARY KEY,
                from_client TEXT,
                transport TEXT,
                data TEXT,
                received_at TEXT,
                alerted INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS verify (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                payload TEXT,
                image_path TEXT,
                question TEXT,
                question_source TEXT,
                status TEXT DEFAULT 'pending',
                transcript TEXT,
                created_at TEXT,
                answered_at TEXT
            );
            CREATE TABLE IF NOT EXISTS fl_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                features TEXT,
                label INTEGER,
                source TEXT,
                pushed INTEGER DEFAULT 0,
                created_at TEXT
            );
        """)
        c.commit()


# ── Outbox (offline queue) ─────────────────────────────────────────────────

def enqueue(payload: dict, image_path: str | None, offline: bool) -> int:
    with _LOCK, _conn() as c:
        cur = c.execute(
            "INSERT OR IGNORE INTO outbox (report_uid, payload, image_path, queued_offline, created_at) VALUES (?,?,?,?,?)",
            (payload["report_uid"], json.dumps(payload), image_path, int(offline), now_iso()),
        )
        c.commit()
        return cur.lastrowid


def pending_outbox():
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM outbox WHERE status='queued' ORDER BY id")]


def get_outbox(oid):
    with _LOCK, _conn() as c:
        return _row(c.execute("SELECT * FROM outbox WHERE id=?", (oid,)).fetchone())


def mark_sent(oid, response: dict):
    with _LOCK, _conn() as c:
        c.execute("UPDATE outbox SET status='sent', sent_at=?, server_response=?, attempts=attempts+1 WHERE id=?",
                  (now_iso(), json.dumps(response), oid))
        c.commit()


def mark_failed_attempt(oid, err: str):
    with _LOCK, _conn() as c:
        c.execute("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?", (err[:300], oid))
        c.commit()


def list_outbox(limit=30):
    with _LOCK, _conn() as c:
        rows = [_row(r) for r in c.execute("SELECT * FROM outbox ORDER BY id DESC LIMIT ?", (limit,))]
    for r in rows:
        p = r.get("payload") or {}
        r["summary"] = {k: p.get(k) for k in ("hazard_type", "severity", "fusion_score", "routing",
                                                "verified", "latitude", "longitude", "detected_at")}
        r.pop("payload", None)
    return rows


def outbox_counts():
    with _LOCK, _conn() as c:
        q = c.execute("SELECT COUNT(*) FROM outbox WHERE status='queued'").fetchone()[0]
        s = c.execute("SELECT COUNT(*) FROM outbox WHERE status='sent'").fetchone()[0]
        so = c.execute("SELECT COUNT(*) FROM outbox WHERE status='sent' AND queued_offline=1").fetchone()[0]
    return {"queued": q, "sent": s, "sent_after_offline": so}


# ── Route cache ────────────────────────────────────────────────────────────

def replace_route_cache(hazards: list):
    with _LOCK, _conn() as c:
        c.execute("DELETE FROM route_cache")
        c.executemany(
            "INSERT INTO route_cache (cluster_id, data, distance_along_m, fetched_at) VALUES (?,?,?,?)",
            [(h["id"], json.dumps(h), h.get("distance_along_m"), now_iso()) for h in hazards],
        )
        c.commit()


def upsert_route_hazard(h: dict):
    with _LOCK, _conn() as c:
        c.execute("INSERT OR REPLACE INTO route_cache (cluster_id, data, distance_along_m, fetched_at) VALUES (?,?,?,?)",
                  (h["id"], json.dumps(h), h.get("distance_along_m"), now_iso()))
        c.commit()


def route_cache():
    with _LOCK, _conn() as c:
        return [_row(r)["data"] for r in c.execute("SELECT * FROM route_cache ORDER BY distance_along_m")]


# ── V2X peer hazards ───────────────────────────────────────────────────────

def add_peer_hazard(msg: dict, transport: str) -> bool:
    """Returns False if this broadcast was already received (dedup across transports)."""
    with _LOCK, _conn() as c:
        cur = c.execute(
            "INSERT OR IGNORE INTO peer_hazards (msg_id, from_client, transport, data, received_at) VALUES (?,?,?,?,?)",
            (msg["msg_id"], msg.get("from_client"), transport, json.dumps(msg), now_iso()),
        )
        c.commit()
        return cur.rowcount > 0


def peer_hazards(only_unalerted=False):
    q = "SELECT * FROM peer_hazards"
    if only_unalerted:
        q += " WHERE alerted=0"
    q += " ORDER BY received_at DESC LIMIT 100"
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute(q)]


def mark_peer_alerted(msg_id):
    with _LOCK, _conn() as c:
        c.execute("UPDATE peer_hazards SET alerted=1 WHERE msg_id=?", (msg_id,))
        c.commit()


# ── Human-in-the-loop verification ─────────────────────────────────────────

def add_verify(payload: dict, image_path: str, question: str, source: str) -> int:
    with _LOCK, _conn() as c:
        cur = c.execute(
            "INSERT INTO verify (payload, image_path, question, question_source, created_at) VALUES (?,?,?,?,?)",
            (json.dumps(payload), image_path, question, source, now_iso()),
        )
        c.commit()
        return cur.lastrowid


def set_verify_question(vid, question, source):
    with _LOCK, _conn() as c:
        c.execute("UPDATE verify SET question=?, question_source=? WHERE id=?", (question, source, vid))
        c.commit()


def get_verify(vid):
    with _LOCK, _conn() as c:
        return _row(c.execute("SELECT * FROM verify WHERE id=?", (vid,)).fetchone())


def answer_verify(vid, status, transcript=""):
    with _LOCK, _conn() as c:
        c.execute("UPDATE verify SET status=?, transcript=?, answered_at=? WHERE id=?",
                  (status, transcript, now_iso(), vid))
        c.commit()


def list_verify(status=None, limit=20):
    q = "SELECT * FROM verify"
    p = []
    if status:
        q += " WHERE status=?"
        p.append(status)
    q += " ORDER BY id DESC LIMIT ?"
    p.append(limit)
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute(q, p)]


# ── Federated-learning samples ─────────────────────────────────────────────

def add_fl_sample(features: dict, label: int, source: str):
    with _LOCK, _conn() as c:
        c.execute("INSERT INTO fl_samples (features, label, source, created_at) VALUES (?,?,?,?)",
                  (json.dumps(features), int(label), source, now_iso()))
        c.commit()


def fl_samples():
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM fl_samples ORDER BY id")]


def fl_unpushed_count():
    with _LOCK, _conn() as c:
        return c.execute("SELECT COUNT(*) FROM fl_samples WHERE pushed=0").fetchone()[0]


def mark_fl_pushed():
    with _LOCK, _conn() as c:
        c.execute("UPDATE fl_samples SET pushed=1 WHERE pushed=0")
        c.commit()
