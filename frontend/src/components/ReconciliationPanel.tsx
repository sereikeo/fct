import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getReconciliation,
  postReconciliation,
  deleteReconciliation,
  getEnvelopes,
  previewImport,
  QUERY_KEYS,
  ReconciliationRecord,
  EnvelopeWithOverride,
  ImportAccount,
  ImportProposal,
  ImportPreviewResult,
  ImportStatus,
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

// --- CSV import preview (dry-run) ------------------------------------------

const CONF_COLOR: Record<ImportProposal['confidence'], string> = {
  high: 'var(--green)', med: 'var(--mute)', low: 'var(--accent)',
};

// Status groups, in the order we want them surfaced. `matched`/`seen` are the
// skip groups — collapsed by default so the eye goes to what needs attention.
const VISIBLE_GROUPS: { status: ImportStatus; label: string }[] = [
  { status: 'reconcile-bill', label: 'Bills · reconcile to actual' },
  { status: 'new-spend',      label: 'New · will be created' },
  { status: 'unmatched',      label: 'Needs review' },
  { status: 'income',         label: 'Inflows · confirm in Notion' },
];

function groupByTarget(rows: ImportProposal[]): [string, ImportProposal[]][] {
  const m = new Map<string, ImportProposal[]>();
  for (const r of rows) {
    const k = r.targetName ?? 'Uncategorised';
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function ProposalRow({ p }: { p: ImportProposal }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr 76px 26px', gap: 8, alignItems: 'center', padding: '3px 0 3px 12px', fontSize: 11.5, borderTop: '1px solid var(--line-2)' }}>
      <span style={{ color: 'var(--mute)', fontFamily: 'JetBrains Mono, monospace' }}>{p.valueDate.slice(5)}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.description}>{p.description}</span>
      <span style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: p.amount < 0 ? 'var(--ink)' : 'var(--green)' }}>{fmtAUDc(p.amount)}</span>
      <span title={`${p.confidence} confidence`} style={{ justifySelf: 'center', width: 8, height: 8, borderRadius: '50%', background: CONF_COLOR[p.confidence] }} />
    </div>
  );
}

// Plain-text dump of the preview so it can be copied and pasted for review.
function buildPreviewText(r: ImportPreviewResult): string {
  const out: string[] = [`CSV import preview · ${r.account} · ${r.parsed} rows considered`];
  for (const { status, label } of VISIBLE_GROUPS) {
    const group = r.rows.filter(x => x.status === status);
    if (!group.length) continue;
    out.push(`\n## ${label} (${group.length})`);
    for (const [target, items] of groupByTarget(group)) {
      out.push(`  ${target} · ${items.length}`);
      for (const p of items) {
        out.push(`    ${p.valueDate}  ${p.amount.toFixed(2).padStart(9)}  ${p.confidence.padEnd(4)}  ${p.description}`);
      }
    }
  }
  out.push(`\nskipped: ${r.summary.matched} matched, ${r.summary.seen} already imported`);
  return out.join('\n');
}

function ImportPreview({ result }: { result: ImportPreviewResult }) {
  const { rows, summary } = result;
  const skipped = summary.matched + summary.seen;
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginBottom: 8 }}>
        Parsed <b>{result.parsed}</b> rows · <span style={{ color: 'var(--mute)' }}>{skipped} already logged/imported (skipped)</span>
        {summary.newOutflow > 0 && <> · new spend {fmtAUDc(-summary.newOutflow)}</>}
      </div>

      {VISIBLE_GROUPS.map(({ status, label }) => {
        const group = rows.filter(r => r.status === status);
        if (group.length === 0) return null;
        return (
          <div key={status} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--mute)', marginBottom: 4 }}>
              {label} ({group.length})
            </div>
            {groupByTarget(group).map(([target, items]) => (
              <div key={target} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)' }}>
                  <span>{target} <span style={{ color: 'var(--mute)', fontWeight: 400 }}>· {items.length}</span></span>
                  {status === 'reconcile-bill' && items[0].note ? <span style={{ color: 'var(--mute)', fontWeight: 400 }}>{items[0].note}</span> : null}
                </div>
                {items.map(p => <ProposalRow key={p.fingerprint} p={p} />)}
              </div>
            ))}
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span className="reco-pill">Dry run · nothing written yet — commit lands in the next phase</span>
        <button
          className="btn ghost"
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={() => {
            navigator.clipboard.writeText(buildPreviewText(result));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied ✓' : 'Copy output'}
        </button>
      </div>
    </div>
  );
}

export default function ReconciliationPanel({ bucketFilter = 'all' }: { bucketFilter?: 'all' | 'personal' | 'maple' }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [account, setAccount] = useState<ImportAccount>('maple-debit');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({ queryKey: QUERY_KEYS.reconciliation, queryFn: getReconciliation });
  const { data: envData } = useQuery({ queryKey: QUERY_KEYS.envelopes, queryFn: getEnvelopes });

  const preview = useMutation({
    mutationFn: (csv: string) => previewImport(account, csv, from),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteReconciliation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.reconciliation }),
  });

  function ingestText(text: string) {
    if (text.trim()) preview.mutate(text);
  }
  function ingestFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => ingestText(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  const envelopes = envData?.envelopes ?? [];
  const envelopeMap: Record<string, string> = {};
  for (const e of envelopes) envelopeMap[e.id] = e.name;

  const records: ReconciliationRecord[] = data?.records ?? [];

  return (
    <div className="card">
      <div className="hd">
        <h3>Reconcile variable spend</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value as ImportAccount)}
            style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 6px', fontSize: 11, color: 'var(--ink-2)' }}
            title="Which account this CSV is from"
          >
            <option value="maple-debit">Maple debit</option>
            <option value="personal-cc">Personal CC</option>
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 6px', fontSize: 11, color: 'var(--ink-2)' }}
            title="Ignore rows before this date"
          />
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
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => ingestFile(e.target.files?.[0])}
        />
        <div
          className="drop"
          tabIndex={0}
          style={dragging ? { borderColor: 'var(--ink-2)', background: 'var(--paper-2)' } : undefined}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); ingestFile(e.dataTransfer.files?.[0]); }}
          onPaste={(e) => ingestText(e.clipboardData.getData('text'))}
        >
          <div className="dic">⎘</div>
          <div className="dt">{preview.isPending ? 'Parsing…' : 'Drop or click to add a CSV'}</div>
          <div className="ds">Diffs against what's already logged, matches bills, slots variable spend. Dry run — review before commit.</div>
          <div className="dh">CSV · or Cmd+V to paste rows · account: {account === 'maple-debit' ? 'Maple debit' : 'Personal CC'}</div>
        </div>

        {preview.isError && (
          <p style={{ color: 'var(--accent)', fontSize: 12, margin: '12px 0 0' }}>
            Couldn't parse that — check it's a CommBank CSV export.
          </p>
        )}
        {preview.data && <ImportPreview result={preview.data} />}

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

        {!isLoading && records.length === 0 && !preview.data && (
          <p style={{ color: 'var(--mute)', fontSize: 12, textAlign: 'center', margin: '18px 0 0' }}>
            No reconciliations yet. Drop a CSV or click + Add.
          </p>
        )}
      </div>
    </div>
  );
}
