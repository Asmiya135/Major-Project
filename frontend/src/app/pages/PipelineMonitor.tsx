import { useState, useRef, useCallback, useEffect } from 'react';
import { usePipelineStream, type StepResult } from '../../hooks/usePipelineStream';
import { OlaMap, type HazardMarker } from '../components/OlaMap';
import { Wifi, WifiOff, Play, Square, Upload, Camera, ChevronDown, ChevronRight, Mic, MicOff } from 'lucide-react';

const STEP_LABELS: Record<number, { name: string; desc: string; icon: string }> = {
  1:  { name: 'AKS',          icon: '🎞️', desc: 'Adaptive Keyframe Sampling — drops redundant frames' },
  2:  { name: 'Composite',    icon: '🖼️', desc: 'Multi-camera stitching + fisheye correction + IPM' },
  3:  { name: 'Dehaze',       icon: '🌫️', desc: 'AOD-Net haze removal for foggy/low-visibility frames' },
  4:  { name: 'Privacy',      icon: '🔒', desc: 'Face + license plate Gaussian blur (on-device)' },
  5:  { name: 'H4 Road Mask', icon: '🛣️', desc: 'Fast-SCNN semantic segmentation — drivable surface' },
  6:  { name: 'H3 Depth',     icon: '📐', desc: 'MiDaS monocular depth estimation' },
  7:  { name: 'H2 Segment',   icon: '🎯', desc: 'YOLOv8 pixel-level pothole segmentation + area' },
  8:  { name: 'H1 Detect',    icon: '🔍', desc: 'YOLOv10 object detection (potholes, debris, bumps)' },
  9:  { name: 'H5 Tracking',  icon: '🚗', desc: 'SORT + Kalman filter — stalled vehicle detection' },
  10: { name: 'Fusion',       icon: '⚡', desc: 'Weighted fusion: 40% detection + 20% road + 20% depth + 20% tracking' },
  11: { name: 'Alert',        icon: '📡', desc: 'HIGH → persist + alert · MEDIUM → human verify · LOW → discard' },
};

const STATUS_COLOR: Record<string, string> = {
  pending:   '#6b7280',
  running:   '#f59e0b',
  done:      '#10b981',
  enhanced:  '#10b981',
  processed: '#10b981',
  skipped:   '#6b7280',
  error:     '#ef4444',
  HIGH:      '#ef4444',
  MEDIUM:    '#f59e0b',
  DISCARD:   '#6b7280',
  created:   '#10b981',
  merged:    '#3b82f6',
  discarded: '#6b7280',
  AKS_SKIP:  '#6b7280',
};

const ROUTING_BG: Record<string, string> = {
  HIGH:    'bg-red-100 text-red-700 border-red-300',
  MEDIUM:  'bg-yellow-100 text-yellow-700 border-yellow-300',
  DISCARD: 'bg-gray-100 text-gray-500 border-gray-300',
};

const SESSION_KEY = 'vw_pipeline_session';

function genSession() {
  return `monitor-${Date.now()}`;
}

// ── Step card ──────────────────────────────────────────────────────────────

