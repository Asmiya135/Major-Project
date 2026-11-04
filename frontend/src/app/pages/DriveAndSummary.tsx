import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { Clock, Navigation, TrendingUp, Lock, ThumbsUp, ThumbsDown, HelpCircle, CheckCircle2 } from 'lucide-react';
import { NavigationView } from '../components/NavigationView';
import { VerifyModal } from '../components/VerifyModal';
import { AlertBanner } from '../components/AlertBanner';
import { CarStatusBar } from '../components/CarStatusBar';
import { OlaMap, type HazardMarker } from '../components/OlaMap';
import { HazardIcon } from '../components/HazardIcon';
import { useEdgeEvents } from '../../hooks/useEdgeEvents';
import { useTrip } from '../../hooks/useTrip';
import { useHazards } from '../../hooks/useHazards';
import { submitFeedback } from '../../api/feedback';
import { edge } from '../../api/edge';
import type { Detection, PendingFeedback, TripSummary } from '../../api/types';
import type { DirectionsResult, NavigationStep, TransportMode } from '../../api/olamaps';

type ViewMode = 'live' | 'summary';

const LABELS: Record<string, string> = {
  pothole: 'Pothole', debris: 'Debris', bump: 'Bump', speed_bump: 'Speed bump',
  stalled_vehicle: 'Stalled Vehicle', flood: 'Flood',
};

const MUMBAI: [number, number] = [72.8777, 19.076];
const DEMO_HAZARD_M = 300;        // pre-mapped demo hazard: this far along the route
const DEMO_SEE_AHEAD_M = 25;      // the simulated camera "sees" it this far ahead
const TICK_MS = 500;
const MATCH_MAX_M = 600;          // a V2X hazard this close to our route counts as "on our route"

function hav(a: [number, number], b: [number, number]) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Point `dist` metres along a [lng,lat] polyline, plus the heading of that segment. */
function along(coords: [number, number][], dist: number): { p: [number, number]; heading: number; done: boolean } {
  let left = dist;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const seg = hav(a, b);
    if (left <= seg && seg > 0) {
      const t = left / seg;
      const heading = (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading, done: false };
    }
    left -= seg;
  }
  return { p: coords[coords.length - 1] ?? MUMBAI, heading: 0, done: true };
}

/** Map-match a point onto a [lng,lat] polyline: distance along it and perpendicular offset (metres). */
function matchToRoute(coords: [number, number][], pt: [number, number]): { along: number; offset: number } {
  const k = Math.cos(pt[1] * Math.PI / 180) * 111320, ky = 110540;
  let best = { along: 0, offset: Infinity }, cum = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const ax = a[0] * k, ay = a[1] * ky, bx = b[0] * k, by = b[1] * ky, px = pt[0] * k, py = pt[1] * ky;
    const dx = bx - ax, dy = by - ay, seg2 = dx * dx + dy * dy;
    const t = seg2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / seg2)) : 0;
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (off < best.offset) best = { along: cum + t * Math.sqrt(seg2), offset: off };
    cum += Math.sqrt(seg2);
  }
  return best;
}

