"""
Server-side spatial logic, all built on the haversine distance:
  • assign_report()  — incremental clustering of each new report (stable cluster ids)
  • dbscan_recluster() — full DBSCAN over every report (merges clusters that drifted together)
  • hazards_on_route() — clusters inside a corridor around a route polyline, ordered by distance along it

A cluster is what drivers are alerted about, so a badly broken stretch of road with
ten potholes 5 m apart produces one alert instead of ten.
"""
from math import radians, sin, cos, sqrt, atan2

import config
import db

_SEV_RANK = {"low": 1, "medium": 2, "high": 3}
EARTH_R = 6371000.0


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return EARTH_R * 2 * atan2(sqrt(a), sqrt(1 - a))


def _max_sev(a, b):
    return a if _SEV_RANK.get(a, 0) >= _SEV_RANK.get(b, 0) else b


# ── Incremental clustering ─────────────────────────────────────────────────

def assign_report(report: dict) -> tuple[int, str, float]:
    """
    Put a new report into the nearest same-type cluster within CLUSTER_RADIUS_M,
    or start a new cluster. Returns (cluster_id, "merged"|"created", distance_m).
    """
    lat, lon, htype = report["latitude"], report["longitude"], report["hazard_type"]
    best, best_d = None, None
    for c in db.list_clusters(active_only=False, hazard_type=htype):
        d = haversine_m(lat, lon, c["latitude"], c["longitude"])
        if d <= config.CLUSTER_RADIUS_M and (best_d is None or d < best_d):
            best, best_d = c, d

    t = db.now_iso()
    if best is None:
        cid = db.insert_cluster({
            "hazard_type": htype, "latitude": lat, "longitude": lon,
            "severity": report.get("severity", "medium"),
            "confidence": report.get("fusion_score", 0.0),
            "verified": report.get("verified", False),
        })
        return cid, "created", 0.0

    n = best["count"]
    new_lat = (best["latitude"] * n + lat) / (n + 1)
    new_lon = (best["longitude"] * n + lon) / (n + 1)
    db.update_cluster(
        best["id"],
        latitude=new_lat, longitude=new_lon,
        count=n + 1,
        confidence=round((best["confidence"] * n + report.get("fusion_score", 0.0)) / (n + 1), 4),
        severity=_max_sev(best["severity"], report.get("severity", "medium")),
        radius_m=round(max(best["radius_m"] or 0.0, best_d), 2),
        verified=int(bool(best["verified"]) or bool(report.get("verified"))),
        last_seen=t, active=1,
    )
    return best["id"], "merged", round(best_d, 2)


# ── Full DBSCAN recluster ──────────────────────────────────────────────────

def dbscan_recluster(eps_m: float = None, min_pts: int = None) -> dict:
    """Density-based clustering of all reports, per hazard type, using haversine distance."""
    eps_m = eps_m or config.DBSCAN_EPS_M
    min_pts = min_pts or config.DBSCAN_MIN_PTS
    reports = db.all_reports()
    before = len(db.list_clusters(active_only=False))

    by_type: dict[str, list] = {}
    for r in reports:
        by_type.setdefault(r["hazard_type"], []).append(r)

    clusters, assignments, noise = [], {}, 0
    for htype, pts in by_type.items():
        n = len(pts)
        labels = [None] * n          # None = unvisited, -1 = noise
        neigh = [
            [j for j in range(n)
             if haversine_m(pts[i]["latitude"], pts[i]["longitude"], pts[j]["latitude"], pts[j]["longitude"]) <= eps_m]
            for i in range(n)
        ]
        k = 0
        for i in range(n):
            if labels[i] is not None:
                continue
            if len(neigh[i]) < min_pts:
                labels[i] = -1
                continue
            labels[i] = k
            seeds = list(neigh[i])
            while seeds:
                j = seeds.pop()
                if labels[j] == -1:
                    labels[j] = k
                if labels[j] is not None:
                    continue
                labels[j] = k
                if len(neigh[j]) >= min_pts:
                    seeds.extend(neigh[j])
            k += 1

        for ci in range(k):
            members = [pts[i] for i in range(n) if labels[i] == ci]
            lat = sum(m["latitude"] for m in members) / len(members)
            lon = sum(m["longitude"] for m in members) / len(members)
            sev = "low"
            for m in members:
                sev = _max_sev(sev, m["severity"])
            key = f"{htype}:{ci}"
            clusters.append((key, {
                "hazard_type": htype, "latitude": lat, "longitude": lon, "severity": sev,
                "confidence": round(sum(m["fusion_score"] or 0 for m in members) / len(members), 4),
                "count": len(members),
                "radius_m": round(max(haversine_m(lat, lon, m["latitude"], m["longitude"]) for m in members), 2),
                "verified": any(m["verified"] for m in members),
                "first_seen": min(m["received_at"] for m in members),
                "last_seen": max(m["received_at"] for m in members),
            }))
            for m in members:
                assignments[m["id"]] = key
        noise += sum(1 for l in labels if l == -1)

    db.replace_all_clusters(clusters, assignments)
    return {"reports": len(reports), "clusters_before": before, "clusters_after": len(clusters),
            "noise_points": noise, "eps_m": eps_m, "min_pts": min_pts}


# ── Hazards along a route ──────────────────────────────────────────────────

def hazards_on_route(coords: list, corridor_m: float = None) -> list:
    """
    coords: route polyline as [[lng, lat], ...] (MapLibre order).
    Returns active clusters within corridor_m of the polyline, each with
    distance_along_m (from route start) and offset_m (perpendicular distance).
    """
    corridor_m = corridor_m or config.ROUTE_CORRIDOR_M
    if not coords or len(coords) < 2:
        return []
    lat0 = coords[0][1]
    kx = radians(1) * EARTH_R * cos(radians(lat0))
    ky = radians(1) * EARTH_R

    def xy(lng, lat):
        return ((lng - coords[0][0]) * kx, (lat - coords[0][1]) * ky)

    pts = [xy(c[0], c[1]) for c in coords]
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5)

    out = []
    for c in db.list_clusters(active_only=True):
        px, py = xy(c["longitude"], c["latitude"])
        best = None
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / seg2))
            qx, qy = a[0] + t * dx, a[1] + t * dy
            off = ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5
            if best is None or off < best[0]:
                best = (off, cum[i] + t * (seg2 ** 0.5))
        if best and best[0] <= corridor_m:
            out.append({**c, "offset_m": round(best[0], 1), "distance_along_m": round(best[1], 1)})
    out.sort(key=lambda h: h["distance_along_m"])
    return out
