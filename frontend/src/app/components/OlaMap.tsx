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
  type: 'pothole' | 'flood' | 'debris' | 'bump' | 'stalled_vehicle';
  severity: 'low' | 'medium' | 'high';
  latitude: number;
  longitude: number;
  label?: string;
  reports?: number;
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
  pothole: '🕳️', flood: '🌊', debris: '⚠️', bump: '🔺', stalled_vehicle: '🚗',
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
      const el = document.createElement('div');
      const bg = SEV[h.severity] ?? '#f97316';
      el.style.cssText = `
        width:30px;height:30px;border-radius:50%;
        background:${bg};border:2.5px solid #fff;
        box-shadow:0 2px 10px rgba(0,0,0,.35);
        display:flex;align-items:center;justify-content:center;
        font-size:13px;cursor:pointer;
        transition:transform .15s ease;
      `;
      el.textContent = ICON[h.type] ?? '⚠️';
      el.onmouseenter = () => { el.style.transform = 'scale(1.3)'; };
      el.onmouseleave = () => { el.style.transform = ''; };

      const popup = new maplibregl.Popup({
        offset: 18, closeButton: false, maxWidth: '200px', className: 'ola-pop',
      }).setHTML(`
        <div style="font:13px/1.6 system-ui,sans-serif">
          <b style="text-transform:capitalize">${h.type.replace('_', ' ')}</b><br>
          <span style="color:${bg};font-size:11px">${h.severity} severity</span>
          ${h.reports ? `<br><span style="color:#888;font-size:11px">${h.reports} report${h.reports !== 1 ? 's' : ''}</span>` : ''}
          ${h.label ? `<br><span style="font-size:11px">${h.label}</span>` : ''}
        </div>
      `);

      markersRef.current.push(
        new maplibregl.Marker({ element: el })
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
