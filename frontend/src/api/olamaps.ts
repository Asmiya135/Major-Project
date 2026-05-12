/**
 * Ola Maps REST API — Autocomplete + Directions (with turn-by-turn steps).
 * Auth: api_key query param (verified from ola-maps SDK source).
 */

const OLA_KEY = import.meta.env.VITE_OLA_MAPS_KEY;
const BASE    = 'https://api.olamaps.io';

async function olaGet(path: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}api_key=${OLA_KEY}`, {
    headers: { 'X-Request-Id': crypto.randomUUID() },
  });
  if (!res.ok) throw new Error(`Ola ${res.status}: ${path}`);
  return res.json();
}

async function olaPost(path: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}api_key=${OLA_KEY}`, {
    method: 'POST',
    headers: { 'X-Request-Id': crypto.randomUUID(), 'Content-Length': '0' },
  });
  if (!res.ok) throw new Error(`Ola ${res.status}: ${path}`);
  return res.json();
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface Prediction {
  place_id: string;
  description: string;
  geometry: { location: { lat: number; lng: number } };
  structured_formatting: { main_text: string; secondary_text: string };
}

export interface NavigationStep {
  instruction: string;   // plain text, e.g. "Turn left onto MG Road"
  maneuver:    string;   // e.g. "turn-left", "depart", "straight"
  distanceM:   number;   // metres
  distanceText: string;  // e.g. "362 m"
  durationS:   number;   // seconds
  startLat: number; startLng: number;
  endLat:   number; endLng:   number;
}

export type TransportMode = 'driving' | 'walking' | 'bike' | 'transit';

export interface DirectionsResult {
  mode:         TransportMode;
  routeCoords:  [number, number][];  // [lng,lat] for MapLibre
  steps:        NavigationStep[];
  distanceText: string;   // "11.63 km"
  durationText: string;   // "29 min"
  distanceM:    number;
  durationS:    number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDuration(raw: string, seconds?: number): string {
  if (seconds !== undefined) {
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h} hr ${rem} min` : `${h} hr`;
  }
  const h = parseInt(raw.match(/(\d+)\s+hour/)?.[1]  ?? '0', 10);
  const m = parseInt(raw.match(/(\d+)\s+min/)?.[1]   ?? '0', 10);
  if (h === 0) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function fmtDistance(m: number): string {
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

// ── Autocomplete ───────────────────────────────────────────────────────────

export async function autocomplete(input: string): Promise<Prediction[]> {
  if (!input.trim() || input.length < 2) return [];
  try {
    const d = await olaGet(`/places/v1/autocomplete?input=${encodeURIComponent(input)}`) as { predictions?: Prediction[] };
    return d.predictions ?? [];
  } catch (e) { console.warn('[Ola] autocomplete:', e); return []; }
}

// ── Directions (with steps) ────────────────────────────────────────────────

interface RawLeg {
  distance: number;
  readable_distance: string;
  readable_duration: string;
  duration: number;
  steps?: Array<{
    instructions: string;
    maneuver: string;
    distance: number;
    readable_distance: string;
    duration: number;
    start_location: { lat: number; lng: number };
    end_location:   { lat: number; lng: number };
  }>;
}

interface RawRoute { overview_polyline: string; legs: RawLeg[]; }

async function fetchDriving(
  origin: { lat: number; lng: number },
  dest:   { lat: number; lng: number },
): Promise<{ routes: RawRoute[] } | null> {
  try {
    return await olaPost(
      `/routing/v1/directions?origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&mode=driving`
    ) as { routes: RawRoute[] };
  } catch (e) { console.warn('[Ola] directions:', e); return null; }
}

export async function getDirections(
  origin: { lat: number; lng: number },
  dest:   { lat: number; lng: number },
  mode:   TransportMode = 'driving',
): Promise<DirectionsResult | null> {
  const data = await fetchDriving(origin, dest);
  if (!data) return null;
  const route = data.routes?.[0];
  if (!route) return null;
  const leg = route.legs?.[0];

  const distM  = leg?.distance ?? 0;
  const durS   = leg?.duration ?? 0;
  const rawDur = leg?.readable_duration ?? '';

  // For non-driving modes, estimate duration from distance
  let displayDur = fmtDuration(rawDur, durS);
  let displayDist = leg?.readable_distance ? `${leg.readable_distance} km` : fmtDistance(distM);
  let effectiveDurS = durS;

  if (mode === 'bike') {
    effectiveDurS = Math.round(durS * 1.25);
    displayDur    = fmtDuration('', effectiveDurS);
  } else if (mode === 'walking') {
    effectiveDurS = Math.round(distM / (5000 / 3600));  // 5 km/h
    displayDur    = fmtDuration('', effectiveDurS);
  } else if (mode === 'transit') {
    effectiveDurS = Math.round(distM / (12000 / 3600)); // 12 km/h avg
    displayDur    = fmtDuration('', effectiveDurS);
  }

  const steps: NavigationStep[] = (leg?.steps ?? []).map((s) => ({
    instruction:  s.instructions,
    maneuver:     s.maneuver,
    distanceM:    s.distance,
    distanceText: fmtDistance(s.distance),
    durationS:    s.duration,
    startLat:     s.start_location.lat,
    startLng:     s.start_location.lng,
    endLat:       s.end_location.lat,
    endLng:       s.end_location.lng,
  }));

  return {
    mode,
    routeCoords:  decodePolyline(route.overview_polyline ?? ''),
    steps,
    distanceText: displayDist,
    durationText: displayDur,
    distanceM:    distM,
    durationS:    effectiveDurS,
  };
}

// ── Fetch all 4 modes in parallel ─────────────────────────────────────────

export async function getAllModeDirections(
  origin: { lat: number; lng: number },
  dest:   { lat: number; lng: number },
): Promise<Record<TransportMode, DirectionsResult | null>> {
  const [driving, bike, walking, transit] = await Promise.all([
    getDirections(origin, dest, 'driving'),
    getDirections(origin, dest, 'bike'),
    getDirections(origin, dest, 'walking'),
    getDirections(origin, dest, 'transit'),
  ]);
  return { driving, bike, walking, transit };
}
