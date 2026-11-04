import { api, serverApi } from './client';

export interface CapturePolicy {
  speed_kmh: number; target_fps: number; interval_ms: number; coverage_m: number; reason: string;
}

export interface FusionModel {
  version: number; features: string[]; weights: number[]; bias: number;
  metrics: Record<string, unknown>; source: string; detector_version: number;
  thresholds: { high: number; medium: number };
}

export interface EdgeStatus {
  client_id: string; client_name: string; server_url: string;
  online: boolean; forced_offline: boolean; server_reachable: boolean; last_sync_error: string;
  telemetry: { lat: number; lon: number; speed_kmh: number; heading_deg: number; imu_peak: number; source: string };
  capture_policy: CapturePolicy;
  bt: {
    mode: string; radius_m: number; sent: number; received: number;
    rfcomm: { listening: boolean; address: string | null; peers: string[]; error: string };
    sim: { listening: boolean; group: string; error: string };
  };
  v2x_radius_m: number;
  outbox: { queued: number; sent: number; sent_after_offline: number };
  fusion_model: FusionModel;
  fl_samples: number; fl_unpushed: number; pending_verifications: number;
  models: Record<string, boolean | string | null>;
}

export interface OutboxItem {
  id: number; report_uid: string; status: 'queued' | 'sent'; queued_offline: number;
  attempts: number; created_at: string; sent_at: string | null;
  server_response: { cluster_id?: number; cluster_action?: string } | null;
  summary: { hazard_type: string; severity: string; fusion_score: number; routing: string; verified: boolean };
}

export interface RouteHazard {
  id: number; hazard_type: string; severity: string; latitude: number; longitude: number;
  confidence: number; count: number; verified: number; first_seen: string; last_seen: string;
  distance_along_m?: number; offset_m?: number;
}

export const edge = {
  status:     () => api.get<EdgeStatus>('/api/edge/status'),
  setNetwork: (offline: boolean) => api.post<{ online: boolean; flushed: number }>('/api/edge/network', { offline }),
  telemetry:  (t: Partial<{ lat: number; lon: number; speed_kmh: number; heading_deg: number; imu_peak: number; source: string }>) =>
    api.post('/api/edge/telemetry', t),
  outbox:     () => api.get<{ items: OutboxItem[]; queued: number; sent: number }>('/api/edge/outbox'),
  flush:      () => api.post('/api/edge/outbox/flush'),
  v2xTest:    (hazard_type = 'pothole', offset_m = 5) => api.post('/api/v2x/test', { hazard_type, offset_m }),
  demoDetect: (h: { hazard_type: string; latitude: number; longitude: number; distance_m: number }) =>
    api.post<{ fusion: { score: number; routing: string }; delivery: string; bluetooth: { transports: string[] } }>('/api/demo/detect', h),
  routeHazards: (coords: [number, number][]) =>
    api.post<{ source: string; hazards: RouteHazard[] }>('/api/route/hazards', { coords }),
  hazards:    () => api.get<{ hazards: RouteHazard[]; online: boolean }>('/api/hazards'),
  flStatus:   () => api.get('/api/fl/status'),
  flPush:     () => api.post<{ pushed: boolean; reason?: string }>('/api/fl/push'),
  flPull:     () => api.post('/api/fl/pull'),
  verifyAnswer: (id: number, response: 'yes' | 'no' | 'unsure') => api.post(`/api/verify/${id}/answer`, { response }),
  verifyVoice: (id: number, audio: Blob) => {
    const f = new FormData();
    f.append('audio', audio, 'answer.webm');
    return api.postForm<{ response: string; transcript: string }>(`/api/verify/${id}/voice`, f);
  },
};

export const server = {
  stats:     () => serverApi.get<Record<string, number>>('/api/stats'),
  hazards:   () => serverApi.get<{ hazards: RouteHazard[]; cluster_radius_m: number }>('/api/hazards'),
  reports:   (limit = 40) => serverApi.get<{ reports: ServerReport[] }>(`/api/reports?limit=${limit}`),
  clients:   () => serverApi.get<{ clients: ServerClient[] }>('/api/clients'),
  rounds:    () => serverApi.get<{ models: ServerModel[]; updates: ServerUpdate[]; pending: number }>('/api/fl/rounds'),
  aggregate: () => serverApi.post('/api/fl/aggregate'),
  recluster: (eps_m?: number) => serverApi.post<Record<string, number>>('/api/clusters/recluster', eps_m ? { eps_m } : {}),
  trainDetector: () => serverApi.post<{ started: boolean; version?: number; reason?: string }>('/api/fl/detector/train'),
  detectorJobs:  () => serverApi.get<{ jobs: DetectorJob[] }>('/api/fl/detector/jobs'),
};

export interface ServerReport {
  id: number; report_uid: string; client_id: string; cluster_id: number; hazard_type: string; severity: string;
  latitude: number; longitude: number; fusion_score: number; routing: string; verified: number; was_offline: number;
  signals: Record<string, number>; metrics: Record<string, unknown>; image_file: string | null;
  detected_at: string; received_at: string;
}
export interface ServerClient { client_id: string; name: string; last_seen: string; model_version: number; reports: number }
export interface ServerModel {
  version: number; weights: number[]; bias: number; metrics: Record<string, unknown>;
  n_updates: number; n_samples: number; created_at: string;
}
export interface ServerUpdate {
  id: number; client_id: string; base_version: number; n_samples: number;
  local_metrics: Record<string, number>; received_at: string; aggregated_into: number | null;
}
export interface DetectorJob {
  version: number; status: string; n_images: number; metrics: Record<string, number> | null;
  started_at: string; finished_at: string | null; error: string | null;
}
