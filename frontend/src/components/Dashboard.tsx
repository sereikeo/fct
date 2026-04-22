import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCashflow, getEnvelopes, QUERY_KEYS, CashFlowEntry, LineItem, EnvelopeWithOverride, OverdueItem, OverdueTotals } from '../services/api';
import CashFlowChart from './CashFlowChart';
import SyncStatus from './SyncStatus';
import EnvelopePanel from './EnvelopePanel';
import ReconciliationPanel from './ReconciliationPanel';

interface DateRange { from: string; to: string }
interface Props {
  dateRange: DateRange;
  onDateRangeChange: (r: DateRange) => void;
}

function toISO(d: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function addDays(d: Date, n: number): Date { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function diffDays(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}
const fmtAUD = (n: number) => (n < 0 ? '−A$' : 'A$') + Math.abs(Math.round(n)).toLocaleString('en-AU');
const fmtMD = (d: Date) => d.toLocaleDateString('en-AU', { month: 'short', day: '2-digit' });

type BucketFilter = 'all' | 'personal' | 'maple';

// ——— CC Statement card ———
function CCStatementCard({ entries }: { entries: CashFlowEntry[] }) {
  const [open, setOpen] = useState(false);

  const ccEntry = entries.find(e => e.breakdown.some(b => b.isCC && b.type === 'expense'));
  const ccItems = ccEntry ? ccEntry.breakdown.filter(b => b.isCC && b.type === 'expense') : [];
  const ccTotal = ccItems.reduce((t, b) => t + (b.overrideAmount ?? b.forecastAmount), 0);
  const ccDate = ccEntry ? new Date(ccEntry.date + 'T00:00:00') : null;

  return (
    <div className="stmt-card">
      <div className="chip" />
      <div className="tag">CBA Mastercard · next statement</div>
      <div className="amt mono">{ccTotal > 0 ? fmtAUD(ccTotal) : 'A$0'}</div>
      <div className="meta">
        {ccDate
          ? <><span>due <b>{fmtMD(ccDate)}</b></span></>
          : <span style={{ color: 'var(--mute)' }}>No upcoming CC items</span>
        }
      </div>
      {ccDate && <div className="period">period · statement cycle</div>}
      {ccItems.length > 0 && (
        <button className="stmt-toggle" onClick={() => setOpen(v => !v)}>
          {open ? `▾ hide ${ccItems.length} items` : `▸ show ${ccItems.length} items`}
        </button>
      )}
      <div className={`stmt-items${open ? ' open' : ''}`}>
        {ccItems.map((item, i) => (
          <div key={i} className="stmt-row">
            <div className="d">{ccDate ? fmtMD(ccDate) : '—'}</div>
            <div>{item.name}</div>
            <div className="n">A${(item.overrideAmount ?? item.forecastAmount).toFixed(2)}</div>
          </div>
        ))}
        {ccItems.length > 0 && (
          <div className="stmt-row" style={{ borderTop: '1px solid rgba(91,59,138,0.2)', marginTop: 4, paddingTop: 8, fontWeight: 600 }}>
            <div /><div>TOTAL</div>
            <div className="n">A${ccTotal.toFixed(2)}</div>
          </div>
        )}
      </div>
      <div className="stmt-actions">
        <button className="btn cc">Import statement</button>
        <button className="btn ghost">Paste screenshot</button>
      </div>
    </div>
  );
}

// ——— "On this date" sidebar card ———
function OnThisDateCard({ entries, scrubIndex, bucketFilter }: { entries: CashFlowEntry[]; scrubIndex: number; bucketFilter: BucketFilter }) {
  const si = Math.max(0, Math.min(scrubIndex, entries.length - 1));
  const entry = entries[si];
  const prev  = si > 0 ? entries[si - 1] : null;
  const date  = entry ? fmtMD(new Date(entry.date + 'T00:00:00')) : '—';

  if (!entry) {
    return (
      <div className="card">
        <div className="hd"><h3>On this date</h3><span className="sub">{date}</span></div>
        <div className="bd" style={{ color: 'var(--mute)', fontSize: 12 }}>Waiting for data…</div>
      </div>
    );
  }

  // Opening balance — use previous day's closing, or derive from this day's moves when at start
  const openingBalP = prev ? prev.balP : (() => {
    let pIn = 0, pOut = 0;
    for (const b of entry.breakdown) {
      if (b.isPending) continue;
      const amt = b.actualAmount ?? b.overrideAmount ?? b.forecastAmount;
      if (b.isCC) { pOut += amt; continue; }
      if (b.type === 'income' && b.bucket === 'personal') pIn += amt;
      else if (b.type !== 'income' && b.bucket === 'personal') pOut += amt;
    }
    return entry.balP - pIn + pOut;
  })();
  const openingBalM = prev ? prev.balM : (() => {
    let mIn = 0, mOut = 0;
    for (const b of entry.breakdown) {
      if (b.isPending || b.isCC) continue;
      const amt = b.actualAmount ?? b.overrideAmount ?? b.forecastAmount;
      if (b.type === 'income' && b.bucket === 'maple') mIn += amt;
      else if (b.type !== 'income' && b.bucket === 'maple') mOut += amt;
    }
    return entry.balM - mIn + mOut;
  })();

  const openingBal = openingBalP + openingBalM;
  const closingBal = bucketFilter === 'personal' ? entry.balP : bucketFilter === 'maple' ? entry.balM : entry.balance;
  const openingBalDisplay = bucketFilter === 'personal' ? openingBalP : bucketFilter === 'maple' ? openingBalM : openingBal;

  // Transactions visible under the current filter
  const txItems = entry.breakdown.filter(b => {
    if (bucketFilter !== 'all' && b.bucket !== bucketFilter) return false;
    if (b.isCC && bucketFilter !== 'personal') return false;
    return true;
  });

  return (
    <div className="card" style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
      <div className="hd"><h3>On this date</h3><span className="sub">{date}</span></div>

      {/* Body: flex column so tx list grows and closing balance sticks to bottom */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px 20px 0', overflow: 'hidden' }}>

        {/* Opening balance */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid var(--line-2)', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--mute)' }}>Opening balance</span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, color: 'var(--mute)' }}>{fmtAUD(openingBalDisplay)}</span>
        </div>

        {/* Transaction list — scrolls if overflow */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '4px 0' }}>
          {txItems.length === 0 ? (
            <div style={{ color: 'var(--mute)', fontSize: 12, padding: '8px 0' }}>No transactions this day</div>
          ) : (
            txItems.map((b, i) => {
              const amt   = b.actualAmount ?? b.overrideAmount ?? b.forecastAmount;
              const isIn  = b.type === 'income';
              const color = b.isPending ? 'var(--mute)' : b.isCC ? 'var(--cc)' : isIn ? 'var(--green)' : 'var(--ink)';
              const sign  = isIn ? '+' : '−';
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', opacity: b.isPending ? 0.5 : 1 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--ink-2)', flex: 1, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.name}
                    {b.isPending && <span style={{ marginLeft: 5, fontSize: 10, color: 'var(--mute)', fontStyle: 'italic' }}>awaiting</span>}
                  </span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, color, whiteSpace: 'nowrap' }}>
                    {sign}{fmtAUD(amt)}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Closing balance — pinned to bottom */}
        <div style={{ borderTop: '1px solid var(--line-2)', padding: '10px 0 14px', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Closing balance</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, fontWeight: 600, color: closingBal < 0 ? 'var(--accent)' : 'var(--ink)' }}>{fmtAUD(closingBal)}</span>
          </div>
          {bucketFilter === 'all' && (
            <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
              <span style={{ fontSize: 11.5, color: 'var(--personal)' }}>Personal {fmtAUD(entry.balP)}</span>
              <span style={{ fontSize: 11.5, color: 'var(--maple)' }}>Maple {fmtAUD(entry.balM)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ——— Upcoming ledger table ———
function LedgerCard({
  entries,
  overdueItems,
  overdueTotals,
  bucketFilter,
}: {
  entries: CashFlowEntry[];
  overdueItems: OverdueItem[];
  overdueTotals: OverdueTotals;
  bucketFilter: BucketFilter;
}) {
  const rows = useMemo(() => {
    const out: { entry: CashFlowEntry; item: LineItem }[] = [];
    for (const entry of entries.slice(0, 91)) {
      for (const item of entry.breakdown) {
        if (bucketFilter !== 'all' && item.bucket !== bucketFilter) continue;
        if (item.isCC && bucketFilter !== 'personal') continue;
        if (item.isPending) continue; // already listed in the overdue section above
        out.push({ entry, item });
      }
    }
    return out;
  }, [entries, bucketFilter]);

  const overdueRows = useMemo(() => {
    const filtered = overdueItems.filter(o => bucketFilter === 'all' || o.bucket === bucketFilter);
    // Sort by due_date ascending (earliest = most overdue first)
    return filtered.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [overdueItems, bucketFilter]);

  const personalHas = overdueTotals.personal.owedIn > 0 || overdueTotals.personal.owedOut > 0;
  const mapleHas    = overdueTotals.maple.owedIn    > 0 || overdueTotals.maple.owedOut    > 0;
  const showPersonal = personalHas && bucketFilter !== 'maple';
  const showMaple    = mapleHas    && bucketFilter !== 'personal';
  const showSummary  = overdueRows.length > 0 && (showPersonal || showMaple);

  return (
    <div className="card flush">
      <div className="hd" style={{ padding: '16px 20px' }}>
        <h3>Upcoming · next 90 days</h3>
        <span className="sub">
          {overdueRows.length > 0 ? `${overdueRows.length} overdue · ` : ''}
          {rows.length} rows · expanded from recurrence
        </span>
      </div>
      {showSummary && (
        <div className="overdue-summary">
          <span className="lbl">Overdue</span>
          {showPersonal && (
            <span className="tot">
              <span className="sw" style={{ background: 'var(--personal)' }} />
              Personal
              {overdueTotals.personal.owedIn > 0 && (
                <>
                  {' · owed to you '}
                  <b className="mono owed-in">+A${overdueTotals.personal.owedIn.toFixed(2)}</b>
                </>
              )}
              {overdueTotals.personal.owedOut > 0 && (
                <>
                  {' · owed by you '}
                  <b className="mono owed-out">−A${overdueTotals.personal.owedOut.toFixed(2)}</b>
                </>
              )}
            </span>
          )}
          {showMaple && (
            <span className="tot">
              <span className="sw" style={{ background: 'var(--maple)' }} />
              Maple
              {overdueTotals.maple.owedIn > 0 && (
                <>
                  {' · owed to you '}
                  <b className="mono owed-in">+A${overdueTotals.maple.owedIn.toFixed(2)}</b>
                </>
              )}
              {overdueTotals.maple.owedOut > 0 && (
                <>
                  {' · owed by you '}
                  <b className="mono owed-out">−A${overdueTotals.maple.owedOut.toFixed(2)}</b>
                </>
              )}
            </span>
          )}
        </div>
      )}
      <div style={{ overflow: 'auto', maxHeight: 560 }}>
        <table className="ledger">
          <thead>
            <tr>
              <th>Due</th><th>Bill</th><th>Budget</th><th>Payment</th>
              <th className="num">Amount</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {overdueRows.map((o) => {
              const due = new Date(o.dueDate + 'T00:00:00');
              const isIncoming = o.type === 'income';
              const sign  = isIncoming ? '+' : '−';
              const color = isIncoming ? 'var(--green)' : 'var(--accent)';
              return (
                <tr key={`overdue-${o.budgetItemId}`} className="overdue">
                  <td>
                    <div className="ic-cell">
                      <div className="icon overdue">!</div>
                      <div>
                        <div className="bill-name">
                          {due.toLocaleDateString('en-AU', { month: 'short', day: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="bill-name">{o.name}</div>
                    {o.missedCycles > 1 && (
                      <div className="bill-sub">
                        {o.missedCycles} cycles × A${o.forecastAmount.toFixed(2)}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`tag ${o.bucket}`}>
                      <span className="sw" style={{ background: o.bucket === 'maple' ? 'var(--maple)' : 'var(--personal)' }} />
                      {o.bucket === 'maple' ? 'Maple' : 'Personal'}
                    </span>
                  </td>
                  <td style={{ color: 'var(--mute)' }}>—</td>
                  <td className="num" style={{ color, fontWeight: 600 }}>
                    {sign}A${o.totalOwed.toFixed(2)}
                  </td>
                  <td>
                    <span className="reco-pill overdue">
                      {isIncoming ? 'awaiting' : 'overdue'} · {o.daysOverdue}d
                    </span>
                  </td>
                </tr>
              );
            })}
            {rows.map(({ entry, item }, i) => {
              const isIncome = item.type === 'income';
              const isStmt = item.isCC;
              const amt = item.overrideAmount ?? item.forecastAmount;
              return (
                <tr key={i} className={isStmt ? 'stmt-row-head' : ''}>
                  <td>
                    <div className="ic-cell">
                      <div className={`icon ${isIncome ? 'in' : isStmt ? 'stmt' : 'out'}`}>
                        {isStmt ? '◆' : isIncome ? '▲' : '▼'}
                      </div>
                      <div>
                        <div className="bill-name">
                          {new Date(entry.date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short', day: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="bill-name">{item.name}</div>
                    {item.category && <div className="bill-sub">{item.category}</div>}
                  </td>
                  <td>
                    {isStmt ? (
                      <span className="tag cc">Credit</span>
                    ) : (
                      <span className={`tag ${item.bucket}`}>
                        <span className="sw" style={{ background: item.bucket === 'maple' ? 'var(--maple)' : 'var(--personal)' }} />
                        {item.bucket === 'maple' ? 'Maple' : 'Personal'}
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--mute)' }}>{item.payment}</td>
                  <td className="num" style={{ color: isIncome ? 'var(--green)' : isStmt ? 'var(--cc)' : 'var(--ink)', fontWeight: 600 }}>
                    {isIncome ? '+' : '−'}A${amt.toFixed(2)}
                  </td>
                  <td>
                    <span className={`reco-pill${item.isReconciled ? ' ok' : item.isConfirmed ? ' ok' : ''}`}>
                      {item.isReconciled ? 'reconciled' : item.isConfirmed ? (isIncome ? 'received' : 'paid') : isIncome ? 'scheduled' : 'pending'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ——— Notion preview card ———
function NotionCard({ envelopes, bucketFilter }: { envelopes: EnvelopeWithOverride[]; bucketFilter: BucketFilter }) {
  const typeEmoji: Record<string, string> = { income: '💰', expense: '💸', transfer: '↔' };
  const rows = envelopes.filter(e =>
    !e.deletedAt && (bucketFilter === 'all' || e.bucket === bucketFilter)
  );

  return (
    <div className="card flush">
      <div className="hd" style={{ padding: '16px 20px' }}>
        <h3>From Notion · Expenses</h3>
        <span className="sub">schema preview</span>
      </div>
      <div className="notion-hd">
        <b>Budgets</b> · {rows.length} rows · Bill, Amount (AUD), Due, Recur, Payment, Tags
      </div>
      <div style={{ maxHeight: 520, overflow: 'auto' }}>
        {rows.map((env) => (
          <div key={env.id} className="notion-row">
            <div className="name">
              <span className="ico">{typeEmoji[env.type] ?? '📋'}</span>
              {env.name}
            </div>
            <div
              className="num"
              style={{ color: env.type === 'income' ? 'var(--green)' : 'var(--ink)', fontWeight: 500 }}
            >
              {env.type === 'income' ? '+' : '−'}A${env.forecastAmount.toLocaleString()}
            </div>
            <div className="date">{env.dueDate}</div>
            <div><span className="chip">{env.frequency}</span></div>
            <div><span className="chip">{env.payment}</span></div>
            <div className="chips">
              <span className="chip mini">{env.bucket}</span>
              {env.category && <span className="chip mini">{env.category}</span>}
              {env.isVariable && <span className="chip mini">variable</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ——— Dashboard ———
export default function Dashboard({ dateRange, onDateRangeChange }: Props) {
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>('all');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const horizon = diffDays(dateRange.from, dateRange.to);

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.cashflow(dateRange.from, dateRange.to),
    queryFn: () => getCashflow(dateRange.from, dateRange.to),
  });

  const { data: envData } = useQuery({
    queryKey: QUERY_KEYS.envelopes,
    queryFn: getEnvelopes,
  });

  const entries = useMemo<CashFlowEntry[]>(() => data?.entries ?? [], [data]);
  const adjustedEntries = useMemo<CashFlowEntry[]>(() => data?.adjustedEntries ?? [], [data]);
  const overdueItems = useMemo<OverdueItem[]>(() => data?.overdueItems ?? [], [data]);
  const overdueTotals = useMemo<OverdueTotals>(
    () => data?.overdueTotals ?? {
      personal: { owedIn: 0, owedOut: 0 },
      maple:    { owedIn: 0, owedOut: 0 },
    },
    [data]
  );
  const envelopes = useMemo<EnvelopeWithOverride[]>(() => envData?.envelopes ?? [], [envData]);

  const scrubIndex = useMemo(() => {
    if (!selectedDate || entries.length === 0) return 0;
    const idx = entries.findIndex(e => e.date === selectedDate);
    return idx >= 0 ? idx : Math.min(57, entries.length - 1);
  }, [entries, selectedDate]);

  function handleScrubChange(i: number) {
    const d = entries[i]?.date;
    if (d) setSelectedDate(d);
  }

  function handleHorizonChange(days: number) {
    onDateRangeChange({ from: toISO(new Date()), to: toISO(addDays(new Date(), days)) });
  }

  return (
    <>
      {/* ——— Top bar ——— */}
      <header className="bar">
        <div className="bar-inner">
          <div className="logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17 L9 11 L13 15 L21 7"/>
              <circle cx="9" cy="11" r="1.6" fill="currentColor"/>
              <circle cx="13" cy="15" r="1.6" fill="currentColor"/>
            </svg>
          </div>
          <div className="brand">
            <b>Future Cash Timeline</b>
            <small>connected to Notion · Budgets DB</small>
          </div>
          <div className="seg" role="group" aria-label="Budget bucket">
            {(['all', 'personal', 'maple'] as BucketFilter[]).map((b) => (
              <button
                key={b}
                aria-pressed={bucketFilter === b ? 'true' : 'false'}
                onClick={() => setBucketFilter(b)}
              >
                <span
                  className="sw"
                  style={{ background: b === 'all' ? 'var(--ink)' : b === 'personal' ? 'var(--personal)' : 'var(--maple)' }}
                />
                {b === 'all' ? 'All' : b === 'personal' ? 'Personal' : 'Maple'}
              </button>
            ))}
          </div>
          <SyncStatus />
          <div className="spacer" />
          <button className="btn ghost reconcile-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>
            </svg>
            Reconcile
          </button>
        </div>
      </header>

      {/* ——— Main page ——— */}
      <main className="page">

        {/* Hero */}
        <section className="hero">
          <div>
            <h1>Your <em>cash</em> over time.</h1>
            <p>
              Drag the scrubber to project your balance on any future day.
              Forecast from Notion recurrence · CC purchases bundle on statement due ·
              variable spend reconciles when you commit actuals.
            </p>
          </div>
          <div className="legend">
            <span><i className="p" />Personal</span>
            <span><i className="m" />Maple</span>
            <span><i className="fc" />forecast</span>
            <span><i className="today" />today</span>
            <span>▲ income · ▼ bill</span>
            {bucketFilter === 'personal' && <span><i className="cc" />◆ CC stmt</span>}
          </div>
        </section>

        {/* Chart + sidebar grid */}
        <section className="grid">
          {isLoading ? (
            <div className="card curve-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 460, color: 'var(--mute)', fontSize: 13 }}>
              Loading cashflow data…
            </div>
          ) : (
            <CashFlowChart
              entries={entries}
              adjustedEntries={adjustedEntries}
              hasOverdue={overdueItems.length > 0}
              scrubIndex={scrubIndex}
              onScrubChange={handleScrubChange}
              horizon={horizon}
              onHorizonChange={handleHorizonChange}
              bucketFilter={bucketFilter}
            />
          )}

          <div className="stack">
            <OnThisDateCard entries={entries} scrubIndex={scrubIndex} bucketFilter={bucketFilter} />
            {bucketFilter === 'personal' && <CCStatementCard entries={entries} />}
          </div>
        </section>

        <div style={{ height: 22 }} />

        {/* Row 2: Variable spend | Reconcile drop zone */}
        <section className="row2">
          <EnvelopePanel bucketFilter={bucketFilter} />
          <ReconciliationPanel bucketFilter={bucketFilter} />
        </section>

        <div style={{ height: 22 }} />

        {/* Row 2: Ledger | Notion preview */}
        <section className="row2">
          <LedgerCard
            entries={entries}
            overdueItems={overdueItems}
            overdueTotals={overdueTotals}
            bucketFilter={bucketFilter}
          />
          <NotionCard envelopes={envelopes} bucketFilter={bucketFilter} />
        </section>

      </main>
    </>
  );
}
