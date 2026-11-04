import { useEffect } from 'react';
import { Bluetooth, MapPin, X } from 'lucide-react';
import type { BtAlert } from '../../hooks/useEdgeEvents';

/** Full-width "hazard ahead" banner for Bluetooth V2X alerts and known-route-hazard alerts. */
export function AlertBanner({ bt, route, onCloseBt, onCloseRoute }: {
  bt: BtAlert | null;
  route: { message: string } | null;
  onCloseBt: () => void;
  onCloseRoute: () => void;
}) {
  useEffect(() => { if (bt) { const t = setTimeout(onCloseBt, 12000); return () => clearTimeout(t); } }, [bt, onCloseBt]);
  useEffect(() => { if (route) { const t = setTimeout(onCloseRoute, 9000); return () => clearTimeout(t); } }, [route, onCloseRoute]);
  if (!bt && !route) return null;
  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[900] w-[min(680px,94vw)] space-y-2">
      {bt && (
        <div className="flex items-start gap-3 bg-red-600 text-white rounded-xl px-4 py-3 shadow-2xl animate-pulse">
          <Bluetooth className="w-6 h-6 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-bold">{bt.message}</div>
            <div className="text-xs opacity-85">
              V2X over {bt.transport} · {bt.distance_m} m away (inside {bt.radius_m} m haversine geofence) · works with no network
            </div>
          </div>
          <button onClick={onCloseBt}><X className="w-4 h-4" /></button>
        </div>
      )}
      {route && (
        <div className="flex items-start gap-3 bg-orange-500 text-white rounded-xl px-4 py-3 shadow-2xl">
          <MapPin className="w-6 h-6 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-bold">{route.message}</div>
            <div className="text-xs opacity-85">Known hazard on your route (downloaded from server, alerted once per cluster)</div>
          </div>
          <button onClick={onCloseRoute}><X className="w-4 h-4" /></button>
        </div>
      )}
    </div>
  );
}
