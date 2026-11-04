import { useState } from 'react';
import { Wifi, WifiOff, Bluetooth, Package, Brain, Car } from 'lucide-react';
import { edge, type EdgeStatus } from '../../api/edge';

/** One-line status of this car: network (with the demo offline switch), queue, Bluetooth, FL model. */
export function CarStatusBar({ status, connected }: { status: EdgeStatus | null; connected: boolean }) {
  const [busy, setBusy] = useState(false);
  if (!status) {
    return (
      <div className="px-4 py-2 bg-red-900/40 text-red-200 text-xs">
        {connected ? 'Waiting for car status…' : 'Car edge agent not reachable — start it (start_demo.bat) and check ?edge= port'}
      </div>
    );
  }
  const toggle = async () => {
    setBusy(true);
    try { await edge.setNetwork(!status.forced_offline); } finally { setBusy(false); }
  };
  const bt = status.bt;
  const btOn = bt?.rfcomm?.listening || bt?.sim?.listening;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-black/40 border-b border-white/10 text-xs text-white">
      <span className="flex items-center gap-1.5 font-semibold"><Car className="w-4 h-4" />{status.client_name}</span>

      <button onClick={toggle} disabled={busy}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold ${status.online ? 'bg-green-600/80 hover:bg-green-600' : 'bg-amber-600/80 hover:bg-amber-600'}`}
        title={`Demo switch: simulate losing / regaining network\nServer: ${status.server_url}${status.last_sync_error ? `\nLast error: ${status.last_sync_error}` : ''}`}>
        {status.online ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
        {status.online ? 'ONLINE' : status.forced_offline ? 'OFFLINE (simulated)' : 'OFFLINE (server unreachable)'}
        <span className="opacity-70 font-normal">· click to {status.forced_offline ? 'reconnect' : 'go offline'}</span>
      </button>

      <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${status.outbox.queued ? 'bg-amber-500/30 text-amber-200' : 'bg-white/10'}`}>
        <Package className="w-3.5 h-3.5" />queue {status.outbox.queued} · sent {status.outbox.sent}
        {status.outbox.sent_after_offline > 0 && ` (${status.outbox.sent_after_offline} after offline)`}
      </span>

      <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${btOn ? 'bg-blue-600/40' : 'bg-red-600/40'}`}
        title={`RFCOMM: ${bt?.rfcomm?.listening ? bt.rfcomm.address : bt?.rfcomm?.error}\nSim: ${bt?.sim?.group}`}>
        <Bluetooth className="w-3.5 h-3.5" />
        BT {bt?.rfcomm?.listening ? `RFCOMM ${bt.rfcomm.address}` : ''}{bt?.rfcomm?.listening && bt?.sim?.listening ? ' + ' : ''}{bt?.sim?.listening ? 'sim' : ''}
        · {status.v2x_radius_m} m geofence · ↑{bt?.sent ?? 0} ↓{bt?.received ?? 0}
      </span>

      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-600/30">
        <Brain className="w-3.5 h-3.5" />fusion v{status.fusion_model.version} ({status.fusion_model.source})
        · FL samples {status.fl_samples}{status.fl_unpushed ? ` (${status.fl_unpushed} new)` : ''}
        {status.fusion_model.detector_version ? ` · detector v${status.fusion_model.detector_version}` : ''}
      </span>
    </div>
  );
}
