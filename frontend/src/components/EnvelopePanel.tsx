import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getEnvelopes, getSpend, postSpend, deleteSpend, patchEnvelope,
  QUERY_KEYS, EnvelopeWithOverride, SpendEntry,
} from '../services/api';

const fmtAUD = (n: number) =>
  (n < 0 ? '−A$' : 'A$') + Math.abs(Math.round(n)).toLocaleString('en-AU');

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function countOccurrencesInMonth(
  dueDate: string,
  frequency: string,
  recurInterval: number,
  year: number,
  month: number,
): number {
  if (frequency === 'monthly') return 1;
  if (frequency !== 'weekly' && frequency !== 'fortnightly') return 1;

  const stepDays = (frequency === 'weekly' ? 7 : 14) * Math.max(1, recurInterval);
  const stepMs = stepDays * 86_400_000;
  const start = new Date(year, month, 1).getTime();
  const end   = new Date(year, month + 1, 0).getTime();

  const [ay, am, ad] = dueDate.split('-').map(Number);
  let d = new Date(ay, am - 1, ad).getTime();

  if (d < start) {
    const steps = Math.ceil((start - d) / stepMs);
    d += steps * stepMs;
  }
  d -= stepMs;

  let count = 0;
  d += stepMs;
  while (d <= end) {
    if (d >= start) count++;
    d += stepMs;
  }
  return Math.max(1, count);
}

interface QuickAddProps {
  envelope: EnvelopeWithOverride;
  onClose: () => void;
}

function QuickAdd({ envelope, onClose }: QuickAddProps) {
  const qc = useQueryClient();
  const period = currentPeriod();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [payment, setPayment] = useState<'cash' | 'credit'>(
    envelope.payment === 'Credit' ? 'credit' : 'cash'
  );

  const add = useMutation({
    mutationFn: () => postSpend({
      budgetItemId: envelope.id,
      date,
      amount: parseFloat(amount),
      payment,
      note: note || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.spend(period) });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.cashflow('', '') });
      onClose();
    },
  });

  const inputStyle: React.CSSProperties = {
    background: 'var(--paper)', border: '1px solid var(--line)',
    borderRadius: 6, padding: '4px 8px', fontSize: 12.5, color: 'var(--ink)',
    fontFamily: 'JetBrains Mono, monospace', outline: 'none',
  };

  const segBtn = (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--ink)' : 'transparent',
    color: active ? 'var(--paper)' : 'var(--ink-2)',
    border: 'none', borderRadius: 4, padding: '3px 8px',
    fontSize: 11, fontWeight: 500, cursor: 'pointer',
    fontFamily: 'Inter, sans-serif',
  });

  return (
    <div style={{
      marginTop: 8, padding: '10px 12px',
      background: 'var(--paper-2)', borderRadius: 8,
      border: '1px solid var(--line-2)',
      display: 'grid', gridTemplateColumns: '1fr 1fr auto auto auto', gap: 6, alignItems: 'center',
    }}>
      <input
        autoFocus
        type="number"
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && amount) add.mutate(); if (e.key === 'Escape') onClose(); }}
        style={{ ...inputStyle, width: '100%' }}
      />
      <input
        type="text"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ ...inputStyle, fontFamily: 'Inter, sans-serif', width: '100%' }}
      />
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        style={{ ...inputStyle, fontSize: 11.5 }}
      />
      <div style={{
        display: 'flex', background: 'var(--paper)',
        border: '1px solid var(--line)', borderRadius: 6, padding: 1,
      }}>
        <button type="button" onClick={() => setPayment('cash')} style={segBtn(payment === 'cash')}>Cash</button>
        <button type="button" onClick={() => setPayment('credit')} style={segBtn(payment === 'credit')}>CC</button>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          className="btn"
          onClick={() => add.mutate()}
          disabled={!amount || add.isPending}
          style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}
        >
          {add.isPending ? '…' : 'Save'}
        </button>
        <button className="btn ghost" onClick={onClose} style={{ fontSize: 11, padding: '4px 8px' }}>✕</button>
      </div>
    </div>
  );
}

