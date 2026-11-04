import { api } from './client';
import type { FeedbackResponse, SystemStatus } from './types';

/** Answer a pending driver verification (hazard_id is the verification id on the car). */
export function submitFeedback(payload: {
  hazard_id: number;
  session_id: string;
  response: FeedbackResponse;
}) {
  return api.post(`/api/verify/${payload.hazard_id}/answer`, { response: payload.response });
}

export function fetchSystemStatus() {
  return api.get<SystemStatus>('/api/system/status');
}
