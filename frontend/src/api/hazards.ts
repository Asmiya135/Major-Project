import { api } from './client';
import type { Hazard, Severity, HazardType } from './types';

export function fetchHazards(params?: {
  hazard_type?: HazardType;
  severity?: Severity;
  since_hours?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.hazard_type) qs.set('hazard_type', params.hazard_type);
  if (params?.severity) qs.set('severity', params.severity);
  if (params?.since_hours) qs.set('since_hours', String(params.since_hours));
  return api.get<{ hazards: Hazard[] }>(`/api/hazards?${qs}`);
}

export function uploadHazard(payload: {
  latitude: number;
  longitude: number;
  confidence: number;
  hazard_type: string;
  severity: string;
  session_id?: string;
}) {
  return api.post<{ status: string; hazard_id: number }>('/api/hazards', payload);
}
