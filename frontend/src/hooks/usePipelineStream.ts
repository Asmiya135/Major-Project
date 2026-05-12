import { useState, useEffect, useRef, useCallback } from 'react';
import { WS_BASE } from '../api/client';

// ── Types ──────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface StepImages { [key: string]: string }  // key → base64 JPEG

export interface StepResult {
  step:        number;
  name:        string;
  status:      StepStatus | string;
  duration_ms: number;
  data:        Record<string, unknown> & { images?: StepImages };
}

export interface PipelineResult {
  detections:   unknown[];
  fusion_score: number;
  severity:     string;
  hazard_type:  string | null;
  routing:      string;
  hazard_id:    number | null;
}

interface Hazard {
  id: number; latitude: number; longitude: number;
  hazard_type: string; severity: string; confidence: number; count: number;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function usePipelineStream(sessionId: string | null) {
  const [connected,    setConnected]    = useState(false);
  const [steps,        setSteps]        = useState<Map<number, StepResult>>(new Map());
  const [lastResult,   setLastResult]   = useState<PipelineResult | null>(null);
  const [hazards,      setHazards]      = useState<Hazard[]>([]);
  const [voiceResult,  setVoiceResult]  = useState<{ transcript: string; response: string } | null>(null);
  const [processing,   setProcessing]   = useState(false);

  const wsRef   = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connect = useCallback(() => {
    if (!sessionId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${WS_BASE}/ws/pipeline/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
      // Fetch current hazards for map
      ws.send(JSON.stringify({ type: 'get_hazards' }));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);

        if (msg.type === 'step_start') {
          setSteps((prev) => {
            const next = new Map(prev);
            next.set(msg.step, {
              step: msg.step, name: msg.name,
              status: 'running', duration_ms: 0, data: {},
            });
            return next;
          });
        }

        if (msg.type === 'step_result') {
          setSteps((prev) => {
            const next = new Map(prev);
            next.set(msg.step, {
              step:        msg.step,
              name:        msg.name,
              status:      msg.status,
              duration_ms: msg.duration_ms,
              data:        msg.data ?? {},
            });
            return next;
          });
        }

        if (msg.type === 'pipeline_complete') {
          setLastResult(msg.result);
          setProcessing(false);
        }

        if (msg.type === 'hazards_update') {
          setHazards(msg.hazards ?? []);
        }

        if (msg.type === 'voice_result') {
          setVoiceResult({ transcript: msg.transcript, response: msg.response });
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setConnected(false);
      if (pingRef.current) clearInterval(pingRef.current);
      setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => ws.close();
  }, [sessionId]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (pingRef.current) clearInterval(pingRef.current);
    };
  }, [connect]);

  // Send a video frame for processing
  const sendFrame = useCallback((
    frameB64: string,
    lat = 19.076, lon = 72.877, speedKmh = 0,
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    setProcessing(true);
    setSteps(new Map());   // reset step cards for new frame
    wsRef.current.send(JSON.stringify({
      type: 'frame', data: frameB64,
      latitude: lat, longitude: lon, speed_kmh: speedKmh,
    }));
    // Refresh hazard map after a short delay
    setTimeout(() => {
      wsRef.current?.send(JSON.stringify({ type: 'get_hazards' }));
    }, 1500);
  }, []);

  // Send voice audio for verification
  const sendVoice = useCallback((audioB64: string, hazardId: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'voice_feedback', audio_b64: audioB64, hazard_id: hazardId,
    }));
  }, []);

  return {
    connected, steps, lastResult, hazards, voiceResult, processing,
    sendFrame, sendVoice,
  };
}
