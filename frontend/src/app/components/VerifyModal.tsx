import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, ThumbsUp, ThumbsDown, HelpCircle, Sparkles, Loader2 } from 'lucide-react';
import { edge } from '../../api/edge';
import { speak, type VerifyRequest } from '../../hooks/useEdgeEvents';

/**
 * Human-in-the-loop for MEDIUM-confidence hazards: the driver sees the photo, hears the
 * GenAI question, and answers by voice (Whisper on the car) or with a button.
 */
export function VerifyModal({ req, pending, onDone }: { req: VerifyRequest; pending: number; onDone: (id: number) => void }) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const spokenRef = useRef<string>('');

  useEffect(() => {
    if (req.question && spokenRef.current !== req.question && (!req.generating || !spokenRef.current)) {
      spokenRef.current = req.question;
      speak(req.question);
    }
  }, [req.question, req.generating]);

  const finish = (text: string) => {
    setResult(text);
    setTimeout(() => { setResult(null); onDone(req.verify_id); }, 1600);
  };

  const answer = async (r: 'yes' | 'no' | 'unsure') => {
    setBusy(true);
    try { await edge.verifyAnswer(req.verify_id, r); finish(r === 'yes' ? '✓ Confirmed — sent as verified hazard' : r === 'no' ? '✗ Dismissed — kept only as a local learning sample' : '? Marked unsure'); }
    catch (e) { setResult(String(e)); } finally { setBusy(false); }
  };

  const startRec = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (!stream) { setResult('Microphone unavailable — use the buttons'); return; }
    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setBusy(true);
      try {
        const r = await edge.verifyVoice(req.verify_id, new Blob(chunks, { type: 'audio/webm' }));
        finish(`You said "${r.transcript}" → ${r.response}`);
      } catch (e) { setResult(`Voice failed (${String(e).slice(0, 80)}) — use the buttons`); }
      finally { setBusy(false); }
    };
    recRef.current = mr;
    mr.start();
    setRecording(true);
  };
  const stopRec = () => { recRef.current?.stop(); setRecording(false); };

  const m = req.metrics as Record<string, string | number | boolean>;
  return (
    <div className="fixed inset-0 z-[1000] bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-[#111827] text-white rounded-2xl overflow-hidden shadow-2xl border border-yellow-500/40">
        <div className="px-5 py-3 bg-yellow-500/15 flex items-center justify-between">
          <div className="font-semibold text-yellow-300 text-sm">Driver verification · MEDIUM confidence</div>
          <div className="text-xs text-yellow-200/70">{pending > 1 ? `${pending} waiting` : 'not sent to server yet'}</div>
        </div>
        <img src={`data:image/jpeg;base64,${req.image_b64}`} alt="possible hazard" className="w-full max-h-72 object-contain bg-black" />
        <div className="p-5">
          <div className="flex items-start gap-2 mb-3">
            {req.generating ? <Loader2 className="w-4 h-4 mt-1 animate-spin text-purple-300 shrink-0" /> : <Sparkles className="w-4 h-4 mt-1 text-purple-300 shrink-0" />}
            <p className="text-base leading-snug">{req.question}</p>
          </div>
          <div className="text-[11px] text-gray-400 mb-3">
            Question by {req.generating ? 'GenAI (generating…)' : req.question_source === 'template' ? 'template (no GenAI key/network)' : `GenAI · ${req.question_source}`}
            {' · '}{req.hazard_type.replace(/_/g, ' ')} · fusion {(req.fusion_score * 100).toFixed(0)}% · {String(m.lane ?? '')} · ~{String(m.distance_m ?? '?')} m · {String(m.surface ?? '')}
          </div>

          {result ? (
            <div className="text-center py-3 text-sm font-semibold text-green-300">{result}</div>
          ) : (
            <>
              <button
                onMouseDown={startRec} onMouseUp={stopRec} onTouchStart={startRec} onTouchEnd={stopRec} disabled={busy}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold mb-2 ${recording ? 'bg-red-600 animate-pulse' : 'bg-yellow-600 hover:bg-yellow-700'} disabled:opacity-50`}>
                {recording ? <><MicOff className="w-4 h-4" />Listening… release to send</> : <><Mic className="w-4 h-4" />Hold and say "yes" or "no"</>}
              </button>
              <div className="grid grid-cols-3 gap-2">
                <button disabled={busy} onClick={() => answer('yes')} className="py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"><ThumbsUp className="w-4 h-4" />Yes</button>
                <button disabled={busy} onClick={() => answer('no')} className="py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"><ThumbsDown className="w-4 h-4" />No</button>
                <button disabled={busy} onClick={() => answer('unsure')} className="py-2.5 rounded-xl bg-gray-600 hover:bg-gray-500 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"><HelpCircle className="w-4 h-4" />Unsure</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
