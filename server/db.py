"""SQLite persistence for the global server."""
import json
import sqlite3
import threading
from datetime import datetime, timedelta

import config

_LOCK = threading.RLock()


def _conn():
    c = sqlite3.connect(config.DB_FILE, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def now_iso():
    return datetime.utcnow().isoformat(timespec="seconds")


def init_db():
    with _LOCK, _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS clients (
                client_id   TEXT PRIMARY KEY,
                name        TEXT,
                first_seen  TEXT,
                last_seen   TEXT,
                model_version INTEGER DEFAULT 0,
                reports     INTEGER DEFAULT 0
            );

            -- Every hazard report a car uploads (raw, never merged)
            CREATE TABLE IF NOT EXISTS reports (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                report_uid  TEXT UNIQUE,
                client_id   TEXT,
                cluster_id  INTEGER,
                hazard_type TEXT,
                severity    TEXT,
                latitude    REAL,
                longitude   REAL,
                fusion_score REAL,
                routing     TEXT,
                verified    INTEGER DEFAULT 0,
                was_offline INTEGER DEFAULT 0,
                signals     TEXT,
                metrics     TEXT,
                bbox        TEXT,
                frame_w     INTEGER,
                frame_h     INTEGER,
                image_file  TEXT,
                detected_at TEXT,
                received_at TEXT
            );

            -- Haversine clusters: what drivers are alerted about (once per cluster)
            CREATE TABLE IF NOT EXISTS clusters (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                hazard_type TEXT,
                latitude    REAL,
                longitude   REAL,
                severity    TEXT,
                confidence  REAL,
                count       INTEGER DEFAULT 1,
                radius_m    REAL DEFAULT 0,
                verified    INTEGER DEFAULT 0,
                first_seen  TEXT,
                last_seen   TEXT,
                active      INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS fl_models (
                version     INTEGER PRIMARY KEY,
                weights     TEXT,
                bias        REAL,
                metrics     TEXT,
                n_updates   INTEGER,
                n_samples   INTEGER,
                created_at  TEXT,
                detector_version INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS fl_updates (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id   TEXT,
                base_version INTEGER,
                weights     TEXT,
                bias        REAL,
                n_samples   INTEGER,
                local_metrics TEXT,
                received_at TEXT,
                aggregated_into INTEGER
            );

            CREATE TABLE IF NOT EXISTS detector_jobs (
                version     INTEGER PRIMARY KEY,
                status      TEXT,
                n_images    INTEGER,
                metrics     TEXT,
                weights_file TEXT,
                started_at  TEXT,
                finished_at TEXT,
                error       TEXT
            );
        """)
        if c.execute("SELECT COUNT(*) FROM fl_models").fetchone()[0] == 0:
            c.execute(
                "INSERT INTO fl_models (version, weights, bias, metrics, n_updates, n_samples, created_at) "
                "VALUES (1, ?, ?, ?, 0, 0, ?)",
                (json.dumps(config.FL_INITIAL_WEIGHTS), config.FL_INITIAL_BIAS,
                 json.dumps({"note": "initial hand-tuned fusion weights"}), now_iso()),
            )
        c.commit()


def _row(r):
    if r is None:
        return None
    d = dict(r)
    for k in ("signals", "metrics", "bbox", "weights", "local_metrics"):
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except ValueError:
                pass
    return d


# ── Clients ────────────────────────────────────────────────────────────────

def touch_client(client_id, name=None, model_version=None):
    t = now_iso()
    with _LOCK, _conn() as c:
        c.execute(
            "INSERT INTO clients (client_id, name, first_seen, last_seen) VALUES (?,?,?,?) "
            "ON CONFLICT(client_id) DO UPDATE SET last_seen=excluded.last_seen",
            (client_id, name or client_id, t, t),
        )
        if name:
            c.execute("UPDATE clients SET name=? WHERE client_id=?", (name, client_id))
        if model_version is not None:
            c.execute("UPDATE clients SET model_version=? WHERE client_id=?", (model_version, client_id))
        c.commit()


def list_clients():
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM clients ORDER BY last_seen DESC")]


# ── Reports ────────────────────────────────────────────────────────────────

def get_report_by_uid(uid):
    with _LOCK, _conn() as c:
        return _row(c.execute("SELECT * FROM reports WHERE report_uid=?", (uid,)).fetchone())


def insert_report(r: dict) -> int:
    with _LOCK, _conn() as c:
        cur = c.execute(
            """INSERT INTO reports (report_uid, client_id, cluster_id, hazard_type, severity,
                latitude, longitude, fusion_score, routing, verified, was_offline, signals,
                metrics, bbox, frame_w, frame_h, image_file, detected_at, received_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r["report_uid"], r["client_id"], r.get("cluster_id"), r["hazard_type"],
             r.get("severity", "medium"), r["latitude"], r["longitude"],
             r.get("fusion_score", 0.0), r.get("routing", "HIGH"), int(bool(r.get("verified"))),
             int(bool(r.get("was_offline"))), json.dumps(r.get("signals", {})),
             json.dumps(r.get("metrics", {})), json.dumps(r.get("bbox", [])),
             r.get("frame_w", 0), r.get("frame_h", 0), r.get("image_file"),
             r.get("detected_at") or now_iso(), now_iso()),
        )
        c.execute("UPDATE clients SET reports=reports+1 WHERE client_id=?", (r["client_id"],))
        c.commit()
        return cur.lastrowid


def set_report_cluster(report_id, cluster_id):
    with _LOCK, _conn() as c:
        c.execute("UPDATE reports SET cluster_id=? WHERE id=?", (cluster_id, report_id))
        c.commit()


def list_reports(limit=50, verified_only=False):
    q = "SELECT * FROM reports"
    if verified_only:
        q += " WHERE verified=1"
    q += " ORDER BY id DESC LIMIT ?"
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute(q, (limit,))]


def all_reports():
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM reports ORDER BY id")]


# ── Clusters ───────────────────────────────────────────────────────────────

def list_clusters(active_only=True, hazard_type=None):
    q = "SELECT * FROM clusters WHERE 1=1"
    p = []
    if active_only:
        q += " AND active=1"
    if hazard_type:
        q += " AND hazard_type=?"
        p.append(hazard_type)
    with _LOCK, _conn() as c:
        rows = [_row(r) for r in c.execute(q, p)]
    if active_only:
        cutoff = (datetime.utcnow() - timedelta(minutes=config.STALLED_TTL_MIN)).isoformat()
        rows = [r for r in rows if r["hazard_type"] != "stalled_vehicle" or r["last_seen"] >= cutoff]
    return rows


def get_cluster(cid):
    with _LOCK, _conn() as c:
        return _row(c.execute("SELECT * FROM clusters WHERE id=?", (cid,)).fetchone())


def insert_cluster(d: dict) -> int:
    t = now_iso()
    with _LOCK, _conn() as c:
        cur = c.execute(
            "INSERT INTO clusters (hazard_type, latitude, longitude, severity, confidence, count, radius_m, verified, first_seen, last_seen) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (d["hazard_type"], d["latitude"], d["longitude"], d["severity"], d["confidence"],
             d.get("count", 1), d.get("radius_m", 0.0), int(bool(d.get("verified"))),
             d.get("first_seen", t), d.get("last_seen", t)),
        )
        c.commit()
        return cur.lastrowid


