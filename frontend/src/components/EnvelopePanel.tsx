import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getEnvelopes, patchEnvelope, deleteEnvelope, QUERY_KEYS, EnvelopeWithOverride } from '../services/api';

const fmtAUD = (n: number) =>
  (n < 0 ? '−A$' : 'A$') + Math.abs(Math.round(n)).toLocaleString('en-AU');

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function VariableRow({ envelope }: { envelope: EnvelopeWithOverride }) {
  const qc = useQueryClient();
  const period = currentPeriod();
  const override = envelope.overrides.find((o) => o.period === period);
  const budget = envelope.forecastAmount;
  const actual = override?.overrideAmount ?? 0;
  const pct = budget > 0 ? Math.min(100, (actual / budget) * 100) : 0;
  const over = actual > budget;
  const fillCls = over ? 'fill over' : pct < 60 ? 'fill good' : 'fill';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(override?.overrideAmount ?? ''));

  const save = useMutation({
    mutationFn: () =>
      patchEnvelope(envelope.id, { period, overrideAmount: parseFloat(draft) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.envelopes }),
  });

  const remove = useMutation({
    mutationFn: () => deleteEnvelope(envelope.id, period),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.envelopes }),
  });

  return (
    <div className="var-row">
      <div className="cat">
        {envelope.name}
        <div className="sub">{envelope.category ?? envelope.payment}</div>
      </div>
      <div style={{ position: 'relative' }}>
        <div className="bbar" style={{ overflow: 'visible' }}>
          <div style={{ overflow: 'hidden', height: '100%', borderRadius: 7, position: 'relative' }}>
            <div className={fillCls} style={{ width: `${pct}%` }} />
          </div>
          <div
            className="marker"
            style={{ position: 'absolute', top: -2, bottom: -2, left: '100%', width: 2, background: 'var(--ink)', opacity: 0.35 }}
          />
        </div>
      </div>
      <div className="nums">
        {editing ? (
          <input
            autoFocus
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft && parseFloat(draft) >= 0) save.mutate();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { setDraft(''); setEditing(false); }
            }}
            style={{
              width: '100%', textAlign: 'right', background: 'var(--paper)',
              border: '1px solid var(--ink)', borderRadius: 6, padding: '2px 6px',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, color: 'var(--ink)',
            }}
          />
        ) : (
          <div
            className={`v ${over ? 'over' : pct < 60 ? 'good' : 'ok'}`}
            style={{ cursor: 'pointer' }}
            title="Click to set actual spend"
            onClick={() => { setDraft(String(override?.overrideAmount ?? '')); setEditing(true); }}
          >
            {actual > 0
              ? (over ? `+${fmtAUD(actual - budget)} over` : `${fmtAUD(budget - actual)} left`)
              : 'set actual'}
          </div>
        )}
        <div className="s">
          {actual > 0 ? `${fmtAUD(actual)} of ${fmtAUD(budget)}` : `budget ${fmtAUD(budget)}`}
          {override && (
            <button
              onClick={() => remove.mutate()}
              style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function EnvelopePanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.envelopes,
    queryFn: getEnvelopes,
  });

  if (isLoading) {
    return (
      <div className="card">
        <div className="hd"><h3>Variable spend · this month</h3></div>
        <div className="bd" style={{ color: 'var(--mute)', fontSize: 12 }}>Loading…</div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="card">
        <div className="bd" style={{ color: 'var(--accent)' }}>Failed to load envelopes.</div>
      </div>
    );
  }

  const variableEnvelopes = data.envelopes.filter((e) => !e.deletedAt && e.isVariable);

  return (
    <div className="card">
      <div className="hd">
        <h3>Variable spend · this month</h3>
        <span className="sub">budget vs actual-to-date</span>
      </div>
      <div className="bd">
        {variableEnvelopes.length === 0 ? (
          <p style={{ color: 'var(--mute)', fontSize: 12, margin: 0 }}>
            No variable envelopes. Mark items as variable in Notion to track actual spend here.
          </p>
        ) : (
          variableEnvelopes.map((env) => <VariableRow key={env.id} envelope={env} />)
        )}
      </div>
    </div>
  );
}