export default function DriveAndSummary() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const navState  = location.state as {
    sessionId?:   string;
    destination?: { lat: number; lng: number; label: string };
    directions?:  DirectionsResult;
    mode?:        TransportMode;
    demo?:        boolean;
  } | null;
  const demo = !!navState?.demo;

  const routeCoords: [number, number][] = navState?.directions?.routeCoords ?? [];
  const steps:       NavigationStep[]   = navState?.directions?.steps        ?? [];
  const mode:        TransportMode      = navState?.mode ?? 'driving';
  const destination                     = navState?.destination ?? null;

  const [viewMode,   setViewMode]   = useState<ViewMode>('live');
  const [speed,      setSpeed]      = useState(30);
  const [tripSummary, setTripSummary] = useState<TripSummary | null>(null);
  const [feedbackSent,    setFeedbackSent]    = useState<Set<number>>(new Set());
  const [userLngLat, setUserLngLat] = useState<[number, number] | null>(routeCoords[0] ?? null);
  const [simulate,   setSimulate]   = useState(routeCoords.length > 1);
  const [detections, setDetections] = useState<Detection[]>([]);

  const speedRef    = useRef(30);
  const headingRef  = useRef(0);
  const posRef      = useRef<[number, number] | null>(routeCoords[0] ?? null);
  const travelled   = useRef(0);
  speedRef.current  = speed;

  // ── Demo: pre-mapped hazard on this route + hazards heard over Bluetooth ─
  const routeLen = routeCoords.slice(1).reduce((s, p, i) => s + hav(routeCoords[i], p), 0);
  const demoAlong = Math.min(DEMO_HAZARD_M, routeLen * 0.45);
  const demoPoint = demo && routeCoords.length > 1 ? along(routeCoords, demoAlong).p : null;
  const [demoState, setDemoState] = useState<'ahead' | 'detecting' | 'reported' | 'known-via-v2x'>('ahead');
  const [demoResult, setDemoResult] = useState<string>('');
  const [btHeard, setBtHeard] = useState<{ id: string; lat: number; lon: number; type: string; from: string; transport: string; alerted: boolean }[]>([]);
  const [travelledM, setTravelledM] = useState(0);
  const speedInit = useRef(false);

  // ── Car link: telemetry out, alerts / verification / reports in ─────────
  const ev = useEdgeEvents({
    onMessage: (m) => {
      if (m.type === 'bt_received' || m.type === 'bt_alert') {
        setBtHeard((prev) => {
          const rest = prev.filter((h) => h.id !== m.msg_id);
          const old = prev.find((h) => h.id === m.msg_id);
          return [...rest, { id: m.msg_id, lat: m.latitude, lon: m.longitude, type: m.hazard_type,
                             from: m.from_name ?? m.from_client, transport: m.transport,
                             alerted: (old?.alerted ?? false) || m.type === 'bt_alert' }];
        });
      }
      if (m.type === 'hazard_detected') {
        setDetections((prev) => [{
          id: m.detection_id, hazard_id: m.hazard_id ?? 0, latitude: m.latitude, longitude: m.longitude,
          hazard_type: m.hazard_type, severity: m.severity, confidence: m.confidence, distance_m: m.distance_m,
          lane: m.lane, source: 'vehicle' as const, timestamp: new Date().toISOString(), needs_feedback: 0,
        }, ...prev].slice(0, 50));
      }
    },
  });

  // ── Real GPS (when not simulating) ──────────────────────────────────────
  useEffect(() => {
    if (simulate || !navigator.geolocation) return;
    const wid = navigator.geolocation.watchPosition(
      (p) => {
        const ll: [number, number] = [p.coords.longitude, p.coords.latitude];
        posRef.current = ll;
        setUserLngLat(ll);
        if (p.coords.speed != null) setSpeed(Math.round(p.coords.speed * 3.6));
        if (p.coords.heading != null && !Number.isNaN(p.coords.heading)) headingRef.current = p.coords.heading;
      },
      () => { if (!posRef.current) { posRef.current = MUMBAI; setUserLngLat(MUMBAI); } },
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(wid);
  }, [simulate]);

  // ── Simulated drive along the planned route + telemetry to the car ─────
  useEffect(() => {
    const id = setInterval(() => {
      if (simulate && routeCoords.length > 1) {
        travelled.current += (speedRef.current / 3.6) * (TICK_MS / 1000);
        const a = along(routeCoords, travelled.current);
        posRef.current = a.p;
        headingRef.current = a.heading;
        setUserLngLat(a.p);
        setTravelledM(travelled.current);
        if (a.done) setSimulate(false);
      }
      const p = posRef.current;
      if (p) ev.sendTelemetry({ lat: p[1], lon: p[0], speed_kmh: speedRef.current, heading_deg: headingRef.current,
                                source: simulate ? 'simulated-route' : 'gps' });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [simulate, routeCoords, ev.sendTelemetry]);

  // Demo: car A defaults faster than car B so A reaches the hazard first
  useEffect(() => {
    if (!demo || speedInit.current || !ev.status) return;
    speedInit.current = true;
    setSpeed(/a$/i.test(ev.status.client_id) ? 40 : 25);
  }, [demo, ev.status]);

  // Demo: simulated camera reaches the pre-mapped hazard
  useEffect(() => {
    if (!demo || !demoPoint || demoState !== 'ahead') return;
    if (travelledM < demoAlong - DEMO_SEE_AHEAD_M) return;
    const known = btHeard[0];      // in the demo the only V2X hazard is this pothole
    if (known) {
      setDemoState('known-via-v2x');
      setDemoResult(`Already received from ${known.from} over Bluetooth — not re-reported`);
      return;
    }
    setDemoState('detecting');
    edge.demoDetect({ hazard_type: 'pothole', latitude: demoPoint[1], longitude: demoPoint[0], distance_m: demoAlong - travelledM })
      .then((r) => {
        setDemoState('reported');
        setDemoResult(`Detected pothole (fusion ${r.fusion.score.toFixed(2)} → ${r.fusion.routing}) · `
          + `${r.delivery === 'sent_to_server' ? 'sent to server' : 'queued offline'} · Bluetooth: ${r.bluetooth.transports.join(', ') || 'no transport'}`);
      })
      .catch((e) => { setDemoState('ahead'); setDemoResult(`Detection failed: ${e}`); });
  }, [demo, demoPoint, demoAlong, travelledM, demoState, btHeard]);

  // Demo: hazards heard over V2X are map-matched onto OUR route (the two cars' routes can start
  // at slightly different points), and the alert fires when we come within the geofence radius.
  const localAlerted = useRef<Set<string>>(new Set());
  const radius = ev.status?.v2x_radius_m ?? 15;
  const matched = btHeard.map((h) => ({ h, m: routeCoords.length > 1 ? matchToRoute(routeCoords, [h.lon, h.lat]) : null }));
  useEffect(() => {
    if (!demo) return;
    for (const { h, m } of matched) {
      if (!m || m.offset > MATCH_MAX_M || h.alerted || localAlerted.current.has(h.id)) continue;
      const ahead = m.along - travelledM;
      if (ahead <= radius && ahead > -radius) {
        localAlerted.current.add(h.id);
        ev.raiseBtAlert({
          msg_id: h.id, hazard_type: h.type, severity: 'high', distance_m: Math.max(0, Math.round(ahead)), radius_m: radius,
          from_client: h.from, from_name: h.from, transport: h.transport, latitude: h.lat, longitude: h.lon,
          message: `${h.type.replace(/_/g, ' ')} ${Math.max(0, Math.round(ahead))} metres ahead, reported by ${h.from} over Bluetooth`,
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, travelledM, btHeard]);

  useEffect(() => { ev.resetRouteAlerts(); }, [ev.resetRouteAlerts, ev.connected]);

  // ── Session ──────────────────────────────────────────────────────────
  const { end } = useTrip();

  // ── Hazards for the map: known clusters + this drive's detections ───
  const { hazards: allHazards } = useHazards({ pollInterval: 5000 });
  const known: HazardMarker[] = allHazards.map((h) => ({
    id: `k${h.id}`, type: h.hazard_type as HazardMarker['type'], severity: h.severity as HazardMarker['severity'],
    latitude: h.latitude, longitude: h.longitude, reports: h.count, confidence: h.confidence,
    first_seen: h.first_seen, last_seen: h.last_seen,
  }));
  const live: HazardMarker[] = detections.map((d) => ({
    id: `d${d.id}`, type: d.hazard_type as HazardMarker['type'], severity: d.severity as HazardMarker['severity'],
    latitude: d.latitude, longitude: d.longitude, confidence: d.confidence, first_seen: d.timestamp,
    label: `just detected · ${Math.round(d.distance_m)}m · ${d.lane}`,
  }));
  const heard: HazardMarker[] = btHeard.map((h) => ({
    id: `bt${h.id}`, type: h.type as HazardMarker['type'], severity: 'high',
    latitude: h.lat, longitude: h.lon, label: `from ${h.from} via ${h.transport}`,
  }));
  const demoMarker: HazardMarker[] = demoPoint && demoState === 'ahead' && !btHeard.length ? [{
    id: 'demo', type: 'pothole', severity: 'high', latitude: demoPoint[1], longitude: demoPoint[0],
    label: 'pre-mapped demo hazard (simulated road)',
  }] : [];
  const mapHazards = [...heard, ...demoMarker, ...live, ...known];

  const alert = ev.btAlert
    ? { text: ev.btAlert.message, sev: 'high' as const }
    : ev.routeAlert ? { text: String(ev.routeAlert.message), sev: (ev.routeAlert.hazard?.severity ?? 'medium') as 'high' | 'medium' | 'low' } : null;

  // ── End trip ─────────────────────────────────────────────────────────
  const handleEndTrip = useCallback(async () => {
    const summary = await end({
      distance_km: Math.round(travelled.current / 100) / 10,
      avg_speed_km: Math.round(speedRef.current),
      hazards_avoided: detections.length,
      hazards_reported: detections.length,
    });
    if (summary) setTripSummary(summary);
    setViewMode('summary');
  }, [end, detections.length]);

  const handleFeedback = useCallback(async (item: PendingFeedback, response: 'yes' | 'no' | 'unsure') => {
    setFeedbackSent((prev) => new Set(prev).add(item.hazard_id));
    await submitFeedback({ hazard_id: item.hazard_id, session_id: 'drive', response }).catch(() => null);
  }, []);

  const verify = ev.verifyQueue[0];

  // ── LIVE VIEW ─────────────────────────────────────────────────────────
  if (viewMode === 'live') {
    return (
      <>
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50 }}>
          <CarStatusBar status={ev.status} connected={ev.connected} />
        </div>
        <NavigationView
          steps={steps}
          routeCoords={routeCoords}
          userLngLat={userLngLat}
          hazards={mapHazards}
          speedKmh={speed}
          mode={mode}
          destination={destination ?? undefined}
          alertText={alert?.text}
          alertSev={alert?.sev}
          onDismissAlert={() => { ev.dismissBtAlert(); ev.dismissRouteAlert(); }}
          onEndTrip={handleEndTrip}
        />
        <AlertBanner bt={ev.btAlert} route={null} onCloseBt={ev.dismissBtAlert} onCloseRoute={ev.dismissRouteAlert} />
        <div style={{ position: 'fixed', left: 12, bottom: 90, zIndex: 60 }}
             className="bg-black/75 text-white rounded-xl p-3 text-xs space-y-2 w-60">
          <div className="flex items-center justify-between"><span>Speed</span><b>{speed} km/h</b></div>
          <input type="range" min={0} max={120} value={speed} onChange={(e) => setSpeed(+e.target.value)} className="w-full" />
          {routeCoords.length > 1 && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
              simulate driving along route
            </label>
          )}
          <div className="text-gray-400">capture rate {ev.status?.capture_policy.target_fps ?? '—'} fps · known hazards alert within route range</div>
        </div>

        {demo && (
          <div style={{ position: 'fixed', right: 12, bottom: 90, zIndex: 60 }}
               className="bg-black/80 text-white rounded-xl p-3 text-xs space-y-2 w-80">
            <div className="font-semibold text-orange-300">DEMO — simulated road · {ev.status?.client_name}</div>
            <div>Driven {Math.round(travelledM)} m of {Math.round(routeLen)} m</div>
            {demoPoint && demoState === 'ahead' && !btHeard.length && (
              <div>Pre-mapped hazard in <b>{Math.max(0, Math.round(demoAlong - travelledM))} m</b> — camera sees it at {DEMO_SEE_AHEAD_M} m</div>
            )}
            {demoState === 'detecting' && <div className="text-yellow-300">📷 Detecting…</div>}
            {demoResult && <div className={demoState === 'reported' ? 'text-red-300' : 'text-sky-300'}>{demoResult}</div>}
            {matched.map(({ h, m }) => {
              const onRoute = !!m && m.offset <= MATCH_MAX_M;
              const ahead = onRoute ? Math.round(m!.along - travelledM) : null;
              const straight = userLngLat ? Math.round(hav(userLngLat, [h.lon, h.lat])) : null;
              const alerted = h.alerted || localAlerted.current.has(h.id);
              return (
                <div key={h.id} className={`rounded-lg p-2 ${alerted ? 'bg-red-600/50' : 'bg-sky-700/40'}`}>
                  📶 {h.type.replace(/_/g, ' ')} from <b>{h.from}</b> via {h.transport}<br />
                  {alerted ? '⚠ ALERTED — hazard ahead!'
                    : ahead !== null ? (ahead > 0 ? `${ahead} m ahead on your route · alert inside ${radius} m` : 'passed')
                    : `${straight ?? '?'} m away (not on your route — use the same start/destination)`}
                  {onRoute && m!.offset > 30 && <div className="text-gray-300">matched to your route ({Math.round(m!.offset)} m from the other car's route)</div>}
                </div>
              );
            })}
            {!btHeard.length && demoState !== 'reported' && (
              <div className="text-gray-400">Listening for Bluetooth V2X alerts from nearby cars…</div>
            )}
          </div>
        )}
        {verify && <VerifyModal key={verify.verify_id} req={verify} pending={ev.verifyQueue.length} onDone={ev.dropVerify} />}
      </>
    );
  }

  // ── SUMMARY VIEW ──────────────────────────────────────────────────────
  const trip           = tripSummary?.trip;
  const hazardsAvoided = trip?.hazards_avoided ?? detections.length;
  const distanceKm     = trip?.distance_km ?? Math.round(travelled.current / 100) / 10;
  const durationMin    = trip?.end_time && trip?.start_time
    ? Math.round((new Date(trip.end_time).getTime() - new Date(trip.start_time).getTime()) / 60000)
    : 0;
  const avgSpeed       = trip?.avg_speed_km ?? Math.round(speedRef.current);
  const sumDetections: Detection[] = tripSummary?.detections ?? detections;
  const summaryPending = (tripSummary?.pending_feedback ?? []).filter((f) => !feedbackSent.has(f.hazard_id));

  return (
    <div className="w-full min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1">Trip Summary</h1>
          <p className="text-muted-foreground text-sm">Your journey insights and contributions</p>
        </div>

        <div className="bg-gradient-to-br from-[#001E50] to-blue-700 rounded-2xl p-7 mb-7 text-white shadow-lg">
          <div className="text-4xl md:text-5xl font-bold mb-2">{hazardsAvoided} Hazards Reported</div>
          <div className="flex items-center gap-5 text-blue-100 text-sm flex-wrap">
            <span className="flex items-center gap-1.5"><Navigation className="w-3.5 h-3.5" />{distanceKm} km</span>
            <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{durationMin} min</span>
            <span className="flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5" />Avg {avgSpeed} km/h</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-7">
          <div className="bg-white rounded-xl p-5 border border-border shadow-sm">
            <h3 className="font-semibold mb-3">Route</h3>
            <div className="aspect-video rounded-xl overflow-hidden">
              <OlaMap center={userLngLat ?? MUMBAI} zoom={13} hazards={mapHazards.slice(0, 30)}
                      routeCoords={routeCoords} destination={destination ?? undefined} className="rounded-none" />
            </div>
          </div>

          <div className="bg-white rounded-xl p-5 border border-border shadow-sm">
            <h3 className="font-semibold mb-3">Your Contributions</h3>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="text-center p-4 bg-green-50 rounded-xl border border-green-200">
                <div className="text-3xl font-bold text-green-600 mb-0.5">{tripSummary?.total_detected ?? sumDetections.length}</div>
                <div className="text-xs text-green-700">Hazards Reported</div>
              </div>
              <div className="text-center p-4 bg-blue-50 rounded-xl border border-blue-200">
                <div className="text-3xl font-bold text-blue-600 mb-0.5">{ev.status?.outbox.sent ?? 0}</div>
                <div className="text-xs text-blue-700">Delivered to server ({ev.status?.outbox.queued ?? 0} queued)</div>
              </div>
            </div>
            {tripSummary?.hazard_breakdown && Object.keys(tripSummary.hazard_breakdown).length > 0 && (
              <div className="mb-4">
                <div className="text-xs font-semibold text-muted-foreground mb-2">BREAKDOWN</div>
                {Object.entries(tripSummary.hazard_breakdown).map(([t, c]) => (
                  <div key={t} className="flex justify-between text-sm py-0.5">
                    <span className="text-muted-foreground capitalize">{LABELS[t] ?? t}</span>
                    <span className="font-semibold">{c}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-start gap-3 p-3.5 bg-[#001E50]/5 rounded-xl border border-[#001E50]/15">
              <Lock className="w-4 h-4 text-[#001E50] flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold mb-0.5">Federated Learning — fusion model v{ev.status?.fusion_model.version ?? '—'}</div>
                <div className="text-xs text-muted-foreground">
                  {ev.status?.fl_samples ?? 0} driver-labelled samples trained on this car; only weights were shared with the server.
                </div>
              </div>
            </div>
          </div>
        </div>

        {summaryPending.length > 0 && (
          <div className="bg-white rounded-xl p-5 border border-border shadow-sm mb-7">
            <h3 className="font-semibold mb-4">Pending verifications</h3>
            <div className="space-y-3">
              {summaryPending.map((item) => (
                <div key={item.hazard_id} className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
                  <div className="w-14 h-14 bg-gray-200 rounded-xl flex items-center justify-center flex-shrink-0">
                    <HazardIcon type={item.hazard_type === 'pothole' || item.hazard_type === 'flood' ? item.hazard_type : 'debris'} className="w-6 h-6 text-gray-500" />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium mb-0.5">Did you encounter this {LABELS[item.hazard_type]?.toLowerCase() ?? 'hazard'}?</div>
                    <div className="text-xs text-muted-foreground mb-2.5">{new Date(item.timestamp).toLocaleTimeString()}</div>
                    {feedbackSent.has(item.hazard_id) ? (
                      <div className="flex items-center gap-1.5 text-green-600 text-xs"><CheckCircle2 className="w-3.5 h-3.5" />Feedback submitted</div>
                    ) : (
                      <div className="flex gap-2">
                        <button onClick={() => handleFeedback(item, 'yes')} className="px-3.5 py-1.5 bg-green-600 text-white rounded-lg text-xs hover:bg-green-700"><ThumbsUp className="w-3 h-3 inline mr-1" />Yes</button>
                        <button onClick={() => handleFeedback(item, 'no')} className="px-3.5 py-1.5 bg-red-600 text-white rounded-lg text-xs hover:bg-red-700"><ThumbsDown className="w-3 h-3 inline mr-1" />No</button>
                        <button onClick={() => handleFeedback(item, 'unsure')} className="px-3.5 py-1.5 bg-gray-500 text-white rounded-lg text-xs hover:bg-gray-600"><HelpCircle className="w-3 h-3 inline mr-1" />Unsure</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-center">
          <button onClick={() => navigate('/')} className="px-8 py-3.5 bg-[#001E50] text-white rounded-xl hover:bg-[#001E50]/90 shadow-lg font-semibold">
            Plan New Trip
          </button>
        </div>
      </div>
    </div>
  );
}
