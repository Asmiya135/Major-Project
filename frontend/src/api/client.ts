/**
 * Two backends:
 *   EDGE   — this car's on-board agent (runs the models). One per car.
 *            Pick the car with ?edge=8002 (or a full URL); remembered per browser tab.
 *   SERVER — the one global server shared by all cars.
 */
function resolveEdge(): string {
  const fallback = import.meta.env.VITE_EDGE_URL || 'http://localhost:8001';
  try {
    const q = new URLSearchParams(window.location.search).get('edge');
    if (q) {
      const url = /^\d+$/.test(q) ? `http://localhost:${q}` : q;
      sessionStorage.setItem('vw_edge_url', url);
      return url;
    }
    return sessionStorage.getItem('vw_edge_url') || fallback;
  } catch {
    return fallback;
  }
}

export const API_BASE    = resolveEdge();
export const WS_BASE     = API_BASE.replace(/^http/, 'ws');
export const SERVER_BASE = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function makeClient(base: string) {
  return {
    get<T>(path: string) {
      return request<T>(base, path);
    },
    post<T>(path: string, body: unknown = {}) {
      return request<T>(base, path, { method: 'POST', body: JSON.stringify(body) });
    },
    postForm<T>(path: string, form: FormData) {
      return fetch(`${base}${path}`, { method: 'POST', body: form }).then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json() as Promise<T>;
      });
    },
  };
}

/** This car's edge agent */
export const api = makeClient(API_BASE);
/** The global server */
export const serverApi = makeClient(SERVER_BASE);
