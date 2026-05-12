import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { OlaMap, type HazardMarker } from './OlaMap';
import type { NavigationStep, TransportMode } from '../../api/olamaps';

// ── Haversine distance (metres) ────────────────────────────────────────────
function hav(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
    + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtETA(remainingS: number): string {
  const d = new Date();
  d.setSeconds(d.getSeconds() + remainingS);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Maneuver → arrow character
const ARROW: Record<string, string> = {
  depart:             '↑', arrive:            '📍',
  straight:           '↑', 'continue':        '↑',
  'turn-left':        '←', 'turn-right':       '→',
  'turn-slight-left': '↖', 'turn-slight-right':'↗',
  'turn-sharp-left':  '↩', 'turn-sharp-right': '↪',
  'keep-left':        '↖', 'keep-right':       '↗',
  'u-turn':           '↩', 'u-turn-left':      '↩',  'u-turn-right': '↪',
  'roundabout':       '⟳', 'roundabout-left':  '⟲',  'roundabout-right': '⟳',
  merge:              '↑', 'fork-left':        '↖',  'fork-right': '↗',
  'ramp-left':        '↖', 'ramp-right':       '↗',
};

const SEV_BG: Record<string, string> = {
  high: '#dc2626', medium: '#ea580c', low: '#ca8a04',
};

const MODE_ICON: Record<TransportMode, string> = {
  driving: '🚗', bike: '🏍️', walking: '🚶', transit: '🚌',
};

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  steps:       NavigationStep[];
  routeCoords: [number, number][];
  userLngLat:  [number, number] | null;
  hazards:     HazardMarker[];
  speedKmh:    number;
  mode:        TransportMode;
  destination?: { lat: number; lng: number; label?: string };
  alertText?:  string;
  alertSev?:   'high' | 'medium' | 'low';
  onDismissAlert?: () => void;
  onEndTrip:   () => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function NavigationView({
  steps, routeCoords, userLngLat, hazards, speedKmh, mode,
  destination, alertText, alertSev = 'high', onDismissAlert, onEndTrip,
}: Props) {
  const [stepIdx,      setStepIdx]      = useState(0);
  const [distToTurn,   setDistToTurn]   = useState(0);
  const [remainingM,   setRemainingM]   = useState(() =>
    steps.reduce((s, st) => s + st.distanceM, 0)
  );
  const [remainingS,   setRemainingS]   = useState(() =>
    steps.reduce((s, st) => s + st.durationS, 0)
  );

  const prevUserRef = useRef<[number, number] | null>(null);

  // ── Step tracking: update every time user position changes ───────────────
  useEffect(() => {
    if (!userLngLat || steps.length === 0) return;

    const step = steps[stepIdx];
    if (!step) return;

    const d = hav(userLngLat[1], userLngLat[0], step.endLat, step.endLng);
    setDistToTurn(Math.round(d));

    // Remaining distance = dist to end of this step + all future steps
    const futureM = steps.slice(stepIdx + 1).reduce((s, st) => s + st.distanceM, 0);
    setRemainingM(Math.round(d + futureM));

    // Remaining time: remaining distance ÷ current speed (or use step durations)
    const futureS = steps.slice(stepIdx + 1).reduce((s, st) => s + st.durationS, 0);
    const thisStepS = step.durationS * (d / Math.max(step.distanceM, 1));
    setRemainingS(Math.round(thisStepS + futureS));

    // Auto-advance step when within 30 m of its endpoint
    if (d < 30 && stepIdx < steps.length - 1) {
      setStepIdx((prev) => prev + 1);
    }

    prevUserRef.current = userLngLat;
  }, [userLngLat, stepIdx, steps]);

  const curStep  = steps[stepIdx];
  const nextStep = steps[stepIdx + 1];
  const arrow    = ARROW[curStep?.maneuver ?? ''] ?? '↑';
  const isLast   = stepIdx >= steps.length - 1;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh',
                  background: '#111', color: '#fff', fontFamily: 'system-ui,sans-serif' }}>

      {/* ── Top: turn-by-turn instruction ─────────────────────────────── */}
      <div style={{
        background: isLast ? '#16a34a' : '#001E50',
        padding: '16px 20px 12px',
        flexShrink: 0,
        boxShadow: '0 2px 12px rgba(0,0,0,.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Arrow */}
          <div style={{
            fontSize: 44, lineHeight: 1, minWidth: 52,
            textAlign: 'center', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.4))',
          }}>
            {isLast ? '📍' : arrow}
          </div>

          {/* Main instruction */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}>
              {curStep?.instruction ?? (isLast ? 'You have arrived' : 'Follow the route')}
            </div>
            {!isLast && (
              <div style={{ fontSize: 28, fontWeight: 800, marginTop: 2, letterSpacing: '-0.5px' }}>
                {fmtDist(distToTurn)}
              </div>
            )}
          </div>

          {/* Mode icon */}
          <div style={{ fontSize: 22, opacity: 0.7 }}>{MODE_ICON[mode]}</div>
        </div>

        {/* Next step preview */}
        {nextStep && !isLast && (
          <div style={{
            marginTop: 10, paddingTop: 10,
            borderTop: '1px solid rgba(255,255,255,.15)',
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 13, opacity: 0.75,
          }}>
            <ChevronRight size={14} />
            <span>Then: {nextStep.instruction}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
              {fmtDist(nextStep.distanceM)}
            </span>
          </div>
        )}
      </div>

      {/* ── Hazard alert banner ────────────────────────────────────────── */}
      {alertText && (
        <div style={{
          background: SEV_BG[alertSev] ?? '#dc2626',
          padding: '10px 20px',
          display: 'flex', alignItems: 'center', gap: 10,
          flexShrink: 0, zIndex: 20,
        }}>
          <AlertTriangle size={20} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{alertText}</span>
          {onDismissAlert && (
            <button onClick={onDismissAlert}
              style={{ background: 'none', border: 'none', color: '#fff',
                       fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>✕</button>
          )}
        </div>
      )}

      {/* ── Map ───────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <OlaMap
          center={userLngLat ?? [72.8777, 19.076]}
          zoom={17}
          hazards={hazards}
          routeCoords={routeCoords}
          userPosition={userLngLat ?? undefined}
          destination={destination}
          darkMode={true}
          className="rounded-none"
        />
      </div>

      {/* ── Bottom bar ────────────────────────────────────────────────── */}
      <div style={{
        background: '#1a1a1a',
        borderTop: '1px solid rgba(255,255,255,.1)',
        padding: '12px 20px',
        display: 'flex', alignItems: 'center',
        flexShrink: 0, gap: 0,
      }}>
        {/* Speed */}
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(speedKmh)}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>km/h</div>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 40, background: 'rgba(255,255,255,.15)' }} />

        {/* Remaining distance */}
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#60a5fa' }}>
            {fmtDist(remainingM)}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>remaining</div>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 40, background: 'rgba(255,255,255,.15)' }} />

        {/* ETA */}
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtETA(remainingS)}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>ETA</div>
        </div>

        {/* End button */}
        <button
          onClick={onEndTrip}
          style={{
            marginLeft: 12, padding: '10px 18px', background: '#dc2626',
            border: 'none', borderRadius: 12, color: '#fff',
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}
        >
          End
        </button>
      </div>
    </div>
  );
}