function StepCard({ step, result }: { step: number; result?: StepResult }) {
  const [expanded, setExpanded] = useState(false);
  const meta  = STEP_LABELS[step];
  const done  = result && result.status !== 'running';
  const color = done ? (STATUS_COLOR[result.status] ?? '#10b981') : result ? '#f59e0b' : '#6b7280';
  const images = result?.data?.images as Record<string,string> | undefined;

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-white shadow-sm">
      {/* Header row */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
        onClick={() => done && setExpanded((e) => !e)}
      >
        {/* Status dot */}
        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
             style={{ background: color, boxShadow: result?.status === 'running' ? `0 0 6px ${color}` : 'none' }} />

        {/* Step number */}
        <span className="text-xs font-mono text-muted-foreground w-5">{step}</span>

        {/* Icon + name */}
        <span className="text-base leading-none">{meta?.icon}</span>
        <span className="text-sm font-semibold flex-1">{meta?.name}</span>

        {/* Duration */}
        {result?.duration_ms !== undefined && result.duration_ms > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{result.duration_ms} ms</span>
        )}

        {/* Running spinner */}
        {result?.status === 'running' && (
          <div className="w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
        )}

        {/* Expand arrow */}
        {done && images && (
          expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> :
                     <ChevronRight className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {/* Expanded detail */}
      {expanded && done && (
        <div className="px-4 pb-4 border-t border-border bg-gray-50">
          <p className="text-xs text-muted-foreground py-2">{meta?.desc}</p>

          {/* Images */}
          {images && Object.keys(images).length > 0 && (
            <div className={`grid gap-3 mb-3 ${Object.keys(images).length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {Object.entries(images).map(([key, b64]) => (
                <div key={key}>
                  <div className="text-xs text-muted-foreground mb-1 capitalize">{key.replace('_', ' ')}</div>
                  <img
                    src={`data:image/jpeg;base64,${b64}`}
                    alt={key}
                    className="w-full rounded-lg border border-border object-cover"
                    style={{ maxHeight: 200 }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Metrics */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(result?.data ?? {}).filter(([k]) => k !== 'images').map(([k, v]) => {
              if (typeof v === 'object') return null;
              return (
                <div key={k} className="flex justify-between text-xs py-0.5">
                  <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                  <span className="font-medium tabular-nums">
                    {typeof v === 'boolean' ? (v ? '✓' : '✗') : String(v)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Component scores for fusion */}
          {step === 10 && result?.data?.component_scores && (
            <div className="mt-3">
              <div className="text-xs font-medium mb-2">Component scores</div>
              {Object.entries(result.data.component_scores as Record<string,number>).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs text-muted-foreground w-20 capitalize">{k}</span>
                  <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-[#001E50] rounded-full transition-all duration-500"
                         style={{ width: `${(v as number) * 100}%` }} />
                  </div>
                  <span className="text-xs font-mono w-8 text-right">{((v as number)*100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function PipelineMonitor() {
  const [sessionId]  = useState(() => sessionStorage.getItem(SESSION_KEY) ?? (() => {
    const s = genSession();
    sessionStorage.setItem(SESSION_KEY, s);
    return s;
  })());

  const { connected, steps, lastResult, hazards, voiceResult, processing, sendFrame, sendVoice }
    = usePipelineStream(sessionId);

  const videoRef      = useRef<HTMLVideoElement>(null);
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const mediaRef      = useRef<MediaStream | null>(null);
  const captureTimer  = useRef<ReturnType<typeof setInterval> | null>(null);

  const [videoSrc,   setVideoSrc]   = useState<string | null>(null);
  const [useWebcam,  setUseWebcam]  = useState(false);
  const [running,    setRunning]    = useState(false);
  const [captureHz,  setCaptureHz]  = useState(1);        // frames per second to send
  const [recording,  setRecording]  = useState(false);    // microphone recording
  const [audioChunks, setAudioChunks] = useState<Blob[]>([]);
  const mediaRecRef   = useRef<MediaRecorder | null>(null);
  const [pendingVoice, setPendingVoice] = useState<number | null>(null);  // hazard_id awaiting voice

  // ── Frame capture & send ─────────────────────────────────────────────────
  const captureAndSend = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !connected) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width  = 640;
    canvas.height = Math.round(640 * (video.videoHeight / (video.videoWidth || 1)));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const b64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    sendFrame(b64, 19.076, 72.877, 40);
  }, [connected, sendFrame]);

  const startCapture = useCallback(() => {
    if (captureTimer.current) clearInterval(captureTimer.current);
    setRunning(true);
    captureAndSend();
    captureTimer.current = setInterval(captureAndSend, Math.round(1000 / captureHz));
  }, [captureAndSend, captureHz]);

  const stopCapture = useCallback(() => {
    if (captureTimer.current) { clearInterval(captureTimer.current); captureTimer.current = null; }
    setRunning(false);
  }, []);

  useEffect(() => () => { stopCapture(); }, [stopCapture]);

  // ── File upload ──────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    stopCapture();
    if (mediaRef.current) { mediaRef.current.getTracks().forEach((t) => t.stop()); mediaRef.current = null; }
    setUseWebcam(false);
    setVideoSrc(URL.createObjectURL(file));
  };

  // ── Webcam ───────────────────────────────────────────────────────────────
  const toggleWebcam = async () => {
    if (useWebcam) {
      stopCapture();
      mediaRef.current?.getTracks().forEach((t) => t.stop());
      mediaRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setUseWebcam(false);
    } else {
      stopCapture();
      setVideoSrc(null);
      const stream = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
      if (!stream) return;
      mediaRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
      setUseWebcam(true);
    }
  };

  // ── Microphone recording (voice verify) ─────────────────────────────────
  const startRecording = async (hazardId: number) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (!stream) return;
    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    mr.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const ab   = await blob.arrayBuffer();
      const b64  = btoa(String.fromCharCode(...new Uint8Array(ab)));
      sendVoice(b64, hazardId);
      stream.getTracks().forEach((t) => t.stop());
    };
    mediaRecRef.current = mr;
    mr.start();
    setRecording(true);
    setPendingVoice(hazardId);
    setAudioChunks(chunks);
  };

  const stopRecording = () => {
    mediaRecRef.current?.stop();
    setRecording(false);
  };

  // ── Derived hazard markers for map ───────────────────────────────────────
  const mapMarkers: HazardMarker[] = hazards.map((h) => ({
    id:        String(h.id),
    type:      h.hazard_type as HazardMarker['type'],
    severity:  h.severity    as HazardMarker['severity'],
    latitude:  h.latitude,
    longitude: h.longitude,
    reports:   h.count,
  }));

  const stepNums  = [1,2,3,4,5,6,7,8,9,10,11];
  const routeRes  = lastResult?.routing;
  const needsVerify = lastResult?.routing === 'MEDIUM' && lastResult.hazard_id;

  return (
    <div className="w-full min-h-screen bg-[#0f172a] text-white" style={{ fontFamily: 'system-ui,sans-serif' }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-4 bg-black/40 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#001E50] rounded-lg flex items-center justify-center text-xs font-bold">VW</div>
          <div>
            <div className="text-sm font-bold">Pipeline Monitor</div>
            <div className="text-xs text-gray-400">Engineering dashboard — 11-step hazard detection</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {connected
            ? <div className="flex items-center gap-1.5 text-green-400 text-xs"><Wifi className="w-4 h-4" />Live</div>
            : <div className="flex items-center gap-1.5 text-yellow-400 text-xs"><WifiOff className="w-4 h-4" />Reconnecting</div>
          }
          <div className="text-xs text-gray-500 font-mono">{sessionId.slice(0, 16)}</div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-0 h-[calc(100vh-64px)]">

        {/* ── Left: Video input + map ───────────────────────────────────── */}
        <div className="w-full lg:w-[380px] flex flex-col border-r border-white/10 flex-shrink-0">

          {/* Video input */}
          <div className="p-4 border-b border-white/10">
            <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wider">Video Input</div>

            {/* Video + canvas (hidden) */}
            <div className="aspect-video bg-black rounded-xl overflow-hidden mb-3 relative">
              <video ref={videoRef} src={videoSrc ?? undefined} muted loop
                     className="w-full h-full object-cover"
                     onLoadedData={() => {}} />
              {!videoSrc && !useWebcam && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 gap-2">
                  <span className="text-4xl">🎥</span>
                  <span className="text-sm">Upload video or use webcam</span>
                </div>
              )}
              {processing && (
                <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 bg-black/70 rounded text-xs">
                  <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                  Processing…
                </div>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />

            {/* Controls */}
            <div className="flex gap-2 mb-3">
              <button onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-2 bg-[#001E50] hover:bg-[#001E50]/80 rounded-lg text-xs font-medium flex-1 justify-center">
                <Upload className="w-3.5 h-3.5" />Upload
              </button>
              <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
              <button onClick={toggleWebcam}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium flex-1 justify-center ${useWebcam ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-700 hover:bg-gray-600'}`}>
                <Camera className="w-3.5 h-3.5" />{useWebcam ? 'Stop Cam' : 'Webcam'}
              </button>
            </div>

            {/* Capture rate */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs text-gray-400">Rate:</span>
              {[0.5, 1, 2, 5].map((hz) => (
                <button key={hz} onClick={() => setCaptureHz(hz)}
                  className={`px-2 py-0.5 rounded text-xs ${captureHz === hz ? 'bg-[#001E50] text-white' : 'bg-gray-800 text-gray-400'}`}>
                  {hz} fps
                </button>
              ))}
            </div>

            {/* Start / stop */}
            {!running ? (
              <button onClick={startCapture} disabled={!connected || (!videoSrc && !useWebcam)}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
                <Play className="w-4 h-4" />Start Processing
              </button>
            ) : (
              <button onClick={stopCapture}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-semibold">
                <Square className="w-4 h-4" />Stop
              </button>
            )}
          </div>

          {/* Voice verification panel (shown when MEDIUM confidence) */}
          {needsVerify && (
            <div className="p-4 border-b border-white/10 bg-yellow-900/20">
              <div className="text-xs font-semibold text-yellow-400 mb-2 uppercase tracking-wider">⚠ Human Verification Required</div>
              <p className="text-xs text-gray-300 mb-3">
                Medium confidence ({(lastResult!.fusion_score * 100).toFixed(0)}%) — Is this a real <b>{lastResult?.hazard_type}</b>?
              </p>
              {voiceResult ? (
                <div className="space-y-1 text-xs">
                  <div className="text-gray-400">Transcript: <span className="text-white">"{voiceResult.transcript}"</span></div>
                  <div className={`font-bold ${voiceResult.response === 'yes' ? 'text-green-400' : voiceResult.response === 'no' ? 'text-red-400' : 'text-yellow-400'}`}>
                    Response: {voiceResult.response.toUpperCase()}
                  </div>
                </div>
              ) : (
                <button
                  onMouseDown={() => startRecording(lastResult!.hazard_id!)}
                  onMouseUp={stopRecording}
                  onTouchStart={() => startRecording(lastResult!.hazard_id!)}
                  onTouchEnd={stopRecording}
                  className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold ${recording ? 'bg-red-600 animate-pulse' : 'bg-yellow-600 hover:bg-yellow-700'}`}
                >
                  {recording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  {recording ? 'Recording… Release to send' : 'Hold to speak (Yes / No)'}
                </button>
              )}
            </div>
          )}

          {/* Hazard map — real data from backend */}
          <div className="flex-1 min-h-0 p-3">
            <div className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">
              Live Hazard Map ({hazards.length} hazards)
            </div>
            <div className="h-full rounded-xl overflow-hidden" style={{ minHeight: 200 }}>
              <OlaMap
                center={[72.8777, 19.076]}
                zoom={12}
                hazards={mapMarkers}
                className="rounded-none"
              />
            </div>
          </div>
        </div>

        {/* ── Right: Step-by-step pipeline ─────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4">

          {/* Fusion result banner */}
          {routeRes && routeRes !== 'AKS_SKIP' && (
            <div className={`mb-4 p-3 rounded-xl border flex items-center gap-3 ${ROUTING_BG[routeRes] ?? 'bg-gray-100 text-gray-500 border-gray-300'}`}>
              <div className="text-2xl">
                {routeRes === 'HIGH' ? '🚨' : routeRes === 'MEDIUM' ? '⚠️' : '✅'}
              </div>
              <div>
                <div className="font-bold text-sm">
                  {routeRes === 'HIGH'    ? 'HIGH confidence — hazard saved & alerted'  :
                   routeRes === 'MEDIUM'  ? 'MEDIUM confidence — waiting for voice verification' :
                                           'LOW confidence — discarded'}
                </div>
                {lastResult?.hazard_type && (
                  <div className="text-xs opacity-75">
                    {lastResult.hazard_type} · {lastResult.severity} severity · score {(lastResult.fusion_score * 100).toFixed(0)}%
                  </div>
                )}
              </div>
            </div>
          )}

          {/* AKS stats summary */}
          {steps.get(1)?.data && (
            <div className="mb-4 grid grid-cols-3 gap-3">
              {[
                { label: 'Frames received',  value: steps.get(1)?.data?.frames_received as number },
                { label: 'Frames processed', value: steps.get(1)?.data?.frames_processed as number },
                { label: 'Compute saved',    value: `${steps.get(1)?.data?.compute_saving_pct}%` },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white/5 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold">{value ?? '—'}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Step cards */}
          <div className="space-y-2">
            {stepNums.map((n) => (
              <StepCard key={n} step={n} result={steps.get(n)} />
            ))}
          </div>

          {/* Empty state */}
          {steps.size === 0 && (
            <div className="text-center text-gray-500 mt-16">
              <div className="text-5xl mb-4">🔬</div>
              <div className="text-sm">Upload a video and click <b>Start Processing</b></div>
              <div className="text-xs mt-2 opacity-60">Each step will appear here with annotated images and metrics</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
