import { api } from './client';
import type { Trip, TripSummary } from './types';

export function startTrip(sessionId?: string) {
  return api.post<{ session_id: string; trip_id: number; status: string }>(
    '/api/trips/start',
    { session_id: sessionId },
  );
}

export function endTrip(payload: {
  session_id: string;
  distance_km?: number;
  avg_speed_km?: number;
  hazards_avoided?: number;
  hazards_reported?: number;
}) {
  return api.post<{ trip: Trip; detections: unknown[]; total_hazards_detected: number }>(
    '/api/trips/end',
    payload,
  );
}

export function getTripSummary(sessionId: string) {
  return api.get<TripSummary>(`/api/trips/${sessionId}/summary`);
}
