import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { Search, MapPin, Navigation, CheckCircle2, Loader2, Settings, XCircle, Clock, Route, LocateFixed, Video, Play } from 'lucide-react';
import { OlaMap, type HazardMarker } from '../components/OlaMap';
import { HazardIcon } from '../components/HazardIcon';
import { SeverityBadge } from '../components/SeverityBadge';
import { TransportModePicker } from '../components/TransportModePicker';
import { useHazards } from '../../hooks/useHazards';
import { useTrip } from '../../hooks/useTrip';
import { fetchSystemStatus } from '../../api/feedback';
import { edge, type RouteHazard } from '../../api/edge';
import { autocomplete, getDirections } from '../../api/olamaps';
import type { Prediction, DirectionsResult, TransportMode } from '../../api/olamaps';
import type { SystemStatus } from '../../api/types';

const MUMBAI_FALLBACK = { lat: 19.076, lng: 72.8777 };

function fmtAlong(m?: number) {
  if (m == null) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

const HAZARD_LABELS: Record<string, string> = {
  pothole: 'Pothole', debris: 'Debris', bump: 'Bump',
  stalled_vehicle: 'Stalled Vehicle', flood: 'Flood', speed_bump: 'Speed bump',
};

export default function TripSetupDashboard() {
  const navigate = useNavigate();

  // ── Current user location (GPS + manual fallback) ─────────────────────
  const [currentLoc,  setCurrentLoc]  = useState<{ lat: number; lng: number } | null>(null);
  const [locLabel,    setLocLabel]    = useState('Detecting your location…');
  const [locLoading,  setLocLoading]  = useState(true);
  const [locDenied,   setLocDenied]   = useState(false);

  // Origin search (shown when GPS is denied)
  const [originQuery,       setOriginQuery]       = useState('');
  const [originSuggestions, setOriginSuggestions] = useState<Prediction[]>([]);
  const [originOpen,        setOriginOpen]        = useState(false);
  const [originLoading,     setOriginLoading]     = useState(false);
  const originDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tryGeolocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocDenied(true);
      setLocLabel('GPS unavailable — search your start location');
      setLocLoading(false);
      return;
    }
    setLocLoading(true);
    setLocDenied(false);
    setLocLabel('Detecting your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCurrentLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocLabel('Your current location');
        setLocLoading(false);
        setLocDenied(false);
      },
      () => {
        setLocDenied(true);
        setLocLabel('Location denied — search your start point below');
        setLocLoading(false);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);

  useEffect(() => { tryGeolocation(); }, [tryGeolocation]);

  // Autocomplete for manual origin search
  const handleOriginSearch = useCallback((v: string) => {
    setOriginQuery(v);
    if (originDebounceRef.current) clearTimeout(originDebounceRef.current);
    if (v.length < 2) { setOriginSuggestions([]); return; }
    setOriginLoading(true);
    originDebounceRef.current = setTimeout(async () => {
      const res = await autocomplete(v);
      setOriginSuggestions(res);
      setOriginOpen(res.length > 0);
      setOriginLoading(false);
    }, 300);
  }, []);

  const handleSelectOrigin = useCallback((p: Prediction) => {
    setOriginOpen(false);
    const label = p.structured_formatting?.main_text ?? p.description;
    setOriginQuery(label);
    setCurrentLoc({ lat: p.geometry.location.lat, lng: p.geometry.location.lng });
    setLocLabel(label);
    setLocDenied(false);
  }, []);

  const origin = currentLoc ?? MUMBAI_FALLBACK;

  // ── Destination ─────────────────────────────────────────────────────────
  const [query,           setQuery]           = useState('');
  const [suggestions,     setSuggestions]     = useState<Prediction[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [loadingSugg,     setLoadingSugg]     = useState(false);
  const [selectedDest,    setSelectedDest]    = useState<{ lat: number; lng: number; label: string } | null>(null);

  // ── Transport mode ────────────────────────────────────────────────────
  const [selectedMode,    setSelectedMode]    = useState<TransportMode>('driving');
  const [directions,      setDirections]      = useState<DirectionsResult | null>(null);
  const [loadingRoute,    setLoadingRoute]    = useState(false);

  // ── System ───────────────────────────────────────────────────────────
  const [showSettings, setShowSettings]  = useState(false);
  const [settings, setSettings]          = useState({ privacy: false, alertType: 'Voice', dataSharing: true });
  const [systemReady, setSystemReady]    = useState<Record<string, boolean>>({
    cameras: false, gps: false, map: false, hazards: false, network: false, sensors: false,
  });
  const [statusLoading, setStatusLoading] = useState(true);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Live hazards from backend ─────────────────────────────────────────
  const { hazards, loading: hazardsLoading } = useHazards({ pollInterval: 5000 });
  const { start, starting } = useTrip();

  // ── System status ─────────────────────────────────────────────────────
  useEffect(() => {
    fetchSystemStatus()
      .then((s: SystemStatus) =>
        setSystemReady({
          cameras: s.cameras, gps: s.gps, map: s.map,
          hazards: s.hazards_synced, network: s.network, sensors: s.sensors,
        })
      )
      .catch(() =>
        setSystemReady({ cameras: true, gps: true, map: true, hazards: true, network: true, sensors: true })
      )
      .finally(() => setStatusLoading(false));
  }, []);

  // ── Autocomplete ──────────────────────────────────────────────────────
  const handleQueryChange = useCallback((v: string) => {
    setQuery(v);
    setSelectedDest(null);
    setDirections(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.length < 2) { setSuggestions([]); return; }
    setLoadingSugg(true);
    debounceRef.current = setTimeout(async () => {
      const res = await autocomplete(v);
      setSuggestions(res);
      setSuggestionsOpen(res.length > 0);
      setLoadingSugg(false);
    }, 300);
  }, []);

  // ── Place select → initial route (driving) ────────────────────────────
  const handleSelectPlace = useCallback(async (p: Prediction) => {
    setSuggestionsOpen(false);
    setQuery(p.structured_formatting?.main_text ?? p.description);
    const dest = {
      lat:   p.geometry.location.lat,
      lng:   p.geometry.location.lng,
      label: p.structured_formatting?.main_text ?? p.description,
    };
    setSelectedDest(dest);
    setLoadingRoute(true);
    const dir = await getDirections(origin, dest, 'driving');
    setDirections(dir);
    setSelectedMode('driving');
    setLoadingRoute(false);
  }, [origin]);

  // Start location changed after the destination was picked → recompute the route
  useEffect(() => {
    if (!selectedDest || !currentLoc) return;
    let cancelled = false;
    setLoadingRoute(true);
    getDirections(currentLoc, selectedDest, selectedMode).then((dir) => {
      if (!cancelled) { setDirections(dir); setLoadingRoute(false); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLoc]);

  // ── Mode picker callback ──────────────────────────────────────────────
  const handleModeSelect = useCallback((mode: TransportMode, res: DirectionsResult) => {
    setSelectedMode(mode);
    setDirections(res);
  }, []);

  // ── Start drive ───────────────────────────────────────────────────────
  const readyCount = Object.values(systemReady).filter(Boolean).length;
  const totalCount = Object.keys(systemReady).length;
  const allReady   = readyCount === totalCount;

  const handleStartDrive = async () => {
    if (!allReady || starting) return;
    try {
      const sid = await start();
      navigate('/drive', {
        state: { sessionId: sid, destination: selectedDest, directions, mode: selectedMode },
      });
    } catch { navigate('/drive'); }
  };

  const handleStartDemo = async () => {
    if (!directions) return;
    let sid: string | undefined;
    try { sid = await start(); } catch { /* trip log is optional for the demo */ }
    navigate('/drive', {
      state: { sessionId: sid, destination: selectedDest, directions, mode: selectedMode, demo: true },
    });
  };

  // ── Hazards lying on the planned route (server → cached on the car) ──
  const [routeHz, setRouteHz] = useState<{ source: string; hazards: RouteHazard[] } | null>(null);
  const [routeHzLoading, setRouteHzLoading] = useState(false);
  useEffect(() => {
    const coords = directions?.routeCoords;
    if (!coords || coords.length < 2) { setRouteHz(null); return; }
    setRouteHzLoading(true);
    edge.routeHazards(coords)
      .then(setRouteHz)
      .catch(() => setRouteHz(null))
      .finally(() => setRouteHzLoading(false));
  }, [directions]);

  const routeMarkers: HazardMarker[] = (routeHz?.hazards ?? []).map((h) => ({
    id: String(h.id), type: h.hazard_type as HazardMarker['type'], severity: h.severity as HazardMarker['severity'],
    latitude: h.latitude, longitude: h.longitude, reports: h.count, confidence: h.confidence,
    first_seen: h.first_seen, last_seen: h.last_seen,
    label: `${fmtAlong(h.distance_along_m)} along route${h.verified ? ' · verified ✓' : ''}`,
  }));

  // ── Map markers ───────────────────────────────────────────────────────
  const mapHazards: HazardMarker[] = routeHz ? routeMarkers : hazards.map((h) => ({
    id:         String(h.id),
    type:       h.hazard_type as HazardMarker['type'],
    severity:   h.severity    as HazardMarker['severity'],
    latitude:   h.latitude,
    longitude:  h.longitude,
    reports:    h.count,
    confidence: h.confidence,
    first_seen: h.first_seen,
    last_seen:  h.last_seen,
    label:      h.verified ? 'Verified ✓' : undefined,
  }));

  return (
    <div className="w-full h-screen bg-background flex flex-col md:flex-row">

      {/* ── Left panel ────────────────────────────────────────────────── */}
      <div className="w-full md:w-[360px] h-auto md:h-full bg-white border-b md:border-b-0 md:border-r border-border flex flex-col p-5 overflow-y-auto flex-shrink-0">

        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 bg-[#001E50] rounded-xl flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-bold">VW</span>
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Trip Setup</h1>
            <p className="text-xs text-muted-foreground">AI hazard detection</p>
          </div>
        </div>

        {/* Current location — GPS detected */}
        {!locDenied && (
          <div className={`mb-4 flex items-center gap-2.5 rounded-xl px-3 py-2.5 border ${
            locLoading ? 'bg-gray-50 border-gray-200' : 'bg-green-50 border-green-200'
          }`}>
            {locLoading
              ? <Loader2 className="w-4 h-4 text-gray-400 animate-spin flex-shrink-0" />
              : <LocateFixed className="w-4 h-4 text-green-600 flex-shrink-0" />
            }
            <div className="min-w-0 flex-1">
              <div className={`text-xs font-semibold ${locLoading ? 'text-gray-500' : 'text-green-800'}`}>FROM</div>
              <div className={`text-sm truncate ${locLoading ? 'text-gray-400' : 'text-green-700'}`}>{locLabel}</div>
            </div>
            {!locLoading && (
              <button onClick={tryGeolocation} title="Re-detect location"
                className="p-1 rounded-lg hover:bg-green-100 transition-colors flex-shrink-0">
                <LocateFixed className="w-3.5 h-3.5 text-green-600" />
              </button>
            )}
            <button onClick={() => setLocDenied(true)}
              className="text-xs text-[#001E50] hover:underline flex-shrink-0">Change</button>
          </div>
        )}

        {/* Manual origin search — shown when GPS is denied */}
        {locDenied && (
          <div className="mb-4 relative">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium">From (start location)</label>
              <button onClick={tryGeolocation}
                className="flex items-center gap-1 text-xs text-[#001E50] hover:underline">
                <LocateFixed className="w-3 h-3" />Use GPS
              </button>
            </div>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              {originLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />}
              <input
                type="text"
                value={originQuery}
                onChange={(e) => handleOriginSearch(e.target.value)}
                onFocus={() => originSuggestions.length > 0 && setOriginOpen(true)}
                onBlur={() => setTimeout(() => setOriginOpen(false), 180)}
                placeholder="Search your starting point…"
                className="w-full pl-9 pr-9 py-2.5 bg-gray-50 rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-[#001E50]/20 text-sm"
              />
            </div>
            {originOpen && originSuggestions.length > 0 && (
              <div className="absolute z-50 mt-1 w-full bg-white border border-border rounded-xl shadow-xl overflow-hidden">
                {originSuggestions.slice(0, 5).map((s) => (
                  <button key={s.place_id} type="button"
                    className="w-full px-4 py-3 flex items-start gap-3 hover:bg-gray-50 transition-colors text-left border-b border-border/50 last:border-b-0"
                    onMouseDown={() => handleSelectOrigin(s)}
                  >
                    <MapPin className="w-4 h-4 text-[#001E50] mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.structured_formatting?.main_text ?? s.description}</div>
                      {s.structured_formatting?.secondary_text && (
                        <div className="text-xs text-muted-foreground truncate">{s.structured_formatting.secondary_text}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {currentLoc && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-green-700">
                <CheckCircle2 className="w-3.5 h-3.5" />{locLabel}
              </div>
            )}
          </div>
        )}

        {/* Destination search */}
        <div className="mb-5 relative">
          <label className="block mb-1.5 text-sm font-medium">Destination</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            {loadingSugg && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />}
            <input
              type="text" value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onFocus={() => suggestions.length > 0 && setSuggestionsOpen(true)}
              onBlur={() => setTimeout(() => setSuggestionsOpen(false), 180)}
              placeholder="Where are we going?"
              className="w-full pl-9 pr-9 py-2.5 bg-gray-50 rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-[#001E50]/20 text-sm"
            />
          </div>

          {suggestionsOpen && (
            <div className="absolute z-50 mt-1 w-full bg-white border border-border rounded-xl shadow-xl overflow-hidden">
              {suggestions.slice(0, 5).map((s) => (
                <button key={s.place_id} type="button"
                  className="w-full px-4 py-3 flex items-start gap-3 hover:bg-gray-50 transition-colors text-left border-b border-border/50 last:border-b-0"
                  onMouseDown={() => handleSelectPlace(s)}
                >
                  <MapPin className="w-4 h-4 text-[#001E50] mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{s.structured_formatting?.main_text ?? s.description}</div>
                    {s.structured_formatting?.secondary_text && (
                      <div className="text-xs text-muted-foreground truncate">{s.structured_formatting.secondary_text}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Transport mode picker — only after destination selected */}
        {selectedDest && (
          <div className="mb-5">
            <label className="block mb-2 text-sm font-medium">Transport Mode</label>
            <TransportModePicker
              origin={origin}
              destination={selectedDest}
              selected={selectedMode}
              onSelect={handleModeSelect}
            />
          </div>
        )}

        {/* Route summary */}
        <div className="mb-5 bg-card rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold">Route Summary</span>
            {loadingRoute
              ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              : <Navigation className="w-4 h-4 text-[#001E50]" />
            }
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-[#001E50]/5 rounded-lg p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Route className="w-3 h-3 text-[#001E50]" />
                <span className="text-xs text-muted-foreground">Distance</span>
              </div>
              <div className="text-xl font-bold text-[#001E50]">
                {loadingRoute ? '…' : directions?.distanceText ?? '—'}
              </div>
            </div>
            <div className="bg-[#001E50]/5 rounded-lg p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Clock className="w-3 h-3 text-[#001E50]" />
                <span className="text-xs text-muted-foreground">ETA</span>
              </div>
              <div className="text-xl font-bold text-[#001E50]">
                {loadingRoute ? '…' : directions?.durationText ?? '—'}
              </div>
            </div>
          </div>

          {/* Hazards on route */}
          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground">HAZARDS ON ROUTE</span>
              {(hazardsLoading || routeHzLoading) && <Loader2 className="w-3 h-3 animate-spin" />}
              {routeHz && !routeHzLoading && (
                <span className="text-[10px] text-muted-foreground">
                  {routeHz.source === 'server' ? 'downloaded from server · cached on car' : 'offline — from car cache'}
                </span>
              )}
            </div>
            {!directions ? (
              <p className="text-xs text-muted-foreground py-1">Pick a destination to download hazards along the route</p>
            ) : routeMarkers.length === 0 && !routeHzLoading ? (
              <p className="text-xs text-muted-foreground py-1">No known hazards on this route</p>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {routeMarkers.map((h, i) => (
                  <div key={h.id} className="flex items-center gap-2.5 p-2.5 bg-background rounded-lg">
                    <div className={`p-1.5 rounded-lg flex-shrink-0 ${
                      h.severity === 'high' ? 'bg-red-100' : h.severity === 'medium' ? 'bg-orange-100' : 'bg-yellow-100'
                    }`}>
                      <HazardIcon
                        type={h.type === 'pothole' || h.type === 'flood' ? h.type : 'debris'}
                        className={`w-3.5 h-3.5 ${
                          h.severity === 'high' ? 'text-red-600' : h.severity === 'medium' ? 'text-orange-600' : 'text-yellow-600'
                        }`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium">{HAZARD_LABELS[h.type] ?? h.type}</span>
                        <SeverityBadge severity={h.severity} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {fmtAlong(routeHz?.hazards[i]?.distance_along_m)} along route
                        {h.reports ? ` · ${h.reports} report${h.reports !== 1 ? 's' : ''}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* System readiness */}
        <div className="mb-5 bg-card rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold">System Readiness</span>
            {statusLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          </div>
          <div className="space-y-2 mb-3">
            {[
              { key: 'cameras', label: 'Cameras connected' },
              { key: 'gps',     label: 'GPS locked' },
              { key: 'map',     label: 'Map downloaded' },
              { key: 'hazards', label: 'Hazards synced' },
              { key: 'network', label: 'Network connected' },
              { key: 'sensors', label: 'Sensors calibrated' },
            ].map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2.5">
                {systemReady[key] ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                ) : statusLoading ? (
                  <Loader2 className="w-4 h-4 text-muted-foreground animate-spin flex-shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                )}
                <span className={`text-xs ${systemReady[key] ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
              </div>
            ))}
          </div>
          <div className="pt-3 border-t border-border">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-muted-foreground">Status</span>
              <span className="text-xs font-medium">{readyCount}/{totalCount}</span>
            </div>
            <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-green-500 transition-all duration-500 rounded-full"
                   style={{ width: `${(readyCount / totalCount) * 100}%` }} />
            </div>
          </div>
        </div>

        {/* Start */}
        <button onClick={handleStartDrive} disabled={!allReady || starting}
          className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all ${
            allReady && !starting
              ? 'bg-[#001E50] text-white hover:bg-[#001E50]/90 shadow-lg'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          {starting ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />Starting…
            </span>
          ) : allReady ? 'Start Navigation' : 'Preparing System…'}
        </button>

        {/* Demo: simulated drive along this route with a pre-mapped hazard */}
        <button onClick={handleStartDemo} disabled={!directions || starting}
          title={directions ? 'Car drives itself along the route; a pre-mapped hazard is detected and shared over Bluetooth' : 'Pick a destination first'}
          className={`w-full mt-2 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 ${
            directions ? 'bg-orange-500 text-white hover:bg-orange-600 shadow' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}>
          <Play className="w-4 h-4" />Demo drive (simulated road)
        </button>

        {/* Test Dashcam */}
        <button
          onClick={() => navigate('/pipeline')}
          className="w-full mt-2 py-3 rounded-xl border-2 border-[#001E50] text-[#001E50] text-sm font-semibold hover:bg-[#001E50]/5 transition-colors flex items-center justify-center gap-2"
        >
          <Video className="w-4 h-4" />
          Test Dashcam Pipeline
        </button>
      </div>

      {/* ── Map panel ─────────────────────────────────────────────────── */}
      <div className="flex-1 h-64 md:h-full relative">
        <OlaMap
          center={[origin.lng, origin.lat]}
          zoom={13}
          hazards={mapHazards}
          routeCoords={directions?.routeCoords}
          destination={selectedDest ?? undefined}
          userPosition={currentLoc ? [currentLoc.lng, currentLoc.lat] : undefined}
          className="h-full rounded-none"
        />

        {!hazardsLoading && hazards.length > 0 && (
          <div className="absolute top-4 left-4 bg-white/95 backdrop-blur-sm rounded-xl shadow border border-border px-3 py-2 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-medium">
              <span className="text-red-600 font-bold">{hazards.length}</span> active hazards
            </span>
          </div>
        )}

        <button onClick={() => setShowSettings(true)}
          className="absolute top-4 right-4 p-2.5 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-border">
          <Settings className="w-4 h-4" />
        </button>

        {/* Settings modal */}
        {showSettings && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center p-8 z-50"
               onClick={() => setShowSettings(false)}>
            <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold">Settings</h2>
                <button onClick={() => setShowSettings(false)} className="text-muted-foreground hover:text-foreground text-xl">✕</button>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between py-3 border-b border-border">
                  <div><div className="text-sm font-medium">Privacy mode</div><div className="text-xs text-muted-foreground">Blur faces &amp; plates before upload</div></div>
                  <label className="relative inline-block w-11 h-6 flex-shrink-0">
                    <input type="checkbox" className="sr-only peer" checked={settings.privacy}
                      onChange={(e) => setSettings((s) => ({ ...s, privacy: e.target.checked }))} />
                    <div className="w-11 h-6 bg-gray-300 rounded-full peer peer-checked:bg-[#001E50] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
                  </label>
                </div>
                <div className="py-3 border-b border-border">
                  <div className="text-sm font-medium mb-2">Alert type</div>
                  <div className="grid grid-cols-3 gap-2">
                    {['Voice', 'Sound', 'Visual'].map((t) => (
                      <button key={t} onClick={() => setSettings((s) => ({ ...s, alertType: t }))}
                        className={`py-2 rounded-lg text-sm transition-all ${settings.alertType === t ? 'bg-[#001E50] text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>{t}</button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between py-3">
                  <div><div className="text-sm font-medium">Data sharing</div><div className="text-xs text-muted-foreground">Contribute to community hazard map</div></div>
                  <label className="relative inline-block w-11 h-6 flex-shrink-0">
                    <input type="checkbox" className="sr-only peer" checked={settings.dataSharing}
                      onChange={(e) => setSettings((s) => ({ ...s, dataSharing: e.target.checked }))} />
                    <div className="w-11 h-6 bg-gray-300 rounded-full peer peer-checked:bg-[#001E50] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
                  </label>
                </div>
              </div>
              <button onClick={() => setShowSettings(false)}
                className="w-full mt-5 py-3 bg-[#001E50] text-white rounded-xl hover:bg-[#001E50]/90 text-sm font-semibold">
                Save Settings
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
