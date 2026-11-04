/**
 * Live link to this car's edge agent (/ws/events).
 *   in  → telemetry (GPS, speed, heading, IMU)
 *   out ← status every second + every event: hazards reported/queued/synced, Bluetooth
 *         V2X alerts, route alerts, driver-verification requests, federated-learning updates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_BASE } from '../api/client';
import type { EdgeStatus } from '../api/edge';

export interface FeedItem { id: number; time: string; kind: string; text: string; tone: 'red' | 'amber' | 'green' | 'blue' | 'purple' | 'gray' }

export interface VerifyRequest {
  verify_id: number; hazard_type: string; fusion_score: number; severity: string;
  metrics: Record<string, unknown>; question: string; question_source: string;
  generating: boolean; image_b64: string;
}

export interface BtAlert {
  msg_id: string; hazard_type: string; severity: string; distance_m: number; radius_m: number;
  from_client: string; from_name?: string; transport: string; message: string; latitude: number; longitude: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = Record<string, any>;

const label = (t: string) => (t ?? '').replace(/_/g, ' ');

function describe(m: Msg): Omit<FeedItem, 'id' | 'time'> | null {
  switch (m.type) {
    case 'hazard_detected':
      return m.delivery === 'sent_to_server'
        ? { kind: 'report', tone: 'red', text: `🚨 ${label(m.hazard_type)} (${(m.confidence * 100).toFixed(0)}%${m.verified ? ', driver-verified' : ''}) → server cluster #${m.hazard_id} (${m.cluster_action}) · BT: ${m.bt_transports?.join(', ') || 'none'}` }
        : { kind: 'queue', tone: 'amber', text: `📦 ${label(m.hazard_type)} QUEUED OFFLINE on car · BT broadcast: ${m.bt_transports?.join(', ') || 'none'}` };
    case 'report_synced':
      return { kind: 'sync', tone: 'green', text: `⬆ ${m.was_offline ? 'Offline-queued ' : ''}${label(m.hazard_type)} uploaded → cluster #${m.cluster_id} (${m.cluster_action})` };
    case 'bt_sent': {
      const peers = (m.rfcomm_peers ?? []) as { peer: string; ok: boolean; error?: string }[];
      const detail = peers.map((p) => `${p.peer} ${p.ok ? '✓' : `✗ ${p.error ?? ''}`}`).join(' · ');
      return { kind: 'bt', tone: peers.some((p) => !p.ok) ? 'amber' : 'blue',
               text: `📡 Bluetooth broadcast: ${label(m.hazard_type)} via ${m.transports?.join(', ') || 'no transport'}${detail ? ` — RFCOMM ${detail}` : ''}` };
    }
    case 'bt_received':
      return { kind: 'bt', tone: m.inside_radius ? 'red' : 'blue', text: `📶 BT from ${m.from_name ?? m.from_client}: ${label(m.hazard_type)} ${m.distance_m} m away — ${m.inside_radius ? `inside ${m.radius_m} m → ALERT` : `outside ${m.radius_m} m → watching`}` };
    case 'bt_alert':
      return { kind: 'bt', tone: 'red', text: `⚠ V2X ALERT: ${m.message}` };
    case 'hazard_alert':
      return { kind: 'route', tone: 'amber', text: `🗺 ${m.message}` };
    case 'verify_request':
      return { kind: 'verify', tone: 'amber', text: `❓ MEDIUM ${label(m.hazard_type)} (${(m.fusion_score * 100).toFixed(0)}%) — asking the driver (not sent yet)` };
    case 'verify_result':
      return { kind: 'verify', tone: m.response === 'yes' ? 'green' : 'gray', text: `🗣 Driver said "${m.response}"${m.response === 'yes' ? ' → reported as verified hazard + FL positive sample' : m.response === 'no' ? ' → discarded, FL negative sample (stays on car)' : ''}` };
    case 'fl_pushed':
      return { kind: 'fl', tone: 'purple', text: `🧠 FL: pushed local weights (${m.update?.n_samples} samples, acc ${m.update?.local_metrics?.accuracy_before}→${m.update?.local_metrics?.accuracy})` };
    case 'fl_model_updated':
      return { kind: 'fl', tone: 'purple', text: `🧠 FL: installed global FedAvg fusion model v${m.model?.version} from server` };
    case 'fl_detector_updated':
      return { kind: 'fl', tone: 'purple', text: `🧠 FL: installed fine-tuned detector v${m.detector_version}` };
    case 'network':
      return { kind: 'net', tone: m.online ? 'green' : 'amber', text: m.online ? '🌐 ONLINE — server reachable, flushing offline queue' : '🚫 OFFLINE — new hazards are queued on the car' };
    default:
      return null;
  }
}

export function useEdgeEvents(opts: { onMessage?: (m: Msg) => void } = {}) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [verifyQueue, setVerifyQueue] = useState<VerifyRequest[]>([]);
  const [btAlert, setBtAlert] = useState<BtAlert | null>(null);
  const [routeAlert, setRouteAlert] = useState<(Msg & { message: string }) | null>(null);
  const [lastHazard, setLastHazard] = useState<Msg | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onMsgRef = useRef(opts.onMessage);
  onMsgRef.current = opts.onMessage;
  const seq = useRef(0);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(`${WS_BASE}/ws/events`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let m: Msg;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'status' || m.type === 'connected') { setStatus(m as unknown as EdgeStatus); }
        if (m.type === 'verify_request') setVerifyQueue((q) => [...q.filter((v) => v.verify_id !== m.verify_id), m as VerifyRequest]);
        if (m.type === 'verify_question') setVerifyQueue((q) => q.map((v) => v.verify_id === m.verify_id ? { ...v, ...m } : v));
        if (m.type === 'verify_result') setVerifyQueue((q) => q.filter((v) => v.verify_id !== m.verify_id));
        if (m.type === 'bt_alert') { setBtAlert(m as BtAlert); speak(`Alert! Alert! ${m.message}`); }
        if (m.type === 'hazard_alert') { setRouteAlert(m as Msg & { message: string }); speak(m.message); }
        if (m.type === 'hazard_detected') setLastHazard(m);
        const d = describe(m);
        if (d) {
          const item = { ...d, id: ++seq.current, time: new Date().toLocaleTimeString() };
          setFeed((f) => [item, ...f].slice(0, 80));
        }
        onMsgRef.current?.(m);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); wsRef.current?.close(); };
  }, []);

  const sendTelemetry = useCallback((t: Partial<{ lat: number; lon: number; speed_kmh: number; heading_deg: number; imu_peak: number; source: string }>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'telemetry', ...t }));
  }, []);

  const resetRouteAlerts = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'reset_route_alerts' }));
  }, []);

  return {
    connected, status, feed, verifyQueue, btAlert, routeAlert, lastHazard,
    sendTelemetry, resetRouteAlerts,
    dismissBtAlert: () => setBtAlert(null), dismissRouteAlert: () => setRouteAlert(null),
    /** Raise a V2X alert decided on this page (demo: hazard map-matched onto our own route). */
    raiseBtAlert: (a: BtAlert) => {
      setBtAlert(a);
      speak(`Alert! Alert! ${a.message}`);
      const item = { id: ++seq.current, time: new Date().toLocaleTimeString(), kind: 'bt', tone: 'red' as const,
                     text: `⚠ V2X ALERT: ${a.message}` };
      setFeed((f) => [item, ...f].slice(0, 80));
    },
    dropVerify: (id: number) => setVerifyQueue((q) => q.filter((v) => v.verify_id !== id)),
  };
}

export function speak(text: string) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.replace(/[⚠🚨]/g, '')));
  } catch { /* speech not available */ }
}
