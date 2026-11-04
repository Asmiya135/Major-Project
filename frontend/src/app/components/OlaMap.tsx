import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const OLA_KEY = import.meta.env.VITE_OLA_MAPS_KEY as string;

const STYLE_LIGHT = 'https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json';
const STYLE_DARK  = 'https://api.olamaps.io/tiles/vector/v1/styles/default-dark-standard/style.json';

/**
 * Inject api_key into EVERY request MapLibre makes to api.olamaps.io.
 * This covers: style JSON, tile sources (planet.json), individual tiles,
 * sprites, and glyph/font files — all of which need authentication.
 */
function olaTx(url: string): maplibregl.RequestParameters {
  if (url.includes('api.olamaps.io')) {
    const sep = url.includes('?') ? '&' : '?';
    return { url: `${url}${sep}api_key=${OLA_KEY}` };
  }
  return { url };
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface HazardMarker {
  id: string;
  type: 'pothole' | 'flood' | 'debris' | 'bump' | 'speed_bump' | 'stalled_vehicle';
  severity: 'low' | 'medium' | 'high';
  latitude: number;
  longitude: number;
  label?: string;
  reports?: number;
  confidence?: number;
  first_seen?: string;
  last_seen?: string;
}

interface OlaMapProps {
  center?: [number, number];   // [lng, lat] for MapLibre
  zoom?: number;
  hazards?: HazardMarker[];
  routeCoords?: [number, number][];
  userPosition?: [number, number];
  destination?: { lat: number; lng: number; label?: string };
  darkMode?: boolean;
  className?: string;
}

const SEV: Record<string, string> = { high: '#ef4444', medium: '#f97316', low: '#eab308' };
const ICON: Record<string, string> = {
  pothole: '🕳️', flood: '🌊', debris: '⚠️', bump: '🔺', speed_bump: '🔺', stalled_vehicle: '🚗',
};

// ── Component ──────────────────────────────────────────────────────────────

export function OlaMap({
  center = [72.8777, 19.076],
  zoom = 13,
  hazards = [],
  routeCoords,
  userPosition,
  destination,
  darkMode = false,
  className = '',
}: OlaMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const markersRef   = useRef<maplibregl.Marker[]>([]);
  const userPin      = useRef<maplibregl.Marker | null>(null);
  const destPin      = useRef<maplibregl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  // ── Init (re-runs only when darkMode flips) ───────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let alive = true;      // guards against stale async callbacks (React StrictMode)
    setReady(false);
    setError('');

    const map = new maplibregl.Map({
      container,
      style: darkMode ? STYLE_DARK : STYLE_LIGHT,
      center,
      zoom,
      attributionControl: false,
      transformRequest: olaTx,   // ← adds api_key to ALL olamaps requests
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

    map.on('load', () => {
      if (!alive) return;

      map.addSource('route', { type: 'geojson', data: emptyLine() });
      map.addLayer({
        id: 'route-casing', type: 'line', source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': 0.45 },
      });
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': darkMode ? '#60a5fa' : '#001E50',
          'line-width': 4,
          'line-opacity': 0.9,
        },
      });

      mapRef.current = map;
      setReady(true);
    });

    // Only treat 401/403 as a hard error — tile 4xx like bad glyph ranges are non-fatal
    map.on('error', (e) => {
      if (!alive) return;
      const status = (e as unknown as { status?: number }).status
        ?? (e.error as unknown as { status?: number } | undefined)?.status;
      if (status === 401 || status === 403) {
        setError('API key rejected. Check VITE_OLA_MAPS_KEY.');
      }
      console.warn('[OlaMap]', e.error?.message ?? e);
    });

    return () => {
      alive = false;
      setReady(false);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      userPin.current?.remove();  userPin.current = null;
      destPin.current?.remove();  destPin.current = null;
      mapRef.current = null;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [darkMode]);

  // ── Route ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: routeCoords ?? [] },
    });
    if (routeCoords && routeCoords.length > 1) {
      const bounds = routeCoords.reduce(
        (b, c) => b.extend(c as [number, number]),
        new maplibregl.LngLatBounds(routeCoords[0] as [number, number], routeCoords[0] as [number, number]),
      );
      map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 900 });
    }
  }, [routeCoords, ready]);

  // ── Hazard markers ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    hazards.forEach((h) => {
      const bg = SEV[h.severity] ?? '#f97316';

      // Outer wrapper — fixed size, never transforms, acts as anchor
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `
        width:34px;height:34px;
        position:relative;cursor:pointer;
      `;

      // Inner visible circle — only this scales on hover
      const circle = document.createElement('div');
      circle.style.cssText = `
        width:34px;height:34px;border-radius:50%;
        background:${bg};border:2.5px solid #fff;
        box-shadow:0 2px 10px rgba(0,0,0,.4);
        display:flex;align-items:center;justify-content:center;
        font-size:14px;
        transition:transform .15s ease, box-shadow .15s ease;
        pointer-events:none;
      `;
      circle.textContent = ICON[h.type] ?? '⚠️';
      wrapper.appendChild(circle);

      // Hover: scale only the inner circle, wrapper stays fixed
      wrapper.onmouseenter = () => {
        circle.style.transform = 'scale(1.25)';
        circle.style.boxShadow = `0 4px 16px rgba(0,0,0,.5)`;
      };
      wrapper.onmouseleave = () => {
        circle.style.transform = '';
        circle.style.boxShadow = `0 2px 10px rgba(0,0,0,.4)`;
      };

      // Confidence bar width
      const conf = typeof h.confidence === 'number' ? h.confidence : 0.75;
      const confPct = Math.round(conf * 100);
      const confColor = confPct >= 75 ? '#ef4444' : confPct >= 40 ? '#f97316' : '#eab308';

      // Severity pill colours
      const sevBgMap: Record<string, string> = { high: '#fee2e2', medium: '#ffedd5', low: '#fef9c3' };
      const sevTxtMap: Record<string, string> = { high: '#b91c1c', medium: '#c2410c', low: '#854d0e' };
      const sevBg  = sevBgMap[h.severity]  ?? '#f1f5f9';
      const sevTxt = sevTxtMap[h.severity] ?? '#475569';

      // Format ISO UTC timestamp → local readable
      const fmt = (iso?: string) => {
        if (!iso) return '—';
        try {
          const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
          return d.toLocaleString(undefined, {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
          });
        } catch { return iso; }
      };

      const firstSeen = fmt(h.first_seen);
      const lastSeen  = fmt(h.last_seen);
      const isNew     = h.first_seen === h.last_seen || !h.last_seen;

      // Rich analytics popup — click to open, fixed to coordinate
      const popup = new maplibregl.Popup({
        offset: [0, -20],
        closeButton: true,
        closeOnClick: false,
        maxWidth: '260px',
        className: 'ola-pop',
        anchor: 'bottom',
      }).setHTML(`
        <div style="font:13px/1.6 system-ui,sans-serif;padding:2px 0">

          <!-- Header: icon + name + severity pill -->
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <div style="width:32px;height:32px;border-radius:50%;background:${bg};
                        display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">
              ${ICON[h.type] ?? '⚠️'}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:14px;text-transform:capitalize;line-height:1.2">
                ${h.type.replace(/_/g, ' ')}
              </div>
              <span style="display:inline-block;margin-top:2px;padding:1px 8px;border-radius:20px;
                           font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
                           background:${sevBg};color:${sevTxt}">
                ${h.severity} severity
              </span>
            </div>
          </div>

          <!-- Confidence bar -->
          <div style="background:#f8fafc;border-radius:8px;padding:8px 10px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:4px">
              <span>Confidence</span>
              <span style="font-weight:700;color:#1e293b">${confPct}%</span>
            </div>
            <div style="height:5px;background:#e2e8f0;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${confPct}%;background:${confColor};border-radius:3px"></div>
            </div>

            ${h.reports != null ? `
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-top:5px">
              <span>Reports</span><span style="font-weight:700;color:#1e293b">${h.reports}</span>
            </div>` : ''}
          </div>

          <!-- Timestamps -->
          <div style="background:#f8fafc;border-radius:8px;padding:8px 10px;margin-bottom:8px">
            <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:${isNew ? '0' : '5px'}">
              <span style="font-size:12px;flex-shrink:0">🕐</span>
              <div style="flex:1">
                <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.4px">
                  First detected
                </div>
                <div style="font-size:11px;color:#1e293b;font-weight:600">${firstSeen}</div>
              </div>
            </div>
            ${!isNew ? `
            <div style="display:flex;align-items:flex-start;gap:6px;margin-top:4px">
              <span style="font-size:12px;flex-shrink:0">🔄</span>
              <div style="flex:1">
                <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.4px">
                  Last updated
                </div>
                <div style="font-size:11px;color:#1e293b;font-weight:600">${lastSeen}</div>
              </div>
            </div>` : ''}
          </div>

          ${h.label ? `
          <div style="font-size:11px;color:#64748b;margin-bottom:6px">${h.label}</div>` : ''}

          <!-- Coordinates -->
          <div style="font-size:10px;color:#94a3b8">
            <span style="background:#f1f5f9;padding:2px 7px;border-radius:4px">
              ${h.latitude.toFixed(5)}, ${h.longitude.toFixed(5)}
            </span>
          </div>
        </div>
      `);

      markersRef.current.push(
        new maplibregl.Marker({ element: wrapper, anchor: 'center' })
          .setLngLat([h.longitude, h.latitude])
          .setPopup(popup)
          .addTo(map),
      );
    });
  }, [hazards, ready]);

  // ── User position ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    userPin.current?.remove();
    userPin.current = null;
    if (!userPosition) return;

    const el = document.createElement('div');
    el.innerHTML = `
      <div style="position:relative;width:22px;height:22px">
        <div class="ola-ripple" style="position:absolute;inset:0;border-radius:50%;background:rgba(59,130,246,.35)"></div>
        <div style="position:absolute;inset:4px;border-radius:50%;background:#3b82f6;border:2.5px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45)"></div>
      </div>`;
    userPin.current = new maplibregl.Marker({ element: el })
      .setLngLat(userPosition)
      .addTo(map);
    map.easeTo({ center: userPosition, duration: 600 });
  }, [userPosition, ready]);

  // ── Destination pin ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    destPin.current?.remove();
    destPin.current = null;
    if (!destination) return;

    const el = document.createElement('div');
    el.style.cssText = 'font-size:30px;line-height:1;cursor:default;user-select:none';
    el.textContent = '📍';
    destPin.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([destination.lng, destination.lat])
      .setPopup(new maplibregl.Popup({ offset: 8, closeButton: false }).setText(destination.label ?? 'Destination'))
      .addTo(map);
  }, [destination, ready]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @keyframes ola-ripple{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(2.4);opacity:0}}
        .ola-ripple{animation:ola-ripple 1.8s ease-in-out infinite}
        @keyframes ola-spin{to{transform:rotate(360deg)}}
        .ola-pop .maplibregl-popup-content{padding:8px 12px!important;border-radius:10px!important;box-shadow:0 4px 16px rgba(0,0,0,.18)!important}
        .maplibregl-ctrl-bottom-right{margin:0 8px 8px 0!important}
        .maplibregl-ctrl-attrib{font-size:10px!important}
      `}</style>

      {/* Wrapper: explicit inset-0 on the map div so height never collapses */}
      <div style={{ position: 'relative', width: '100%', height: '100%' }} className={className}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Loading spinner */}
        {!ready && !error && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: darkMode ? '#1a1a2e' : '#f1f5f9', zIndex: 10,
          }}>
            <div style={{
              width: 36, height: 36,
              border: '3px solid #001E50', borderTopColor: 'transparent',
              borderRadius: '50%', animation: 'ola-spin .7s linear infinite',
              marginBottom: 10,
            }} />
            <span style={{ fontSize: 12, color: '#64748b' }}>Loading map…</span>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: darkMode ? '#1a1a2e' : '#f8fafc', zIndex: 10, gap: 8,
          }}>
            <div style={{ fontSize: 36 }}>🗺️</div>
            <div style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>Map unavailable</div>
            <div style={{ fontSize: 11, color: '#94a3b8', maxWidth: 220, textAlign: 'center' }}>{error}</div>
          </div>
        )}
      </div>
    </>
  );
}

function emptyLine(): GeoJSON.Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
}
