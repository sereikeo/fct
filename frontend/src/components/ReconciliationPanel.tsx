import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getReconciliation,
  postReconciliation,
  deleteReconciliation,
  getEnvelopes,
  QUERY_KEYS,
  ReconciliationRecord,
  EnvelopeWithOverride,
} from '../services/api';

const fmtAUDc = (n: number) =>
  (n < 0 ? '−A$' : 'A$') + Math.abs(n).toFixed(2);

interface AddFormProps {
  envelopes: EnvelopeWithOverride[];
  bucketFilter: 'all' | 'personal' | 'maple';
  onClose: () => void;
}

function AddForm({ envelopes, bucketFilter, onClose }: AddFormProps) {
  const qc = useQueryClient();
  const [budgetItemId, setBudgetItemId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [forecastAmount, setForecastAmount] = useState('');
  const [actualAmount, setActualAmount] = useState('');
  const [note, setNote] = useState('');

  const filtered = envelopes.filter(
    (e) => !e.deletedAt && (bucketFilter === 'all' || e.bucket === bucketFilter)
  );

  function handleItemChange(id: string) {
    setBudgetItemId(id);
    const env = envelopes.find((e) => e.id === id);
    if (env) setForecastAmount(String(env.forecastAmount));
  }

  const add = useMutation({
    mutationFn: () =>
      postReconciliation({
        budgetItemId, date,
        forecastAmount: parseFloat(forecastAmount),
        actualAmount: parseFloat(actualAmount),
        note: note || undefined,
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.reconciliation }); onClose(); },
  });

  const valid = budgetItemId && date && forecastAmount && actualAmount;
  const inputStyle: React.CSSProperties = {
    width: '100%', background: 'var(--paper)', border: '1px solid var(--line)',
    borderRadius: 8, padding: '5px 9px', fontSize: 12.5, color: 'var(--ink)',
    fontFamily: 'Inter, sans-serif', outline: 'none',
  };

  return (
    <div style={{ padding: '14px 20px', background: 'var(--paper-2)', borderBottom: '1px solid var(--line-2)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-2)', marginBottom: 10 }}>
        Add reconciliation
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>Budget item</div>
          <select value={budgetItemId} onChange={(e) => handleItemChange(e.target.value)} style={inputStyle}>
            <option value="">Select…</option>
            {filtered.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>Date</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>Note (optional)</div>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>Forecast</div>
          <input type="number" value={forecastAmount} onChange={(e) => setForecastAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>Actual</div>
          <input type="number" value={actualAmount} onChange={(e) => setActualAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => add.mutate()} disabled={!valid || add.isPending} style={{ fontSize: 12, padding: '6px 14px' }}>
          {add.isPending ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" onClick={onClose} style={{ fontSize: 12, padding: '6px 14px' }}>Cancel</button>
      </div>
    </div>
  );
}

export default function ReconciliationPanel({ bucketFilter = 'all' }: { bucketFilter?: 'all' | 'personal' | 'maple' }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: QUERY_KEYS.reconciliation, queryFn: getReconciliation });
  const { data: envData } = useQuery({ queryKey: QUERY_KEYS.envelopes, queryFn: getEnvelopes });

  const remove = useMutation({
    mutationFn: (id: string) => deleteReconciliation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.reconciliation }),
  });

  const envelopes = envData?.envelopes ?? [];
  const envelopeMap: Record<string, string> = {};
  for (const e of envelopes) envelopeMap[e.id] = e.name;

  const records: ReconciliationRecord[] = data?.records ?? [];

  return (
    <div className="card">
      <div className="hd">
        <h3>Reconcile variable spend</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="sub">paste · drop · upload</span>
          <button
            className="btn ghost"
            onClick={() => setShowForm(v => !v)}
            style={{ fontSize: 11, padding: '3px 10px' }}
          >
            + Add
          </button>
        </div>
      </div>

      {showForm && <AddForm envelopes={envelopes} bucketFilter={bucketFilter} onClose={() => setShowForm(false)} />}

      <div className="bd">
        <div className="drop" tabIndex={0}>
          <div className="dic">⎘</div>
          <div className="dt">Drop a screenshot, CSV, or PDF</div>
          <div className="ds">Parse rows, match to forecast bills, flag new variable-spend items for a category.</div>
          <div className="dh">supports PNG · JPG · PDF · CSV · Cmd+V to paste</div>
        </div>

        {records.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: 'var(--mute)', letterSpacing: '0.1em', textTransform: 'uppercase', textAlign: 'center', margin: '18px 0 10px' }}>
              last reconciled
            </div>
            {isLoading && <div className="kv"><span className="k">Loading…</span></div>}
            {records.slice(0, 5).map((r) => (
              <div key={r.id} className="kv">
                <span className="k">
                  {r.date} · {envelopeMap[r.budgetItemId] ?? 'Unknown'}
                  {r.note ? ` · ${r.note}` : ''}
                </span>
                <span
                  className={`v ${r.delta < 0 ? 'pos' : r.delta > 0 ? 'neg' : ''}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {fmtAUDc(r.actualAmount)}
                  <button
                    onClick={() => remove.mutate(r.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
                    title="Delete"
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </>
        )}

        {!isLoading && records.length === 0 && (
          <p style={{ color: 'var(--mute)', fontSize: 12, textAlign: 'center', margin: '18px 0 0' }}>
            No reconciliations yet. Drop a file or click + Add.
          </p>
        )}
      </div>
    </div>
  );
}
