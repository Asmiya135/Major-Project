"""
Car ⇄ global-server synchronisation.

  • Offline queue: every report goes into the on-device outbox first. When the car is
    online it is uploaded immediately; when offline it waits, and the background loop
    flushes the queue the moment the server is reachable again.
  • Federated learning: pull the latest FedAvg fusion model (and fine-tuned detector),
    push local weight updates trained on driver-verified samples.
  • Route hazards: download hazards along the planned route and cache them for offline use.
"""
import asyncio
import json
import threading
import time
from pathlib import Path

import httpx

import config
from services import edge_store
from services.edge_state import state
from services.fusion import engine
from websocket_manager import manager

_flush_lock = threading.Lock()
_fl_lock = threading.Lock()


def _http():
    return httpx.Client(timeout=config.SERVER_TIMEOUT_S)


def check_server() -> bool:
    if state.forced_offline:
        return False
    try:
        with _http() as c:
            r = c.get(f"{config.SERVER_URL}/api/health")
        ok = r.status_code == 200
        if ok and not state.server_reachable:
            c2 = _http()
            try:
                c2.post(f"{config.SERVER_URL}/api/clients/register",
                        json={"client_id": config.CLIENT_ID, "name": config.CLIENT_NAME,
                              "model_version": engine.version})
            finally:
                c2.close()
        state.server_reachable = ok
        state.last_sync_error = "" if ok else f"HTTP {r.status_code}"
    except httpx.HTTPError as e:
        state.server_reachable = False
        state.last_sync_error = type(e).__name__
    return state.is_online()


# ── Offline queue ──────────────────────────────────────────────────────────

def _send(row: dict) -> dict:
    payload = dict(row["payload"])
    payload["was_offline"] = bool(row["queued_offline"])
    files = None
    img = row.get("image_path")
    if img and Path(img).exists():
        files = {"image": (Path(img).name, Path(img).read_bytes(), "image/jpeg")}
    with httpx.Client(timeout=max(config.SERVER_TIMEOUT_S, 8.0)) as c:
        r = c.post(f"{config.SERVER_URL}/api/reports", data={"meta": json.dumps(payload)}, files=files)
    r.raise_for_status()
    return r.json()


def flush_outbox() -> list:
    """Upload every queued report (oldest first). Safe to call from any thread."""
    if not state.is_online():
        return []
    sent = []
    with _flush_lock:
        for row in edge_store.pending_outbox():
            if not state.is_online():
                break
            try:
                resp = _send(row)
            except (httpx.HTTPError, ValueError) as e:
                edge_store.mark_failed_attempt(row["id"], str(e))
                state.server_reachable = False
                state.last_sync_error = type(e).__name__
                break
            edge_store.mark_sent(row["id"], resp)
            p = row["payload"]
            sent.append({"outbox_id": row["id"], "response": resp})
            how = resp.get("cluster_action", resp.get("status"))
            state.add_log("sync", f"uploaded {p['hazard_type']} → cluster #{resp.get('cluster_id')} ({how})"
                                  + (" [was queued offline]" if row["queued_offline"] else ""))
            manager.emit({
                "type": "report_synced", "outbox_id": row["id"], "report_uid": p["report_uid"],
                "hazard_type": p["hazard_type"], "was_offline": bool(row["queued_offline"]),
                "verified": p.get("verified", False), "cluster_id": resp.get("cluster_id"),
                "cluster_action": how, "cluster": resp.get("cluster"),
            })
            # newly confirmed hazard is now a known hazard for this car too
            if resp.get("cluster"):
                edge_store.upsert_route_hazard(resp["cluster"])
    if sent:
        manager.emit({"type": "outbox", **edge_store.outbox_counts()})
    return sent


# ── Federated learning ─────────────────────────────────────────────────────

def pull_model() -> dict | None:
    if not state.is_online():
        return None
    try:
        with _http() as c:
            model = c.get(f"{config.SERVER_URL}/api/fl/model").json()
    except (httpx.HTTPError, ValueError):
        return None
    if engine.apply_global(model):
        state.add_log("fl", f"installed FedAvg fusion model v{engine.version} from server")
        try:
            with _http() as c:
                c.post(f"{config.SERVER_URL}/api/clients/register",
                       json={"client_id": config.CLIENT_ID, "model_version": engine.version})
        except httpx.HTTPError:
            pass
        manager.emit({"type": "fl_model_updated", "model": engine.describe()})
    if model.get("detector_version", 0) > engine.detector_version:
        _pull_detector(model["detector_version"])
    return model


