/**
 * GLOBAL SERVER console — what the one shared server holds: incoming reports (with
 * driver-verified photos), haversine clusters, connected cars and federated learning.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Brain, Layers, Server, Image as ImageIcon, Cpu } from 'lucide-react';
import { SERVER_BASE } from '../../api/client';
import { server, type DetectorJob, type RouteHazard, type ServerClient, type ServerModel, type ServerReport, type ServerUpdate } from '../../api/edge';
import { OlaMap, type HazardMarker } from '../components/OlaMap';

const FEATURES = ['detection_conf', 'track_persistence', 'seg_area', 'depth', 'on_road', 'optical_flow', 'imu_bump'];

export default function ServerConsole() {
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [clusters, setClusters] = useState<RouteHazard[]>([]);
  const [radius, setRadius] = useState(25);
  const [reports, setReports] = useState<ServerReport[]>([]);
  const [clients, setClients] = useState<ServerClient[]>([]);
  const [models, setModels] = useState<ServerModel[]>([]);
  const [updates, setUpdates] = useState<ServerUpdate[]>([]);
  const [jobs, setJobs] = useState<DetectorJob[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, h, r, c, f, j] = await Promise.all([server.stats(), server.hazards(), server.reports(30), server.clients(), server.rounds(), server.detectorJobs()]);
      setStats(s); setClusters(h.hazards); setRadius(h.cluster_radius_m); setReports(r.reports); setClients(c.clients);
      setModels(f.models); setUpdates(f.updates); setJobs(j.jobs); setErr('');
    } catch (e) { setErr(`Server not reachable at ${SERVER_BASE} (${String(e).slice(0, 60)})`); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setMsg(`${label}…`);
    try { setMsg(`${label}: ${JSON.stringify(await fn()).slice(0, 220)}`); } catch (e) { setMsg(`${label} failed: ${e}`); }
    load();
  };

  const markers: HazardMarker[] = clusters.map((c) => ({
    id: String(c.id), type: c.hazard_type as HazardMarker['type'], severity: c.severity as HazardMarker['severity'],
    latitude: c.latitude, longitude: c.longitude, reports: c.count, confidence: c.confidence,
    first_seen: c.first_seen, last_seen: c.last_seen, label: `cluster #${c.id} · ${c.count} reports${c.verified ? ' · verified' : ''}`,
  }));
  const current = models[0];
  const center: [number, number] = clusters.length ? [clusters[clusters.length - 1].longitude, clusters[clusters.length - 1].latitude] : [72.895, 19.082];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-[#001E50] text-white px-6 py-4 flex items-center gap-3">
        <Server className="w-6 h-6" />
        <div>
          <div className="font-bold">Global Server Console</div>
          <div className="text-xs opacity-70">{SERVER_BASE} · one server shared by every car</div>
        </div>
        <button onClick={load} className="ml-auto flex items-center gap-1.5 text-xs bg-white/10 px-3 py-1.5 rounded-lg"><RefreshCw className="w-3.5 h-3.5" />refresh</button>
      </div>
      {err && <div className="bg-red-100 text-red-700 text-sm px-6 py-2">{err}</div>}
      {msg && <div className="bg-blue-50 text-blue-800 text-xs px-6 py-2 font-mono break-all">{msg}</div>}

      <div className="p-6 space-y-6 max-w-[1500px] mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {[
            ['Cars', stats?.clients], ['Reports', stats?.reports], ['Driver-verified', stats?.reports_verified],
            ['From offline queues', stats?.reports_from_offline_queue], ['Hazard clusters', stats?.clusters],
            ['Cluster radius', stats ? `${stats.cluster_radius_m} m` : undefined], ['Fusion model', stats ? `v${stats.model_version}` : undefined],
            ['Pending FL updates', stats?.pending_fl_updates],
          ].map(([k, v]) => (
            <div key={String(k)} className="bg-white rounded-xl border p-3 text-center shadow-sm">
              <div className="text-2xl font-bold text-[#001E50]">{v ?? '—'}</div><div className="text-[11px] text-gray-500">{k}</div>
            </div>
          ))}
        </div>

        {/* Clustering */}
        <div className="grid lg:grid-cols-2 gap-6">
          <section className="bg-white rounded-xl border p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Layers className="w-4 h-4" /><h2 className="font-semibold">Haversine clusters (alerted once each)</h2>
              <button onClick={() => act('DBSCAN recluster', () => server.recluster())} className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-[#001E50] text-white">Run DBSCAN recluster</button>
            </div>
            <div className="h-72 rounded-lg overflow-hidden mb-3"><OlaMap center={center} zoom={15} hazards={markers} className="rounded-none" /></div>
            <p className="text-xs text-gray-500 mb-2">
              Every new report joins the nearest same-type cluster within {radius} m (haversine) or starts a new one.
              Many potholes on a bad stretch → one cluster → one alert to drivers.
            </p>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-500"><th>#</th><th>Type</th><th>Reports</th><th>Spread</th><th>Severity</th><th>Conf</th><th>Verified</th><th>Last seen</th></tr></thead>
                <tbody>{clusters.slice().reverse().map((c) => (
                  <tr key={c.id} className="border-t"><td>{c.id}</td><td className="capitalize">{c.hazard_type.replace(/_/g, ' ')}</td><td>{c.count}</td>
                    <td>{(c as RouteHazard & { radius_m?: number }).radius_m ?? 0} m</td><td>{c.severity}</td><td>{c.confidence.toFixed(2)}</td><td>{c.verified ? '✓' : ''}</td><td>{c.last_seen?.slice(11)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          {/* Federated learning */}
          <section className="bg-white rounded-xl border p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <Brain className="w-4 h-4" /><h2 className="font-semibold">Federated learning — fusion engine (FedAvg)</h2>
              <button onClick={() => act('FedAvg aggregate', () => server.aggregate())} className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-purple-700 text-white">Aggregate now</button>
            </div>
            {current && (
              <>
                <div className="text-xs text-gray-500 mb-2">Global model <b>v{current.version}</b> · {current.n_updates} updates · {current.n_samples} samples · {current.created_at} — cars download this on every sync</div>
                <table className="w-full text-xs mb-3">
                  <thead><tr className="text-left text-gray-500"><th>signal</th>{models.slice(0, 4).map((m) => <th key={m.version}>v{m.version}</th>)}</tr></thead>
                  <tbody>
                    {FEATURES.map((f, i) => (
                      <tr key={f} className="border-t"><td>{f.replace(/_/g, ' ')}</td>{models.slice(0, 4).map((m) => <td key={m.version} className="tabular-nums">{m.weights[i]?.toFixed(3)}</td>)}</tr>
                    ))}
                    <tr className="border-t"><td>bias</td>{models.slice(0, 4).map((m) => <td key={m.version} className="tabular-nums">{m.bias.toFixed(3)}</td>)}</tr>
                  </tbody>
                </table>
                <div className="text-xs bg-purple-50 rounded-lg p-2.5 mb-3">
                  <div className="font-semibold mb-1">Performance measures sent to cars with v{current.version}</div>
                  <pre className="whitespace-pre-wrap text-[11px]">{JSON.stringify(current.metrics, null, 1)}</pre>
                </div>
              </>
            )}
            <div className="text-xs font-semibold mb-1">Client updates (weights only — raw driver answers never leave the car)</div>
            <div className="max-h-40 overflow-y-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-500"><th>#</th><th>Car</th><th>Base</th><th>Samples</th><th>Local acc</th><th>→ model</th></tr></thead>
                <tbody>{updates.map((u) => (
                  <tr key={u.id} className="border-t"><td>{u.id}</td><td>{u.client_id}</td><td>v{u.base_version}</td><td>{u.n_samples}</td>
                    <td>{u.local_metrics?.accuracy_before} → {u.local_metrics?.accuracy}</td><td>{u.aggregated_into ? `v${u.aggregated_into}` : 'pending'}</td></tr>
                ))}</tbody>
              </table>
            </div>

            <div className="flex items-center gap-2 mt-4 mb-2 flex-wrap">
              <Cpu className="w-4 h-4" /><span className="font-semibold text-sm">Detector fine-tune on verified photos</span>
              <button onClick={() => act('Detector training', () => server.trainDetector())} className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-slate-700 text-white">Train detector</button>
            </div>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-500"><th>Version</th><th>Status</th><th>Photos</th><th>Metrics / error</th></tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.version} className="border-t align-top"><td>v{j.version}</td><td>{j.status}</td><td>{j.n_images ?? '—'}</td>
                  <td className="text-[11px]">{j.error ?? (j.metrics ? Object.entries(j.metrics).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(' · ') : '')}</td></tr>
              ))}</tbody>
            </table>
          </section>
        </div>

        {/* Reports */}
        <section className="bg-white rounded-xl border p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3"><ImageIcon className="w-4 h-4" /><h2 className="font-semibold">Incoming reports (privacy-blurred photos)</h2></div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {reports.map((r) => (
              <div key={r.id} className="border rounded-lg overflow-hidden text-xs">
                {r.image_file ? <img src={`${SERVER_BASE}/images/${r.image_file}`} alt="" className="w-full h-36 object-cover bg-gray-100" /> : <div className="h-36 bg-gray-100" />}
                <div className="p-2 space-y-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <b className="capitalize">{r.hazard_type.replace(/_/g, ' ')}</b>
                    <span className="px-1.5 rounded bg-gray-100">{r.routing}</span>
                    {r.verified ? <span className="px-1.5 rounded bg-green-100 text-green-700">driver-verified</span> : null}
                    {r.was_offline ? <span className="px-1.5 rounded bg-amber-100 text-amber-700">from offline queue</span> : null}
                  </div>
                  <div className="text-gray-500">{r.client_id} · score {r.fusion_score?.toFixed(2)} · cluster #{r.cluster_id}</div>
                  <div className="text-gray-500">{String(r.metrics?.surface ?? '')} · {String(r.metrics?.distance_m ?? '?')} m · depth ~{String(r.metrics?.depth_cm ?? '?')} cm</div>
                  <div className="text-gray-400">{r.received_at}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-white rounded-xl border p-4 shadow-sm">
          <h2 className="font-semibold mb-2">Cars (clients)</h2>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th>Car</th><th>Reports</th><th>Model version</th><th>Last seen</th></tr></thead>
            <tbody>{clients.map((c) => <tr key={c.client_id} className="border-t"><td>{c.name}</td><td>{c.reports}</td><td>v{c.model_version}</td><td>{c.last_seen}</td></tr>)}</tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
