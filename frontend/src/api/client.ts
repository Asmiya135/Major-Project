const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const API_BASE = BASE_URL;
export const WS_BASE = BASE_URL.replace(/^http/, 'ws');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get<T>(path: string) {
    return request<T>(path);
  },
  post<T>(path: string, body: unknown) {
    return request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  postForm<T>(path: string, form: FormData) {
    return fetch(`${API_BASE}${path}`, { method: 'POST', body: form }).then(async (res) => {
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<T>;
    });
  },
};
