import { useState, useEffect, useRef, useCallback } from 'react';
import { WS_BASE } from '../api/client';

export interface StepResult {
  step: number;
  name: string;
  status: string;
  duration_ms: number;
  data: Record<string, unknown> & { images?: Record<string, string> };
  stale?: boolean;          // carried over from the last processed frame (current one was skipped)
}

export interface FrameStats {
  frames_captured: number; frames_processed: number; frames_skipped_duplicate: number;
  frames_dropped_busy: number; compute_saving_pct: number; measured_capture_fps: number;
}

export interface PipelineResult {
  routing: string; fusion_score: number; hazard_type: string | null; severity: string;
  candidates: number; actions: Record<string, unknown>[];
}

export interface VideoProgress {
  frame: number; rawFrame: number; total: number; sampleEvery: number; targetFps: number;
  videoTime: number; done: boolean;
}

/** Streams the on-car pipeline: frames in, one annotated result per step out. */
export function usePipelineStream(sessionId: string) {
  const [connected, setConnected] = useState(false);
  const [steps, setSteps] = useState<Map<number, StepResult>>(new Map());
  const [lastResult, setLastResult] = useState<PipelineResult | null>(null);
  const [stats, setStats] = useState<FrameStats | null>(null);
  const [processing, setProcessing] = useState(false);
  const [video, setVideo] = useState<VideoProgress | null>(null);
  const [error, setError] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(`${WS_BASE}/ws/pipeline/${sessionId}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); setProcessing(false); if (!closed) retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try { m = JSON.parse(ev.data); } catch { return; }
        switch (m.type) {
          case 'step_start':
            setProcessing(true);
            setSteps((prev) => {
              const next = new Map(prev);
              if (m.step === 1) next.forEach((v, k) => next.set(k, { ...v, stale: true }));
              next.set(m.step, { step: m.step, name: m.name, status: 'running', duration_ms: 0, data: {} });
              return next;
            });
            break;
          case 'step_result':
            setSteps((prev) => new Map(prev).set(m.step, { ...m, stale: false }));
            break;
          case 'pipeline_complete':
            setProcessing(false);
            setStats(m.stats);
            if (m.result?.routing !== 'AKS_SKIP') setLastResult(m.result);
            break;
          case 'frame_ack':
            setStats(m.stats);
            break;
          case 'video_start':
            setVideo({ frame: 0, rawFrame: 0, total: m.total_frames, sampleEvery: 1, targetFps: 0, videoTime: 0, done: false });
            break;
          case 'video_frame_start':
            setVideo({ frame: m.frame_number, rawFrame: m.raw_frame, total: m.total_frames, sampleEvery: m.sample_every,
                       targetFps: m.target_fps, videoTime: m.video_time_s, done: false });
            break;
          case 'video_complete':
            setVideo((v) => v ? { ...v, done: true } : v);
            setProcessing(false);
            if (m.stats) setStats(m.stats);
            break;
          case 'error':
            setError(m.message);
            setProcessing(false);
            break;
        }
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); wsRef.current?.close(); };
  }, [sessionId]);

  const send = (obj: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) { wsRef.current.send(JSON.stringify(obj)); return true; }
    return false;
  };
  const sendFrame = useCallback((b64: string) => send({ type: 'frame', data: b64 }), []);
  const processVideo = useCallback((videoId: string) => { setError(''); return send({ type: 'process_video', video_id: videoId }); }, []);
  const stopVideo = useCallback(() => send({ type: 'stop_video' }), []);

  return { connected, steps, lastResult, stats, processing, video, error, sendFrame, processVideo, stopVideo };
}
