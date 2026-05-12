import { useState, useEffect, useRef, useCallback } from 'react';
import { WS_BASE } from '../api/client';
import type { WsMessage, Detection } from '../api/types';

interface DriveFeedOptions {
  sessionId: string | null;
  onHazardDetected?: (det: Extract<WsMessage, { type: 'hazard_detected' }>) => void;
  onAlert?: (msg: Extract<WsMessage, { type: 'hazard_alert' }>) => void;
  onCaptureRate?: (rate: number) => void;
}

export function useDriveFeed({
  sessionId,
  onHazardDetected,
  onAlert,
  onCaptureRate,
}: DriveFeedOptions) {
  const [connected, setConnected] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [latestAlert, setLatestAlert] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connect = useCallback(() => {
    if (!sessionId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${WS_BASE}/ws/drive/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Keep-alive ping every 20 s
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
    };

    ws.onmessage = (ev) => {
      try {
        const msg: WsMessage = JSON.parse(ev.data);

        if (msg.type === 'hazard_detected') {
          const det: Detection = {
            id: msg.detection_id,
            hazard_id: msg.hazard_id,
            latitude: msg.latitude,
            longitude: msg.longitude,
            hazard_type: msg.hazard_type,
            severity: msg.severity,
            confidence: msg.confidence,
            distance_m: msg.distance_m,
            lane: msg.lane,
            source: 'vehicle',
            timestamp: new Date().toISOString(),
            needs_feedback: msg.needs_feedback ? 1 : 0,
          };
          setDetections((prev) => [det, ...prev.slice(0, 49)]);
          setLatestAlert(`${msg.hazard_type} — ${Math.round(msg.distance_m)}m • ${msg.lane}`);
          onHazardDetected?.(msg);
        }

        if (msg.type === 'hazard_alert') {
          setLatestAlert(msg.message);
          onAlert?.(msg);
        }

        if (msg.type === 'capture_rate') {
          onCaptureRate?.(msg.capture_rate_s);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (pingRef.current) clearInterval(pingRef.current);
      // Reconnect after 3 s
      setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => ws.close();
  }, [sessionId, onHazardDetected, onAlert, onCaptureRate]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (pingRef.current) clearInterval(pingRef.current);
    };
  }, [connect]);

  const sendLocation = useCallback((lat: number, lon: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'location_update', latitude: lat, longitude: lon }));
    }
  }, []);

  const sendSpeed = useCallback((speed_kmh: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'speed_update', speed_kmh }));
    }
  }, []);

  const dismissAlert = useCallback(() => setLatestAlert(null), []);

  return { connected, detections, latestAlert, sendLocation, sendSpeed, dismissAlert };
}
