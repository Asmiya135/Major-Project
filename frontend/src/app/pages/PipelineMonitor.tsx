/**
 * CLIENT (car) live-detection console — everything here runs on this car's edge agent.
 * Shows, for the demo: live camera capture at a speed-dependent frame rate, every model
 * head's labelled output, the fusion-engine calculation, alert routing (server / offline
 * queue / Bluetooth V2X / driver verification) and the car's event feed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, Upload, Play, Square, ChevronDown, ChevronRight, Gauge, Navigation2,
  Activity, Bluetooth, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, LocateFixed, Package, Zap,
} from 'lucide-react';
import { API_BASE } from '../../api/client';
import { edge, type OutboxItem } from '../../api/edge';
import { usePipelineStream, type StepResult } from '../../hooks/usePipelineStream';
import { useEdgeEvents, type FeedItem } from '../../hooks/useEdgeEvents';
import { CarStatusBar } from '../components/CarStatusBar';
import { VerifyModal } from '../components/VerifyModal';
import { AlertBanner } from '../components/AlertBanner';

const STEPS: Record<number, { name: string; icon: string; model: string; desc: string }> = {
  1:  { name: 'Capture & AKS',        icon: '🎞️', model: 'Model 1', desc: 'Capture rate follows speed (m/s ÷ metres per frame); near-duplicate frames are skipped.' },
  2:  { name: 'Dehaze / low light',   icon: '🌫️', model: 'Model 2', desc: 'AOD-Net is applied only when the dark-channel haze score or brightness says so.' },
  3:  { name: 'Privacy',              icon: '🔒', model: 'on-car',  desc: 'Faces and number plates blurred before anything is stored or sent.' },
  4:  { name: 'H4 Road mask',         icon: '🛣️', model: 'Model 3', desc: 'Fast-SCNN: road surface vs pavement → on-road / off-road per hazard.' },
  5:  { name: 'H3 Depth',             icon: '📐', model: 'Model 3', desc: 'MiDaS monocular depth → pothole depth from depth contrast.' },
  6:  { name: 'H2 Segmentation',      icon: '🎯', model: 'Model 3', desc: 'Pothole masks + width, length, area, depth, distance (flat-road camera model).' },
  7:  { name: 'H1 Detection',         icon: '🔍', model: 'Model 3', desc: 'Potholes, unmarked speed bumps, debris — confirms H2 and fills its gaps.' },
  8:  { name: 'H5 Stalled vehicles',  icon: '🚗', model: 'Model 3', desc: 'YOLO11 + SORT tracking; stalled = persistent + stationary (optical flow) + on road.' },
  9:  { name: 'Motion: flow + IMU',   icon: '🌀', model: 'Model 3', desc: 'Farneback optical-flow consistency and IMU vertical-acceleration bump.' },
  10: { name: 'Fusion engine',        icon: '⚡', model: 'Model 4', desc: 'score = sigmoid(bias + Σ weight × signal); weights come from federated learning.' },
  11: { name: 'Alert routing',        icon: '📡', model: 'Model 5/6', desc: 'HIGH → server (or offline queue) + Bluetooth V2X · MEDIUM → ask driver · LOW → discard.' },
};

const STATUS_COLOR: Record<string, string> = {
  running: '#f59e0b', done: '#10b981', processed: '#10b981', enhanced: '#10b981', not_needed: '#64748b',
  skipped: '#64748b', HIGH: '#ef4444', MEDIUM: '#f59e0b', DISCARD: '#64748b', reported: '#ef4444',
  verify: '#f59e0b', no_hazard: '#64748b',
};

const ROUTE_STYLE: Record<string, string> = {
  HIGH: 'bg-red-600/20 border-red-500 text-red-200',
  MEDIUM: 'bg-yellow-500/15 border-yellow-500 text-yellow-200',
  DISCARD: 'bg-white/5 border-white/15 text-gray-300',
};

const FEED_TONE: Record<FeedItem['tone'], string> = {
  red: 'text-red-300', amber: 'text-amber-300', green: 'text-green-300', blue: 'text-sky-300',
  purple: 'text-purple-300', gray: 'text-gray-400',
};

const EARTH = 6371000;
function move(lat: number, lon: number, headingDeg: number, metres: number): [number, number] {
  const h = headingDeg * Math.PI / 180;
  return [lat + (metres * Math.cos(h) / EARTH) * 180 / Math.PI,
          lon + (metres * Math.sin(h) / (EARTH * Math.cos(lat * Math.PI / 180))) * 180 / Math.PI];
}

// ── Step card ──────────────────────────────────────────────────────────────
function StepCard({ n, r, open, onToggle }: { n: number; r?: StepResult; open: boolean; onToggle: () => void }) {
  const meta = STEPS[n];
  const color = r ? (STATUS_COLOR[r.status] ?? '#10b981') : '#334155';
  const images = (r?.data?.images ?? {}) as Record<string, string>;
  const scalars = Object.entries(r?.data ?? {}).filter(([k, v]) => k !== 'images' && (typeof v !== 'object' || v === null));
  return (
    <div className={`border border-white/10 rounded-xl overflow-hidden bg-white/[0.03] ${r?.stale ? 'opacity-55' : ''}`}>
      <button className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 text-left" onClick={onToggle}>
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color, boxShadow: r?.status === 'running' ? `0 0 8px ${color}` : 'none' }} />
        <span className="text-xs text-gray-500 w-4">{n}</span>
        <span>{meta.icon}</span>
        <span className="text-sm font-semibold flex-1">{meta.name} <span className="text-[10px] font-normal text-gray-500 ml-1">{meta.model}</span></span>
        {r?.stale && <span className="text-[10px] text-gray-500">last processed frame</span>}
        {r && r.status !== 'running' && <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/10" style={{ color }}>{r.status}</span>}
        {r?.duration_ms ? <span className="text-[11px] text-gray-500 tabular-nums w-14 text-right">{r.duration_ms} ms</span> : null}
        {open ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
      </button>
      {open && r && r.status !== 'running' && (
        <div className="px-4 pb-4 border-t border-white/10 bg-black/20">
          <p className="text-xs text-gray-400 py-2">{meta.desc}</p>
          {Object.keys(images).length > 0 && (
            <div className={`grid gap-2 mb-3 ${Object.keys(images).length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {Object.entries(images).map(([k, b64]) => (
                <figure key={k}>
                  <figcaption className="text-[11px] text-gray-500 mb-1 capitalize">{k.replace(/_/g, ' ')}</figcaption>
                  <img src={`data:image/jpeg;base64,${b64}`} alt={k} className="w-full rounded-lg border border-white/10" />
                </figure>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
            {scalars.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 text-xs py-0.5">
                <span className="text-gray-500 capitalize">{k.replace(/_/g, ' ')}</span>
                <span className="text-gray-100 tabular-nums text-right">{typeof v === 'boolean' ? (v ? '✓' : '✗') : String(v ?? '—')}</span>
              </div>
            ))}
          </div>
          {n === 8 && Array.isArray(r.data.tracks) && (r.data.tracks as Record<string, unknown>[]).length > 0 && (
            <table className="w-full text-xs mt-3">
              <thead><tr className="text-gray-500 text-left"><th>Track</th><th>Frames</th><th>Stationarity</th><th>On road</th><th>Dist</th><th>State</th></tr></thead>
              <tbody>{(r.data.tracks as Record<string, unknown>[]).map((t) => (
                <tr key={String(t.track_id)} className="border-t border-white/5">
                  <td>#{String(t.track_id)}</td><td>{String(t.frames_tracked)}</td><td>{String(t.stationarity)}</td>
                  <td>{t.on_road ? '✓' : '✗'}</td><td>{String(t.distance_m)} m</td>
                  <td className={t.is_stalled ? 'text-red-400 font-semibold' : 'text-green-400'}>{t.is_stalled ? 'STALLED' : 'moving'}</td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Fusion breakdown ───────────────────────────────────────────────────────
interface Contribution { signal: string; value: number; weight: number; contribution: number }
interface Candidate {
  hazard_type: string; track_id: number; source: string; severity: string; score: number; logit: number;
  bias: number; routing: string; contributions: Contribution[]; metrics: Record<string, unknown>;
}

function FusionPanel({ step }: { step?: StepResult }) {
  const cands = (step?.data?.candidates ?? []) as Candidate[];
  const th = step?.data?.thresholds as { high: number; medium: number } | undefined;
  if (!step || step.status === 'running') return null;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold flex items-center gap-2"><Zap className="w-4 h-4 text-yellow-300" />Fusion engine calculation</div>
        <div className="text-[11px] text-gray-400">model v{String(step.data.model_version)} ({String(step.data.model_source)}) · HIGH ≥ {th?.high} · MEDIUM ≥ {th?.medium}</div>
      </div>
      {cands.length === 0 && <div className="text-sm text-gray-500">No hazard candidates in this frame.</div>}
      {cands.map((c, i) => (
        <div key={i} className={`rounded-lg border p-3 mb-2 ${ROUTE_STYLE[c.routing]}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-sm">
            <b className="capitalize">{c.hazard_type.replace(/_/g, ' ')}</b>
            <span className="text-xs opacity-80">track #{c.track_id} · {c.source} · severity {c.severity}</span>
            <span className="ml-auto font-mono text-xs">sigmoid({c.logit}) = <b className="text-base">{c.score.toFixed(3)}</b> → {c.routing}</span>
          </div>
          <table className="w-full text-xs">
            <thead><tr className="text-left opacity-60"><th className="font-normal">signal</th><th className="font-normal">value</th><th className="font-normal">× weight</th><th className="font-normal">= contribution</th><th className="w-1/3"></th></tr></thead>
            <tbody>
              {c.contributions.map((x) => (
                <tr key={x.signal} className="border-t border-white/5">
                  <td className="py-0.5">{x.signal.replace(/_/g, ' ')}</td>
                  <td className="tabular-nums">{x.value.toFixed(2)}</td>
                  <td className="tabular-nums">{x.weight.toFixed(2)}</td>
                  <td className={`tabular-nums ${x.contribution < 0 ? 'text-red-300' : ''}`}>{x.contribution >= 0 ? '+' : ''}{x.contribution.toFixed(2)}</td>
                  <td><div className="h-1.5 bg-white/10 rounded-full overflow-hidden"><div className="h-full bg-sky-400 rounded-full" style={{ width: `${Math.min(100, Math.abs(x.contribution) / 3 * 100)}%` }} /></div></td>
                </tr>
              ))}
              <tr className="border-t border-white/10"><td>bias</td><td /><td /><td className="tabular-nums">{c.bias.toFixed(2)}</td><td /></tr>
            </tbody>
          </table>
          <div className="text-[11px] opacity-75 mt-2">
            {String(c.metrics.surface)} · {String(c.metrics.lane)} · ~{String(c.metrics.distance_m)} m ahead · W {String(c.metrics.width_m)} m × L {String(c.metrics.length_m)} m · area {String(c.metrics.area_m2)} m² · depth ~{String(c.metrics.depth_cm)} cm
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function PipelineMonitor() {
  const [sessionId] = useState(() => `live-${Date.now()}`);
  const pipe = usePipelineStream(sessionId);
  const ev = useEdgeEvents();
  const status = ev.status;

  const [mode, setMode] = useState<'camera' | 'video'>('camera');
  const [open, setOpen] = useState<Set<number>>(new Set([1, 6, 8, 10]));
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [uploaded, setUploaded] = useState<{ id: string; name: string; frames: number; fps: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);

  // ── Telemetry (speed, position, heading, IMU) ───────────────────────────
  const [speed, setSpeed] = useState(30);
  const [heading, setHeading] = useState(0);
  const [pos, setPos] = useState<[number, number] | null>(null);
  const [simMove, setSimMove] = useState(false);
  const [posInput, setPosInput] = useState('');
  const [imuLive, setImuLive] = useState(0);
  const imuPeakRef = useRef(0);
  const bumpUntil = useRef(0);
  const telRef = useRef({ speed, heading, pos, simMove });
  telRef.current = { speed, heading, pos, simMove };

  // adopt the car's stored position once (each car keeps its own)
  useEffect(() => {
    if (!pos && status) setPos([status.telemetry.lat, status.telemetry.lon]);
  }, [status, pos]);

  useEffect(() => {
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (a?.z != null) imuPeakRef.current = Math.max(imuPeakRef.current, Math.abs(Math.abs(a.z) - 9.81));
    };
    window.addEventListener('devicemotion', onMotion);
    return () => window.removeEventListener('devicemotion', onMotion);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const t = telRef.current;
      let p = t.pos;
      if (p && t.simMove && t.speed > 0) {
        p = move(p[0], p[1], t.heading, t.speed / 3.6);
        setPos(p);
      }
      const imu = Date.now() < bumpUntil.current ? 6.0 : imuPeakRef.current;
      setImuLive(imu);
      imuPeakRef.current = 0;
      if (p) ev.sendTelemetry({ lat: p[0], lon: p[1], speed_kmh: t.speed, heading_deg: t.heading, imu_peak: imu, source: t.simMove ? 'simulated-drive' : 'manual' });
    }, 1000);
    return () => clearInterval(id);
  }, [ev.sendTelemetry]);

  const nudge = (deg: number) => pos && setPos(move(pos[0], pos[1], deg, 5));
  const useGps = () => navigator.geolocation?.getCurrentPosition((p) => setPos([p.coords.latitude, p.coords.longitude]));

  // ── Model 1: capture loop at the car's speed-dependent rate ─────────────
  const policy = status?.capture_policy;
  const intervalRef = useRef(1000);
  intervalRef.current = policy?.interval_ms ?? 1000;

  const grab = useCallback(() => {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return;
    c.width = 960;
    c.height = Math.round(960 * v.videoHeight / v.videoWidth);
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    pipe.sendFrame(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
  }, [pipe.sendFrame]);

  useEffect(() => {
    if (!capturing) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { grab(); t = setTimeout(loop, intervalRef.current); };
    loop();
    return () => clearTimeout(t);
  }, [capturing, grab]);

  const startCamera = async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'environment' } }).catch(() => null);
    if (!s || !videoRef.current) return;
    streamRef.current = s;
    videoRef.current.srcObject = s;
    await videoRef.current.play();
    setCameraOn(true);
  };
  const stopCamera = () => {
    setCapturing(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  };
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.src = URL.createObjectURL(f); }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', f);
      form.append('session_id', sessionId);
      const r = await fetch(`${API_BASE}/api/detect/video/upload`, { method: 'POST', body: form }).then((x) => x.json());
      setUploaded({ id: r.video_id, name: f.name, frames: r.total_frames, fps: r.fps });
    } finally { setUploading(false); }
  };

  // ── Offline queue list ───────────────────────────────────────────────────
  useEffect(() => {
    const load = () => edge.outbox().then((r) => setOutbox(r.items)).catch(() => {});
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, []);

  const toggle = (n: number) => setOpen((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const st = pipe.stats;
  const fusionStep = pipe.steps.get(10);
  const routing = pipe.lastResult?.routing;
  const verify = ev.verifyQueue[0];

  return (
    <div className="w-full min-h-screen bg-[#0b1120] text-white">
      <CarStatusBar status={status} connected={ev.connected} />
      <AlertBanner bt={ev.btAlert} route={ev.routeAlert} onCloseBt={ev.dismissBtAlert} onCloseRoute={ev.dismissRouteAlert} />
      {verify && <VerifyModal key={verify.verify_id} req={verify} pending={ev.verifyQueue.length} onDone={ev.dropVerify} />}

      <div className="flex flex-col xl:flex-row">
        {/* ── Left: inputs, sensors, V2X, feed ─────────────────────────── */}
        <div className="w-full xl:w-[430px] shrink-0 border-r border-white/10 p-4 space-y-4">
          <div className="flex rounded-xl overflow-hidden border border-white/10">
            {(['camera', 'video'] as const).map((m) => (
              <button key={m} onClick={() => { setMode(m); if (m === 'video') stopCamera(); }}
                className={`flex-1 py-2 text-xs font-semibold ${mode === m ? 'bg-[#1d4ed8]' : 'bg-white/5 text-gray-400'}`}>
                {m === 'camera' ? '📷 Live camera' : '📹 Dashcam video'}
              </button>
            ))}
          </div>

          <div className="aspect-video bg-black rounded-xl overflow-hidden relative">
            <video ref={videoRef} muted playsInline controls={mode === 'video'} className="w-full h-full object-contain" />
            {mode === 'camera' && !cameraOn && <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">Camera off</div>}
            {capturing && <div className="absolute top-2 left-2 text-[11px] bg-red-600 px-2 py-0.5 rounded-full animate-pulse">● capturing {policy?.target_fps} fps</div>}
          </div>
          <canvas ref={canvasRef} className="hidden" />

          {mode === 'camera' ? (
            <div className="flex gap-2">
              <button onClick={cameraOn ? stopCamera : startCamera} className="flex-1 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-semibold flex items-center justify-center gap-2">
                <Camera className="w-4 h-4" />{cameraOn ? 'Stop camera' : 'Start camera'}
              </button>
              <button disabled={!cameraOn || !pipe.connected} onClick={() => setCapturing((c) => !c)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 ${capturing ? 'bg-red-600' : 'bg-green-600 hover:bg-green-700'}`}>
                {capturing ? <><Square className="w-4 h-4" />Stop detection</> : <><Play className="w-4 h-4" />Start detection</>}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="w-full py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer">
                <Upload className="w-4 h-4" />{uploading ? 'Uploading to car…' : uploaded ? `Change video (${uploaded.name})` : 'Upload dashcam video'}
                <input type="file" accept="video/*" className="hidden" onChange={onFile} />
              </label>
              {uploaded && (
                <button disabled={!pipe.connected} onClick={() => (pipe.video && !pipe.video.done ? pipe.stopVideo() : pipe.processVideo(uploaded.id))}
                  className="w-full py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40">
                  {pipe.video && !pipe.video.done ? <><Square className="w-4 h-4" />Stop</> : <><Play className="w-4 h-4" />Run on-car pipeline ({uploaded.frames} frames @ {uploaded.fps} fps)</>}
                </button>
              )}
              {pipe.video && (
                <div className="text-xs text-gray-400 bg-white/5 rounded-lg p-2.5">
                  {pipe.video.done ? '✅ done · ' : ''}video t={pipe.video.videoTime}s · raw frame {pipe.video.rawFrame}/{pipe.video.total}
                  · sampling every <b className="text-white">{pipe.video.sampleEvery}</b> frames (= {pipe.video.targetFps} fps at {speed} km/h)
                </div>
              )}
            </div>
          )}
          {pipe.error && <div className="text-xs text-red-300 bg-red-900/30 rounded-lg p-2">{pipe.error}</div>}

          {/* Speed → frame rate */}
          <div className="rounded-xl border border-white/10 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-gray-300"><span className="flex items-center gap-1.5"><Gauge className="w-4 h-4" />Speed → capture rate (Model 1)</span><span className="text-lg text-white tabular-nums">{speed} km/h</span></div>
            <input type="range" min={0} max={120} value={speed} onChange={(e) => setSpeed(+e.target.value)} className="w-full accent-blue-500" />
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-white/5 rounded-lg py-1.5"><div className="text-lg font-bold text-sky-300">{policy?.target_fps ?? '—'}</div><div className="text-[10px] text-gray-500">target fps</div></div>
              <div className="bg-white/5 rounded-lg py-1.5"><div className="text-lg font-bold">{st?.measured_capture_fps ?? '—'}</div><div className="text-[10px] text-gray-500">measured fps</div></div>
              <div className="bg-white/5 rounded-lg py-1.5"><div className="text-lg font-bold">{policy?.interval_ms ?? '—'}</div><div className="text-[10px] text-gray-500">ms / frame</div></div>
            </div>
            <div className="text-[11px] text-gray-500">{policy?.reason}</div>
          </div>

          {/* Position, heading, IMU, V2X */}
          <div className="rounded-xl border border-white/10 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between font-semibold text-gray-300">
              <span className="flex items-center gap-1.5"><Navigation2 className="w-4 h-4" />Position · heading · IMU</span>
              <button onClick={useGps} className="flex items-center gap-1 text-sky-300"><LocateFixed className="w-3.5 h-3.5" />GPS</button>
            </div>
            <div className="font-mono text-gray-200">{pos ? `${pos[0].toFixed(6)}, ${pos[1].toFixed(6)}` : '—'} · heading {heading}°</div>
            <form className="flex gap-1.5" onSubmit={(e) => {
              e.preventDefault();
              const [la, lo] = posInput.split(',').map((s) => parseFloat(s.trim()));
              if (!Number.isNaN(la) && !Number.isNaN(lo)) setPos([la, lo]);
            }}>
              <input value={posInput} onChange={(e) => setPosInput(e.target.value)} placeholder="lat, lon (copy from the other car)"
                     className="flex-1 bg-white/10 rounded px-2 py-1 font-mono" />
              <button className="px-2.5 py-1 rounded bg-white/15 hover:bg-white/25">Set</button>
            </form>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-gray-500">move 5 m:</span>
              <button className="p-1.5 bg-white/10 rounded" onClick={() => nudge(0)}><ArrowUp className="w-3.5 h-3.5" /></button>
              <button className="p-1.5 bg-white/10 rounded" onClick={() => nudge(180)}><ArrowDown className="w-3.5 h-3.5" /></button>
              <button className="p-1.5 bg-white/10 rounded" onClick={() => nudge(270)}><ArrowLeft className="w-3.5 h-3.5" /></button>
              <button className="p-1.5 bg-white/10 rounded" onClick={() => nudge(90)}><ArrowRight className="w-3.5 h-3.5" /></button>
              <input type="number" value={heading} onChange={(e) => setHeading(((+e.target.value % 360) + 360) % 360)} className="w-16 bg-white/10 rounded px-2 py-1 ml-2" title="heading °" />
              <label className="flex items-center gap-1 ml-auto"><input type="checkbox" checked={simMove} onChange={(e) => setSimMove(e.target.checked)} />drive at speed</label>
            </div>
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-gray-400" /><span>IMU peak {imuLive.toFixed(1)} m/s²</span>
              <button onClick={() => { bumpUntil.current = Date.now() + 2500; }} className="ml-auto px-2.5 py-1 rounded bg-orange-600/80 hover:bg-orange-600">Simulate bump</button>
            </div>
            <div className="flex items-center gap-2 pt-1 border-t border-white/10">
              <Bluetooth className="w-3.5 h-3.5 text-sky-300" /><span className="text-gray-400">V2X test:</span>
              <button onClick={() => edge.v2xTest('pothole', 5)} className="px-2.5 py-1 rounded bg-sky-700 hover:bg-sky-600">BT broadcast pothole 5 m ahead</button>
            </div>
          </div>

          {/* Event feed */}
          <div className="rounded-xl border border-white/10 p-3">
            <div className="text-xs font-semibold text-gray-300 mb-2">Car event feed</div>
            <div className="space-y-1 max-h-72 overflow-y-auto text-[11px]">
              {ev.feed.length === 0 && <div className="text-gray-600">Reports, offline queue, Bluetooth, verification and FL events appear here.</div>}
              {ev.feed.map((f) => (
                <div key={f.id} className={FEED_TONE[f.tone]}><span className="text-gray-600 mr-1.5">{f.time}</span>{f.text}</div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: pipeline results ───────────────────────────────────── */}
        <div className="flex-1 p-4 min-w-0">
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
            {[
              ['captured', st?.frames_captured], ['processed', st?.frames_processed], ['skipped dup', st?.frames_skipped_duplicate],
              ['dropped busy', st?.frames_dropped_busy], ['compute saved', st ? `${st.compute_saving_pct}%` : undefined], ['target fps', policy?.target_fps],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-white/5 rounded-xl py-2 text-center"><div className="text-lg font-bold tabular-nums">{v ?? '—'}</div><div className="text-[10px] text-gray-500">{k}</div></div>
            ))}
          </div>

          {routing && (
            <div className={`mb-4 p-3 rounded-xl border ${ROUTE_STYLE[routing] ?? ROUTE_STYLE.DISCARD}`}>
              <div className="font-bold text-sm">
                {routing === 'HIGH' ? '🚨 HIGH — newly detected hazard reported (server or offline queue) + Bluetooth V2X broadcast'
                  : routing === 'MEDIUM' ? '⚠️ MEDIUM — ambiguous: driver asked to verify before anything is sent'
                  : '✅ No hazard above threshold — discarded'}
              </div>
              {pipe.lastResult?.hazard_type && <div className="text-xs opacity-80 mt-0.5">{pipe.lastResult.hazard_type.replace(/_/g, ' ')} · {pipe.lastResult.severity} · score {(pipe.lastResult.fusion_score * 100).toFixed(0)}%</div>}
              {(pipe.lastResult?.actions ?? []).map((a, i) => (
                <div key={i} className="text-[11px] opacity-80 mt-0.5">• {String(a.hazard_type)} #{String(a.track_id)}: {String(a.action)}{a.delivery ? ` → ${String(a.delivery)}` : ''}{a.cluster ? ` (cluster #${String(a.cluster)} ${String(a.cluster_action)})` : ''}{Array.isArray(a.bluetooth) && a.bluetooth.length ? ` · BT ${(a.bluetooth as string[]).join(', ')}` : ''}</div>
              ))}
            </div>
          )}

          <FusionPanel step={fusionStep} />

          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">On-car pipeline {pipe.processing && <span className="text-xs text-yellow-300 ml-2">processing…</span>}</div>
            <div className="flex gap-2 text-xs">
              <button className="text-sky-300" onClick={() => setOpen(new Set(Object.keys(STEPS).map(Number)))}>expand all</button>
              <button className="text-gray-400" onClick={() => setOpen(new Set())}>collapse</button>
            </div>
          </div>
          <div className="space-y-2 mb-6">
            {Object.keys(STEPS).map(Number).map((n) => <StepCard key={n} n={n} r={pipe.steps.get(n)} open={open.has(n)} onToggle={() => toggle(n)} />)}
          </div>

          <div className="rounded-xl border border-white/10 p-3">
            <div className="text-sm font-semibold mb-2 flex items-center gap-2"><Package className="w-4 h-4" />Offline queue / outbox on this car</div>
            <table className="w-full text-xs">
              <thead><tr className="text-gray-500 text-left"><th>#</th><th>Hazard</th><th>Score</th><th>Routing</th><th>Queued</th><th>Status</th><th>Server</th></tr></thead>
              <tbody>
                {outbox.length === 0 && <tr><td colSpan={7} className="text-gray-600 py-2">Nothing reported yet.</td></tr>}
                {outbox.map((o) => (
                  <tr key={o.id} className="border-t border-white/5">
                    <td>{o.id}</td>
                    <td className="capitalize">{o.summary.hazard_type?.replace(/_/g, ' ')}{o.summary.verified ? ' ✓driver' : ''}</td>
                    <td>{o.summary.fusion_score?.toFixed(2)}</td>
                    <td>{o.summary.routing}</td>
                    <td>{o.queued_offline ? <span className="text-amber-300">offline</span> : 'online'}</td>
                    <td className={o.status === 'sent' ? 'text-green-400' : 'text-amber-300'}>{o.status}</td>
                    <td>{o.server_response?.cluster_id ? `cluster #${o.server_response.cluster_id} (${o.server_response.cluster_action})` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