def update_cluster(cid, **fields):
    if not fields:
        return
    keys = ", ".join(f"{k}=?" for k in fields)
    with _LOCK, _conn() as c:
        c.execute(f"UPDATE clusters SET {keys} WHERE id=?", (*fields.values(), cid))
        c.commit()


def replace_all_clusters(clusters: list, assignments: dict):
    """Used by full DBSCAN recluster: rewrite clusters + report→cluster mapping atomically."""
    with _LOCK, _conn() as c:
        c.execute("DELETE FROM clusters")
        new_ids = {}
        for key, d in clusters:
            cur = c.execute(
                "INSERT INTO clusters (hazard_type, latitude, longitude, severity, confidence, count, radius_m, verified, first_seen, last_seen) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (d["hazard_type"], d["latitude"], d["longitude"], d["severity"], d["confidence"],
                 d["count"], d["radius_m"], int(d["verified"]), d["first_seen"], d["last_seen"]),
            )
            new_ids[key] = cur.lastrowid
        for report_id, key in assignments.items():
            c.execute("UPDATE reports SET cluster_id=? WHERE id=?", (new_ids.get(key), report_id))
        c.commit()
        return new_ids


# ── Federated learning ─────────────────────────────────────────────────────

def latest_model():
    with _LOCK, _conn() as c:
        return _row(c.execute("SELECT * FROM fl_models ORDER BY version DESC LIMIT 1").fetchone())


def list_models():
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM fl_models ORDER BY version DESC")]


def insert_model(version, weights, bias, metrics, n_updates, n_samples, detector_version):
    with _LOCK, _conn() as c:
        c.execute(
            "INSERT INTO fl_models (version, weights, bias, metrics, n_updates, n_samples, created_at, detector_version) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (version, json.dumps(weights), bias, json.dumps(metrics), n_updates, n_samples, now_iso(), detector_version),
        )
        c.commit()


def set_model_detector_version(version, detector_version):
    with _LOCK, _conn() as c:
        c.execute("UPDATE fl_models SET detector_version=? WHERE version=?", (detector_version, version))
        c.commit()


def insert_update(u: dict) -> int:
    with _LOCK, _conn() as c:
        cur = c.execute(
            "INSERT INTO fl_updates (client_id, base_version, weights, bias, n_samples, local_metrics, received_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (u["client_id"], u["base_version"], json.dumps(u["weights"]), u["bias"],
             u["n_samples"], json.dumps(u.get("local_metrics", {})), now_iso()),
        )
        c.commit()
        return cur.lastrowid


def pending_updates():
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM fl_updates WHERE aggregated_into IS NULL ORDER BY id")]


def list_updates(limit=50):
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM fl_updates ORDER BY id DESC LIMIT ?", (limit,))]


def mark_updates_aggregated(ids, version):
    with _LOCK, _conn() as c:
        c.executemany("UPDATE fl_updates SET aggregated_into=? WHERE id=?", [(version, i) for i in ids])
        c.commit()


# ── Detector fine-tune jobs ────────────────────────────────────────────────

def upsert_detector_job(version, **fields):
    with _LOCK, _conn() as c:
        if c.execute("SELECT 1 FROM detector_jobs WHERE version=?", (version,)).fetchone() is None:
            c.execute("INSERT INTO detector_jobs (version) VALUES (?)", (version,))
        if fields:
            keys = ", ".join(f"{k}=?" for k in fields)
            vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in fields.values()]
            c.execute(f"UPDATE detector_jobs SET {keys} WHERE version=?", (*vals, version))
        c.commit()


def list_detector_jobs():
    with _LOCK, _conn() as c:
        return [_row(r) for r in c.execute("SELECT * FROM detector_jobs ORDER BY version DESC")]


def latest_ready_detector():
    with _LOCK, _conn() as c:
        return _row(c.execute(
            "SELECT * FROM detector_jobs WHERE status='ready' ORDER BY version DESC LIMIT 1").fetchone())
