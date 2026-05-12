import { useState, useEffect } from 'react';
import { fetchHazards } from '../api/hazards';
import type { Hazard, HazardType, Severity } from '../api/types';

interface Options {
  hazard_type?: HazardType;
  severity?: Severity;
  since_hours?: number;
  pollInterval?: number;   // ms, 0 = no polling
}

export function useHazards(opts: Options = {}) {
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetchHazards(opts)
      .then((r) => {
        setHazards(r.hazards);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    if (opts.pollInterval && opts.pollInterval > 0) {
      const id = setInterval(load, opts.pollInterval);
      return () => clearInterval(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { hazards, loading, error, reload: load };
}
