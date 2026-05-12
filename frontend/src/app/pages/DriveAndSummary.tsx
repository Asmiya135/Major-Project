import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { Clock, Navigation, TrendingUp, Lock, ThumbsUp, ThumbsDown, HelpCircle, Play, CheckCircle2 } from 'lucide-react';
import { NavigationView } from '../components/NavigationView';
import { OlaMap, type HazardMarker } from '../components/OlaMap';
import { HazardIcon } from '../components/HazardIcon';
import { useDriveFeed } from '../../hooks/useDriveFeed';
import { useTrip } from '../../hooks/useTrip';
import { useHazards } from '../../hooks/useHazards';
import { submitFeedback } from '../../api/feedback';
import type { Detection, PendingFeedback, TripSummary } from '../../api/types';
import type { DirectionsResult, NavigationStep, TransportMode } from '../../api/olamaps';

type ViewMode = 'live' | 'summary';

const LABELS: Record<string, string> = {
  pothole: 'Pothole', debris: 'Debris', bump: 'Bump',
  stalled_vehicle: 'Stalled Vehicle', flood: 'Flood',
};

const MUMBAI: [number, number] = [72.8777, 19.076];

export default function DriveAndSummary() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const navState  = location.state as {
    sessionId?:   string;
    destination?: { lat: number; lng: number; label: string };
    directions?:  DirectionsResult;
    mode?:        TransportMode;
  } | null;

  const routeCoords: [number, number][] = navState?.directions?.routeCoords ?? [];
  const steps:       NavigationStep[]   = navState?.directions?.steps        ?? [];
  const mode:        TransportMode      = navState?.mode ?? 'driving';
  const destination                     = navState?.destination ?? null;

  const [viewMode,   setViewMode]   = useState<ViewMode>('live');
  const [speed,      setSpeed]      = useState(0);
  const [tripSummary, setTripSummary] = useState<TripSummary | null>(null);
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback[]>([]);
  const [feedbackSent,    setFeedbackSent]    = useState<Set<number>>(new Set());
  const [alertText,  setAlertText]  = useState<string | undefined>();
  const [alertSev,   setAlertSev]   = useState<'high'|'medium'|'low'>('high');
  const [userLngLat, setUserLngLat] = useState<[number, number] | null>(null);

  const speedRef    = useRef(0);
  const distanceRef = useRef(0);
  const prevTimeRef = useRef(Date.now());

  // ── GPS ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.geolocation) { setUserLngLat(MUMBAI); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setUserLngLat([p.coords.longitude, p.coords.latitude]),
      () => setUserLngLat(MUMBAI),
    );
    const wid = navigator.geolocation.watchPosition(
      (p) => {
        setUserLngLat([p.coords.longitude, p.coords.latitude]);
        const s = Math.round((p.coords.speed ?? 0) * 3.6);
        setSpeed(s); speedRef.current = s;
      },
      () => {},
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(wid);
  }, []);

  // ── Speed simulation (when no real GPS speed) ────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const delta = (Math.random() - 0.45) * 7;
      const s = Math.max(0, Math.min(100, speedRef.current + delta));
      speedRef.current = s;
      setSpeed(Math.round(s));
      const now = Date.now();
      distanceRef.current += (s / 3600) * ((now - prevTimeRef.current) / 1000);
      prevTimeRef.current = now;
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // ── Session ──────────────────────────────────────────────────────────
  const { sessionId, end, ending } = useTrip();
  const activeSession = navState?.sessionId ?? sessionId;

  // ── WebSocket drive feed ─────────────────────────────────────────────
  const { connected, detections, sendSpeed, sendLocation, dismissAlert } = useDriveFeed({
    sessionId: activeSession,
    onHazardDetected: (det) => {
      setAlertText(`${LABELS[det.hazard_type] ?? det.hazard_type} ahead — ${Math.round(det.distance_m)}m · ${det.lane}`);
      setAlertSev(det.severity);
      if (det.needs_feedback) {
        setPendingFeedback((prev) => [
          { detection_id: det.detection_id, hazard_id: det.hazard_id,
            hazard_type: det.hazard_type, timestamp: new Date().toISOString() },
          ...prev.filter((f) => f.hazard_id !== det.hazard_id).slice(0, 4),
        ]);
      }
      setTimeout(() => setAlertText(undefined), 8000);
    },
    onCaptureRate: () => {},
  });

  // Send speed + location to WS every 2 s
  useEffect(() => {
    const id = setInterval(() => {
      sendSpeed(speedRef.current);
      if (userLngLat) sendLocation(userLngLat[1], userLngLat[0]);
    }, 2000);
    return () => clearInterval(id);
  }, [sendSpeed, sendLocation, userLngLat]);

  // ── Community hazards for map ────────────────────────────────────────
  const { hazards: allHazards } = useHazards({ since_hours: 24 });

  const liveHazardMarkers: HazardMarker[] = detections.slice(0, 20).map((d) => ({
    id: String(d.id), type: d.hazard_type as HazardMarker['type'],
    severity: d.severity as HazardMarker['severity'],
    latitude: d.latitude, longitude: d.longitude,
    label: `${Math.round(d.distance_m)}m · ${d.lane}`,
  }));

  const mapHazards: HazardMarker[] = liveHazardMarkers.length > 0
    ? liveHazardMarkers
    : allHazards.slice(0, 10).map((h) => ({
        id: String(h.id), type: h.hazard_type as HazardMarker['type'],
        severity: h.severity as HazardMarker['severity'],
        latitude: h.latitude, longitude: h.longitude, reports: h.count,
      }));

  // ── End trip ─────────────────────────────────────────────────────────
  const handleEndTrip = useCallback(async () => {
    const summary = await end({
      distance_km: Math.round(distanceRef.current * 10) / 10,
      avg_speed_km: Math.round(speedRef.current),
      hazards_avoided: detections.length,
      hazards_reported: detections.length,
    });
    if (summary) { setTripSummary(summary); setPendingFeedback(summary.pending_feedback ?? []); }
    setViewMode('summary');
  }, [end, detections.length]);

  // ── Feedback ─────────────────────────────────────────────────────────
  const handleFeedback = useCallback(
    async (item: PendingFeedback, response: 'yes'|'no'|'unsure') => {
      if (!activeSession) return;
      setFeedbackSent((prev) => new Set(prev).add(item.hazard_id));
      await submitFeedback({ hazard_id: item.hazard_id, session_id: activeSession, response }).catch(() => null);
    },
    [activeSession],
  );

  // ── LIVE VIEW (NavigationView) ────────────────────────────────────────
  if (viewMode === 'live') {
    return (
      <NavigationView
        steps={steps}
        routeCoords={routeCoords}
        userLngLat={userLngLat}
        hazards={mapHazards}
        speedKmh={speed}
        mode={mode}
        destination={destination ?? undefined}
        alertText={alertText}
        alertSev={alertSev}
        onDismissAlert={dismissAlert}
        onEndTrip={handleEndTrip}
      />
    );
  }

  // ── SUMMARY VIEW ──────────────────────────────────────────────────────
  const trip           = tripSummary?.trip;
  const hazardsAvoided = trip?.hazards_avoided ?? detections.length;
  const distanceKm     = trip?.distance_km ?? Math.round(distanceRef.current * 10) / 10;
  const durationMin    = trip?.end_time && trip?.start_time
    ? Math.round((new Date(trip.end_time).getTime() - new Date(trip.start_time).getTime()) / 60000)
    : 0;
  const avgSpeed       = trip?.avg_speed_km ?? Math.round(speedRef.current);
  const sumDetections: Detection[] = tripSummary?.detections ?? detections;
  const summaryPending = (tripSummary?.pending_feedback ?? pendingFeedback)
    .filter((f) => !feedbackSent.has(f.hazard_id));

  const communityMarkers: HazardMarker[] = allHazards.map((h) => ({
    id: String(h.id), type: h.hazard_type as HazardMarker['type'],
    severity: h.severity as HazardMarker['severity'],
    latitude: h.latitude, longitude: h.longitude, reports: h.count,
  }));

  return (
    <div className="w-full min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1">Trip Summary</h1>
          <p className="text-muted-foreground text-sm">Your journey insights and contributions</p>
        </div>

        {/* Hero */}
        <div className="bg-gradient-to-br from-[#001E50] to-blue-700 rounded-2xl p-7 mb-7 text-white shadow-lg">
          <div className="text-4xl md:text-5xl font-bold mb-2">{hazardsAvoided} Hazards Avoided</div>
          <div className="flex items-center gap-5 text-blue-100 text-sm flex-wrap">
            <span className="flex items-center gap-1.5"><Navigation className="w-3.5 h-3.5" />{distanceKm} km</span>
            <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{durationMin} min</span>
            <span className="flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5" />Avg {avgSpeed} km/h</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-7">
          {/* Route replay */}
          <div className="bg-white rounded-xl p-5 border border-border shadow-sm">
            <h3 className="font-semibold mb-3">Route Replay</h3>
            <div className="aspect-video rounded-xl overflow-hidden mb-3">
              <OlaMap
                center={userLngLat ?? MUMBAI} zoom={13}
                hazards={communityMarkers.slice(0, 8)}
                routeCoords={routeCoords}
                destination={destination ?? undefined}
                className="rounded-none"
              />
            </div>
            <div className="flex items-center gap-2.5">
              <button className="p-2 bg-[#001E50] text-white rounded-lg hover:bg-[#001E50]/90">
                <Play className="w-3.5 h-3.5" />
              </button>
              <input type="range" className="flex-1 accent-[#001E50]" min="0" max="100" defaultValue="0" />
              <span className="text-xs text-muted-foreground">{durationMin}:00</span>
            </div>
          </div>

          {/* Contributions */}
          <div className="bg-white rounded-xl p-5 border border-border shadow-sm">
            <h3 className="font-semibold mb-3">Your Contributions</h3>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="text-center p-4 bg-green-50 rounded-xl border border-green-200">
                <div className="text-3xl font-bold text-green-600 mb-0.5">{tripSummary?.total_detected ?? sumDetections.length}</div>
                <div className="text-xs text-green-700">Hazards Reported</div>
              </div>
              <div className="text-center p-4 bg-blue-50 rounded-xl border border-blue-200">
                <div className="text-3xl font-bold text-blue-600 mb-0.5">{sumDetections.filter((d) => !d.needs_feedback).length}</div>
                <div className="text-xs text-blue-700">Verified Reports</div>
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
                <div className="text-xs font-semibold mb-0.5">Federated Learning Active</div>
                <div className="text-xs text-muted-foreground">Model updated securely. Your data stays private.</div>
              </div>
            </div>
          </div>
        </div>

        {/* Community hazard map */}
        <div className="bg-white rounded-xl p-5 border border-border shadow-sm mb-7">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Community Hazard Map</h3>
            <span className="text-xs text-muted-foreground">{allHazards.length} active reports</span>
          </div>
          <div className="h-72 rounded-xl overflow-hidden">
            <OlaMap center={userLngLat ?? MUMBAI} zoom={12} hazards={communityMarkers} className="rounded-none" />
          </div>
        </div>

        {/* Pending feedback */}
        {summaryPending.length > 0 && (
          <div className="bg-white rounded-xl p-5 border border-border shadow-sm mb-7">
            <h3 className="font-semibold mb-4">Pending Feedback</h3>
            <div className="space-y-3">
              {summaryPending.map((item) => (
                <div key={item.hazard_id} className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
                  <div className="w-14 h-14 bg-gray-200 rounded-xl flex items-center justify-center flex-shrink-0">
                    <HazardIcon
                      type={item.hazard_type === 'stalled_vehicle' || item.hazard_type === 'bump' ? 'debris' : item.hazard_type as 'pothole'|'flood'|'debris'}
                      className="w-6 h-6 text-gray-500"
                    />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium mb-0.5">
                      Did you encounter this {LABELS[item.hazard_type]?.toLowerCase() ?? 'hazard'}?
                    </div>
                    <div className="text-xs text-muted-foreground mb-2.5">{new Date(item.timestamp).toLocaleTimeString()}</div>
                    {feedbackSent.has(item.hazard_id) ? (
                      <div className="flex items-center gap-1.5 text-green-600 text-xs">
                        <CheckCircle2 className="w-3.5 h-3.5" />Feedback submitted
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button onClick={() => handleFeedback(item, 'yes')} className="px-3.5 py-1.5 bg-green-600 text-white rounded-lg text-xs hover:bg-green-700">
                          <ThumbsUp className="w-3 h-3 inline mr-1" />Yes
                        </button>
                        <button onClick={() => handleFeedback(item, 'no')} className="px-3.5 py-1.5 bg-red-600 text-white rounded-lg text-xs hover:bg-red-700">
                          <ThumbsDown className="w-3 h-3 inline mr-1" />No
                        </button>
                        <button onClick={() => handleFeedback(item, 'unsure')} className="px-3.5 py-1.5 bg-gray-500 text-white rounded-lg text-xs hover:bg-gray-600">
                          <HelpCircle className="w-3 h-3 inline mr-1" />Unsure
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-center">
          <button onClick={() => navigate('/')}
            className="px-8 py-3.5 bg-[#001E50] text-white rounded-xl hover:bg-[#001E50]/90 shadow-lg font-semibold">
            Plan New Trip
          </button>
        </div>
      </div>
    </div>
  );
}