def _pull_detector(version: int):
    try:
        with httpx.Client(timeout=120) as c:
            r = c.get(f"{config.SERVER_URL}/api/fl/detector/latest")
        r.raise_for_status()
        dest = config.LOCAL_MODELS_DIR / f"detector_v{version}.pt"
        dest.write_bytes(r.content)
        from services import pipeline
        pipeline.swap_detector(dest)
        engine.detector_version = version
        engine._save()
        state.add_log("fl", f"installed fine-tuned detector v{version} from server")
        manager.emit({"type": "fl_detector_updated", "detector_version": version})
    except Exception as e:  # noqa: BLE001 — never let a model download kill the sync loop
        state.add_log("fl", f"detector download failed: {e}")


def push_update(auto: bool = False) -> dict:
    """Train on local driver-labelled samples and upload only the resulting weights."""
    with _fl_lock:
        if auto and edge_store.fl_unpushed_count() < config.FL_AUTO_PUSH_EVERY:
            return {"pushed": False, "reason": "already pushed"}
        samples = edge_store.fl_samples()
        if not samples:
            return {"pushed": False, "reason": "no labelled samples yet"}
        upd = engine.train_local(samples)
        if not state.is_online():
            return {"pushed": False, "reason": "offline — will push when back online", "local": upd}
        body = {"client_id": config.CLIENT_ID, "base_version": engine.version, **upd}
        try:
            with _http() as c:
                r = c.post(f"{config.SERVER_URL}/api/fl/update", json=body)
            r.raise_for_status()
            resp = r.json()
        except (httpx.HTTPError, ValueError) as e:
            return {"pushed": False, "reason": str(e), "local": upd}
        edge_store.mark_fl_pushed()
        state.add_log("fl", f"pushed local update ({upd['n_samples']} samples, "
                            f"acc {upd['local_metrics']['accuracy_before']}→{upd['local_metrics']['accuracy']})")
        manager.emit({"type": "fl_pushed", "update": upd, "server": resp})
        agg = resp.get("aggregation", {})
        if agg.get("aggregated"):
            pull_model()
        return {"pushed": True, "local": upd, "server": resp}


def maybe_auto_push():
    if edge_store.fl_unpushed_count() >= config.FL_AUTO_PUSH_EVERY and state.is_online():
        threading.Thread(target=push_update, kwargs={"auto": True}, daemon=True).start()


# ── Route hazards ──────────────────────────────────────────────────────────

def fetch_route_hazards(coords: list) -> dict:
    if check_server():
        try:
            with httpx.Client(timeout=8) as c:
                r = c.post(f"{config.SERVER_URL}/api/hazards/route", json={"coords": coords})
            r.raise_for_status()
            hz = r.json()["hazards"]
            edge_store.replace_route_cache(hz)
            state.add_log("route", f"downloaded {len(hz)} known hazards on route (cached for offline)")
            return {"source": "server", "hazards": hz}
        except (httpx.HTTPError, ValueError, KeyError):
            pass
    return {"source": "offline-cache", "hazards": edge_store.route_cache()}


def all_server_hazards() -> list:
    if state.is_online():
        try:
            with _http() as c:
                return c.get(f"{config.SERVER_URL}/api/hazards").json()["hazards"]
        except (httpx.HTTPError, ValueError, KeyError):
            pass
    return edge_store.route_cache()


# ── Background loop ────────────────────────────────────────────────────────

def _tick():
    was = state.is_online()
    check_server()
    now = state.is_online()
    if now != was:
        state.add_log("network", "ONLINE — server reachable" if now else "OFFLINE — reports will be queued")
        manager.emit({"type": "network", "online": now, "forced_offline": state.forced_offline})
    if now:
        flush_outbox()
        pull_model()
        push_update(auto=True)


async def sync_loop():
    while True:
        try:
            await asyncio.to_thread(_tick)
        except Exception as e:  # noqa: BLE001
            state.add_log("sync", f"sync error: {e}")
        await asyncio.sleep(config.SYNC_INTERVAL_S)
