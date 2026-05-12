export type HazardType = 'pothole' | 'debris' | 'bump' | 'stalled_vehicle' | 'flood';
export type Severity = 'low' | 'medium' | 'high';
export type FeedbackResponse = 'yes' | 'no' | 'unsure';

export interface Hazard {
  id: number;
  latitude: number;
  longitude: number;
  hazard_type: HazardType;
  confidence: number;
  severity: Severity;
  count: number;
  first_seen: string;
  last_seen: string;
  verified: number;
}

export interface Detection {
  id: number;
  hazard_id: number;
  latitude: number;
  longitude: number;
  hazard_type: HazardType;
  severity: Severity;
  confidence: number;
  distance_m: number;
  lane: string;
  source: 'vehicle' | 'v2x' | 'preloaded';
  timestamp: string;
  needs_feedback: number;
}

export interface Trip {
  id: number;
  session_id: string;
  start_time: string;
  end_time: string | null;
  distance_km: number;
  avg_speed_km: number;
  hazards_avoided: number;
  hazards_reported: number;
  status: 'active' | 'completed';
}

export interface TripSummary {
  trip: Trip;
  detections: Detection[];
  pending_feedback: PendingFeedback[];
  hazard_breakdown: Record<string, number>;
  total_detected: number;
}

export interface PendingFeedback {
  detection_id: number;
  hazard_id: number;
  hazard_type: HazardType;
  timestamp: string;
}

export interface SystemStatus {
  status: string;
  cameras: boolean;
  gps: boolean;
  map: boolean;
  hazards_synced: boolean;
  network: boolean;
  sensors: boolean;
  pipeline: Record<string, boolean>;
  active_drive_sessions: number;
}

// WebSocket message shapes
export type WsMessage =
  | { type: 'connected'; session_id: string; message: string }
  | { type: 'pong' }
  | { type: 'keepalive' }
  | { type: 'capture_rate'; capture_rate_s: number }
  | { type: 'hazard_detected'; detection_id: number; hazard_id: number; hazard_type: HazardType; severity: Severity; confidence: number; distance_m: number; lane: string; latitude: number; longitude: number; needs_feedback: boolean }
  | { type: 'hazard_alert'; hazard: Hazard; message: string };
