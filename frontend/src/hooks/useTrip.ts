import { useState, useCallback } from 'react';
import { startTrip, endTrip, getTripSummary } from '../api/trips';
import type { TripSummary } from '../api/types';

const SESSION_KEY = 'vw_session_id';

export function useTrip() {
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem(SESSION_KEY),
  );
  const [tripId, setTripId] = useState<number | null>(null);
  const [summary, setSummary] = useState<TripSummary | null>(null);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const existing = sessionStorage.getItem(SESSION_KEY) ?? undefined;
      const res = await startTrip(existing);
      sessionStorage.setItem(SESSION_KEY, res.session_id);
      setSessionId(res.session_id);
      setTripId(res.trip_id);
      return res.session_id;
    } finally {
      setStarting(false);
    }
  }, []);

  const end = useCallback(
    async (stats?: {
      distance_km?: number;
      avg_speed_km?: number;
      hazards_avoided?: number;
      hazards_reported?: number;
    }) => {
      if (!sessionId) return null;
      setEnding(true);
      try {
        await endTrip({ session_id: sessionId, ...stats });
        const s = await getTripSummary(sessionId);
        setSummary(s);
        return s;
      } finally {
        setEnding(false);
      }
    },
    [sessionId],
  );

  return { sessionId, tripId, summary, starting, ending, start, end };
}
