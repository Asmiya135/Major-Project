"""
Volkswagen Hazard Detection — GLOBAL SERVER (one instance shared by every car).

Run:  cd server && ..\\backend\\venv\\Scripts\\python -m uvicorn main:app --port 8000

Responsibilities
  • Receive hazard reports from cars (online immediately, or later from their offline queue)
  • Haversine clustering so a cluster of nearby hazards is alerted only once
  • Serve hazards lying on a planned route (cars download + cache them)
  • Federated learning: FedAvg of fusion-engine weights, publish new versions to cars
  • Optional detector fine-tune on driver-verified photos
"""
import json
import uuid
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import clustering
import config
import db
import federated

db.init_db()


def _seed_demo_clusters():
    """A few known hazards near Mumbai so a planned route isn't empty on first run."""
    if db.list_clusters(active_only=False):
        return
    for lat, lon, t, conf, sev in [
        (19.0760, 72.8777, "pothole", 0.91, "high"),
        (19.0820, 72.8820, "debris", 0.72, "medium"),
        (19.0700, 72.8700, "pothole", 0.65, "medium"),
        (19.0880, 72.8900, "speed_bump", 0.80, "low"),
    ]:
        db.insert_cluster({"hazard_type": t, "latitude": lat, "longitude": lon,
                           "severity": sev, "confidence": conf, "verified": True})


_seed_demo_clusters()

app =FastAPI(title="VW Hazard Detection — Global Server", version="4.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=config.CORS_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/images", StaticFiles(directory=str(config.IMAGES_DIR)), name="images")


@app.get("/")
def root():
    return {"service": "vw-hazard-global-server", "docs": "/docs"}


@app.get("/api/health")
def health():
    return {"status": "ok", "role": "server", "model_version": db.latest_model()["version"]}


# ── Clients ────────────────────────────────────────────────────────────────

class ClientIn(BaseModel):
    model_config = {"protected_namespaces": ()}
    client_id: str
    name: Optional[str] = None
    model_version: Optional[int] = None


@app.post("/api/clients/register")
def register_client(c: ClientIn):
    db.touch_client(c.client_id, c.name, c.model_version)
    return {"ok": True, "model": federated.current_model()}


@app.get("/api/clients")
def clients():
    return {"clients": db.list_clients()}


# ── Hazard reports ─────────────────────────────────────────────────────────

@app.post("/api/reports")
async def upload_report(meta: str = Form(...), image: Optional[UploadFile] = File(None)):
    """
    One newly detected hazard from a car. `meta` is JSON; `image` is the privacy-blurred
    frame (JPEG). Idempotent on report_uid so a car can safely retry its offline queue.
    """
    try:
        r = json.loads(meta)
    except ValueError:
        raise HTTPException(422, "meta must be JSON")
    for k in ("report_uid", "client_id", "hazard_type", "latitude", "longitude"):
        if k not in r:
            raise HTTPException(422, f"missing {k}")

    existing = db.get_report_by_uid(r["report_uid"])
    if existing:
        c = db.get_cluster(existing["cluster_id"]) if existing["cluster_id"] else None
        return {"status": "duplicate", "report_id": existing["id"], "cluster_id": existing["cluster_id"], "cluster": c}

    db.touch_client(r["client_id"], r.get("client_name"))
    if image is not None:
        data = await image.read()
        if data:
            fname = f"{uuid.uuid4().hex[:16]}.jpg"
            (config.IMAGES_DIR / fname).write_bytes(data)
            r["image_file"] = fname

    report_id = db.insert_report(r)
    cluster_id, how, dist = clustering.assign_report(r)
    db.set_report_cluster(report_id, cluster_id)
    cluster = db.get_cluster(cluster_id)
    return {
        "status": "accepted",
        "report_id": report_id,
        "cluster_id": cluster_id,
        "cluster_action": how,            # created → new alert; merged → already alerted once
        "distance_to_cluster_m": dist,
        "cluster": cluster,
    }


@app.get("/api/reports")
def reports(limit: int = 50, verified_only: bool = False):
    return {"reports": db.list_reports(limit, verified_only)}


# ── Clustered hazards ──────────────────────────────────────────────────────

@app.get("/api/hazards")
def hazards(hazard_type: Optional[str] = None, include_inactive: bool = False):
    return {"hazards": db.list_clusters(active_only=not include_inactive, hazard_type=hazard_type),
            "cluster_radius_m": config.CLUSTER_RADIUS_M}


class RouteIn(BaseModel):
    coords: list[list[float]]          # [[lng, lat], ...]
    corridor_m: Optional[float] = None


@app.post("/api/hazards/route")
def hazards_on_route(body: RouteIn):
    hz = clustering.hazards_on_route(body.coords, body.corridor_m)
    return {"hazards": hz, "corridor_m": body.corridor_m or config.ROUTE_CORRIDOR_M}


class ReclusterIn(BaseModel):
    eps_m: Optional[float] = None
    min_pts: Optional[int] = None


@app.post("/api/clusters/recluster")
def recluster(body: ReclusterIn = ReclusterIn()):
    return clustering.dbscan_recluster(body.eps_m, body.min_pts)


# ── Federated learning ─────────────────────────────────────────────────────

@app.get("/api/fl/model")
def fl_model():
    return federated.current_model()


class UpdateIn(BaseModel):
    client_id: str
    base_version: int
    weights: list[float]
    bias: float
    n_samples: int
    local_metrics: dict = {}


@app.post("/api/fl/update")
def fl_update(u: UpdateIn):
    if len(u.weights) != len(config.FL_FEATURES):
        raise HTTPException(422, f"expected {len(config.FL_FEATURES)} weights")
    db.touch_client(u.client_id)
    uid = db.insert_update(u.model_dump())
    agg = federated.aggregate()
    return {"update_id": uid, "aggregation": agg}


@app.post("/api/fl/aggregate")
def fl_aggregate():
    return federated.aggregate(force=True)


@app.get("/api/fl/rounds")
def fl_rounds():
    return {"models": db.list_models(), "updates": db.list_updates(), "pending": len(db.pending_updates())}


@app.post("/api/fl/detector/train")
def detector_train():
    return federated.start_detector_training()


@app.get("/api/fl/detector/jobs")
def detector_jobs():
    return {"jobs": db.list_detector_jobs()}


@app.get("/api/fl/detector/latest")
def detector_latest():
    job = db.latest_ready_detector()
    if not job:
        raise HTTPException(404, "no fine-tuned detector yet")
    return FileResponse(config.MODELS_DIR / job["weights_file"], filename=job["weights_file"],
                        headers={"X-Detector-Version": str(job["version"])})


# ── Console summary ────────────────────────────────────────────────────────

@app.get("/api/stats")
def stats():
    reps = db.list_reports(limit=100000)
    return {
        "clients": len(db.list_clients()),
        "reports": len(reps),
        "reports_verified": sum(1 for r in reps if r["verified"]),
        "reports_from_offline_queue": sum(1 for r in reps if r["was_offline"]),
        "clusters": len(db.list_clusters(active_only=True)),
        "model_version": db.latest_model()["version"],
        "pending_fl_updates": len(db.pending_updates()),
        "cluster_radius_m": config.CLUSTER_RADIUS_M,
    }
