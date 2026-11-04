import { api } from './client';
import type { Hazard } from './types';

/** Known hazards (server clusters when online, the car's cached copy when offline). */
export function fetchHazards() {
  return api.get<{ hazards: Hazard[]; online: boolean }>('/api/hazards');
}
