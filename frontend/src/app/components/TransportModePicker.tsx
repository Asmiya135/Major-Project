import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getAllModeDirections } from '../../api/olamaps';
import type { TransportMode, DirectionsResult } from '../../api/olamaps';

interface Props {
  origin:      { lat: number; lng: number };
  destination: { lat: number; lng: number };
  selected:    TransportMode;
  onSelect:    (mode: TransportMode, result: DirectionsResult) => void;
}

const MODES: { id: TransportMode; label: string; icon: string }[] = [
  { id: 'driving',  label: 'Car',     icon: '🚗' },
  { id: 'bike',     label: 'Bike',    icon: '🏍️' },
  { id: 'walking',  label: 'Walk',    icon: '🚶' },
  { id: 'transit',  label: 'Transit', icon: '🚌' },
];

export function TransportModePicker({ origin, destination, selected, onSelect }: Props) {
  const [results, setResults]   = useState<Record<TransportMode, DirectionsResult | null>>({
    driving: null, bike: null, walking: null, transit: null,
  });
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    setLoading(true);
    getAllModeDirections(origin, destination)
      .then((r) => {
        setResults(r);
        // Auto-select driving if not already set
        if (r.driving) onSelect('driving', r.driving);
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin.lat, origin.lng, destination.lat, destination.lng]);

  return (
    <div className="grid grid-cols-4 gap-2">
      {MODES.map(({ id, label, icon }) => {
        const res     = results[id];
        const active  = selected === id;
        return (
          <button
            key={id}
            disabled={loading || !res}
            onClick={() => res && onSelect(id, res)}
            className={`flex flex-col items-center p-2.5 rounded-xl border-2 transition-all text-center
              ${active
                ? 'border-[#001E50] bg-[#001E50]/5'
                : 'border-border bg-background hover:border-[#001E50]/40'
              }
              ${(!res && !loading) ? 'opacity-40 cursor-not-allowed' : ''}
            `}
          >
            <span className="text-2xl mb-1 leading-none">{icon}</span>
            <span className={`text-xs font-semibold ${active ? 'text-[#001E50]' : 'text-foreground'}`}>
              {label}
            </span>
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin text-muted-foreground mt-1" />
            ) : res ? (
              <>
                <span className={`text-xs mt-0.5 font-medium ${active ? 'text-[#001E50]' : 'text-muted-foreground'}`}>
                  {res.durationText}
                </span>
                <span className="text-[10px] text-muted-foreground">{res.distanceText}</span>
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground mt-1">N/A</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
