import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchHazards } from '../api/hazards';
import type { Hazard, HazardType, Severity } from '../api/types';

interface Options {
  hazard_type?: HazardType;
  severity?: Severity;
  since_hours?: number;
  pollInterval?: number;   // ms — 0 or omitted = fetch once only
}

export function useHazards(opts: Options = {}) {
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Keep opts in a ref so the interval callback always uses current values
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const load = useCallback(() => {
    const { hazard_type, severity } = optsRef.current;
    fetchHazards()
      .then((r) => {
        setHazards(r.hazards.filter((h) => (!hazard_type || h.hazard_type === hazard_type) && (!severity || h.severity === severity)));
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const ms = opts.pollInterval ?? 0;
    if (ms > 0) {
      const id = setInterval(load, ms);
      return () => clearInterval(id);
    }
  }, [load, opts.pollInterval]);

  return { hazards, loading, error, reload: load };
}