interface VariableRowProps {
  envelope: EnvelopeWithOverride;
  entries: SpendEntry[];
  monthlyBudget: number;
}

function VariableRow({ envelope, entries, monthlyBudget }: VariableRowProps) {
  const [adding, setAdding] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');
  const budgetInputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);
  const qc = useQueryClient();
  const period = currentPeriod();

  const overrideMutation = useMutation({
    mutationFn: (amount: number) => patchEnvelope(envelope.id, { period, overrideAmount: amount }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.envelopes });
      qc.invalidateQueries({ queryKey: ['cashflow'] });
      setEditingBudget(false);
    },
  });

  function openBudgetEdit() {
    submittedRef.current = false;
    setBudgetInput(String(monthlyBudget));
    setEditingBudget(true);
  }

  function commitBudgetEdit() {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const val = parseFloat(budgetInput);
    if (!isNaN(val) && val > 0) {
      overrideMutation.mutate(val);
    } else {
      setEditingBudget(false);
    }
  }

  useEffect(() => {
    if (editingBudget) budgetInputRef.current?.select();
  }, [editingBudget]);

  const actualSpend = entries.reduce((sum, e) => sum + e.amount, 0);
  const cashSpend   = entries.filter(e => e.payment === 'cash').reduce((s, e) => s + e.amount, 0);
  const creditSpend = entries.filter(e => e.payment === 'credit').reduce((s, e) => s + e.amount, 0);

  const now = new Date();
  const totalDays = daysInMonth(now.getFullYear(), now.getMonth());
  const proRataPct = (now.getDate() / totalDays) * 100;
  const proRataTarget = (now.getDate() / totalDays) * monthlyBudget;

  const pct = monthlyBudget > 0 ? Math.min(100, (actualSpend / monthlyBudget) * 100) : 0;
  const overBudget  = actualSpend > monthlyBudget;
  const aheadOfPace = !overBudget && actualSpend > proRataTarget;
  const fillCls = overBudget ? 'fill over' : aheadOfPace ? 'fill' : 'fill good';

  const remove = useMutation({
    mutationFn: (id: string) => deleteSpend(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.spend(period) });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.cashflow('', '') });
    },
  });

  return (
    <div style={{ marginBottom: entries.length > 0 || adding ? 14 : 0 }}>
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
              title={`Day ${now.getDate()} of ${totalDays} — on-pace: ${fmtAUD(proRataTarget)}`}
              style={{
                position: 'absolute', top: -3, bottom: -3, left: `${proRataPct}%`,
                width: 2, background: 'var(--ink-2)', opacity: 0.4, borderRadius: 1,
              }}
            />
            <div style={{ position: 'absolute', top: -2, bottom: -2, left: '100%', width: 2, background: 'var(--ink)', opacity: 0.25 }} />
          </div>
        </div>
        <div className="nums">
          <div className={`v ${overBudget ? 'over' : aheadOfPace ? 'ok' : 'good'}`}>
            {actualSpend > 0
              ? overBudget
                ? `+${fmtAUD(actualSpend - monthlyBudget)} over`
                : `${fmtAUD(monthlyBudget - actualSpend)} left`
              : 'no spend logged'}
          </div>
          <div className="s" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {actualSpend > 0 ? (
              <>
                {cashSpend > 0 && <span>{fmtAUD(cashSpend)} cash</span>}
                {cashSpend > 0 && creditSpend > 0 && <span style={{ color: 'var(--mute)' }}>·</span>}
                {creditSpend > 0 && <span style={{ color: 'var(--cc)' }}>{fmtAUD(creditSpend)} CC</span>}
                <span style={{ color: 'var(--mute)' }}>of</span>
              </>
            ) : 'budget '}
            {editingBudget ? (
              <input
                ref={budgetInputRef}
                value={budgetInput}
                onChange={e => setBudgetInput(e.target.value)}
                onBlur={commitBudgetEdit}
                onKeyDown={e => { if (e.key === 'Enter') commitBudgetEdit(); if (e.key === 'Escape') setEditingBudget(false); }}
                style={{
                  width: 64, fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5,
                  background: 'var(--paper-3)', border: '1px solid var(--line)',
                  borderRadius: 4, padding: '0 4px', color: 'var(--ink)',
                }}
              />
            ) : (
              <span
                title="Click to override this month's budget"
                onClick={openBudgetEdit}
                style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
              >{fmtAUD(monthlyBudget)}</span>
            )}
            <button
              onClick={() => setAdding(v => !v)}
              title="Log spend"
              style={{
                background: 'none', border: '1px solid var(--line)', borderRadius: 4,
                color: 'var(--ink-2)', cursor: 'pointer', fontSize: 11, padding: '0 4px',
                lineHeight: '14px',
              }}
            >+</button>
          </div>
        </div>
      </div>

      {adding && <QuickAdd envelope={envelope} onClose={() => setAdding(false)} />}

      {entries.length > 0 && (
        <div style={{ paddingLeft: 4, marginTop: 4 }}>
          {entries.map((e) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--ink-2)', padding: '2px 0' }}>
              <span style={{ color: 'var(--mute)' }}>
                {e.date.slice(5)}
                {e.payment === 'credit' && <span title="Paid by credit card" style={{ color: 'var(--cc)', marginLeft: 4 }}>◆</span>}
                {e.note ? ` · ${e.note}` : ''}
                {!e.txId && <span title="No confirmed occurrence found — balance not adjusted" style={{ color: 'var(--accent)', marginLeft: 4 }}>⚠</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'JetBrains Mono, monospace', color: e.payment === 'credit' ? 'var(--cc)' : undefined }}>
                {fmtAUD(e.amount)}
                <button
                  onClick={() => remove.mutate(e.id)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}
                >×</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EnvelopePanel({ bucketFilter = 'all' }: { bucketFilter?: 'all' | 'personal' | 'maple' }) {
  const period = currentPeriod();

  const { data: envData, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.envelopes,
    queryFn: getEnvelopes,
  });
  const { data: spendData } = useQuery({
    queryKey: QUERY_KEYS.spend(period),
    queryFn: () => getSpend(period),
  });

  if (isLoading) {
    return (
      <div className="card">
        <div className="hd"><h3>Envelope spend · this month</h3></div>
        <div className="bd" style={{ color: 'var(--mute)', fontSize: 12 }}>Loading…</div>
      </div>
    );
  }

  if (isError || !envData) {
    return (
      <div className="card">
        <div className="bd" style={{ color: 'var(--accent)' }}>Failed to load envelopes.</div>
      </div>
    );
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  // Group spend entries by budget item
  const spendByItem = new Map<string, SpendEntry[]>();
  for (const e of spendData?.entries ?? []) {
    if (!spendByItem.has(e.budgetItemId)) spendByItem.set(e.budgetItemId, []);
    spendByItem.get(e.budgetItemId)!.push(e);
  }

  const envelopes = envData.envelopes.filter(
    (e) =>
      !e.deletedAt &&
      e.isEnvelope &&
      (bucketFilter === 'all' || e.bucket === bucketFilter),
  );

  return (
    <div className="card">
      <div className="hd">
        <h3>Envelope spend · this month</h3>
        <span className="sub">budget vs actual-to-date</span>
      </div>
      <div className="bd">
        {envelopes.length === 0 ? (
          <p style={{ color: 'var(--mute)', fontSize: 12, margin: 0 }}>
            No envelopes. Tag items with "Envelope" in Notion to track spend here.
          </p>
        ) : (
          envelopes.map((env) => {
            const occurrences = countOccurrencesInMonth(env.dueDate, env.frequency, env.recurInterval, year, month);
            const periodOverride = env.overrides.find(o => o.period === period);
            const monthlyBudget = periodOverride ? periodOverride.overrideAmount : env.forecastAmount * occurrences;
            return (
              <VariableRow
                key={env.id}
                envelope={env}
                entries={spendByItem.get(env.id) ?? []}
                monthlyBudget={monthlyBudget}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
