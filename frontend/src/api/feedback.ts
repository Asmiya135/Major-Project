import { api } from './client';
import type { FeedbackResponse, SystemStatus } from './types';

export function submitFeedback(payload: {
  hazard_id: number;
  session_id: string;
  response: FeedbackResponse;
}) {
  return api.post<{ status: string; hazard_id: number; response: string }>(
    '/api/feedback',
    payload,
  );
}

export function fetchSystemStatus() {
  return api.get<SystemStatus>('/api/system/status');
}
