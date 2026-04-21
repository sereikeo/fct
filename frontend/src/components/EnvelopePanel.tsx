import { useQuery } from '@tanstack/react-query';
import { getEnvelopes, getReconciliation, QUERY_KEYS, EnvelopeWithOverride } from '../services/api';

const fmtAUD = (n: number) =>
  (n < 0 ? '−A$' : 'A$') + Math.abs(Math.round(n)).toLocaleString('en-AU');

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function countOccurrencesInMonth(
  dueDate: string,
  frequency: 'weekly' | 'fortnightly',
  recurInterval: number,
  year: number,
  month: number,
): number {
  const stepDays = (frequency === 'weekly' ? 7 : 14) * Math.max(1, recurInterval);
  const stepMs = stepDays * 86_400_000;
  const start = new Date(year, month, 1).getTime();
  const end   = new Date(year, month + 1, 0).getTime();

  // Parse anchor without timezone shift
  const [ay, am, ad] = dueDate.split('-').map(Number);
  let d = new Date(ay, am - 1, ad).getTime();

  // Step forward until we reach or pass the month start
  if (d < start) {
    const steps = Math.ceil((start - d) / stepMs);
    d += steps * stepMs;
  }
  // Step back one to catch any occurrence at exactly start
  d -= stepMs;

  let count = 0;
  d += stepMs;
  while (d <= end) {
    if (d >= start) count++;
    d += stepMs;
  }
  return count;
}

interface VariableRowProps {
  envelope: EnvelopeWithOverride;
  monthlyBudget: number;
  actualSpend: number;
}

function VariableRow({ envelope, monthlyBudget, actualSpend }: VariableRowProps) {
  const now = new Date();
  const totalDays = daysInMonth(now.getFullYear(), now.getMonth());
  const dayOfMonth = now.getDate();
  const proRataPct = (dayOfMonth / totalDays) * 100;
  const proRataTarget = (dayOfMonth / totalDays) * monthlyBudget;

  const pct = monthlyBudget > 0 ? Math.min(100, (actualSpend / monthlyBudget) * 100) : 0;
  const overBudget = actualSpend > monthlyBudget;
  const aheadOfPace = !overBudget && actualSpend > proRataTarget;
  const fillCls = overBudget ? 'fill over' : aheadOfPace ? 'fill' : 'fill good';

  const remaining = monthlyBudget - actualSpend;

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
          {/* Pro-rata target line */}
          <div
            title={`Day ${dayOfMonth} of ${totalDays} — on-pace target: ${fmtAUD(proRataTarget)}`}
            style={{
              position: 'absolute', top: -3, bottom: -3,
              left: `${proRataPct}%`, width: 2,
              background: 'var(--ink-2)', opacity: 0.4,
              borderRadius: 1,
            }}
          />
          {/* Budget end marker */}
          <div
            style={{ position: 'absolute', top: -2, bottom: -2, left: '100%', width: 2, background: 'var(--ink)', opacity: 0.25 }}
          />
        </div>
      </div>
      <div className="nums">
        <div className={`v ${overBudget ? 'over' : aheadOfPace ? 'ok' : 'good'}`}>
          {actualSpend > 0
            ? overBudget
              ? `+${fmtAUD(actualSpend - monthlyBudget)} over`
              : `${fmtAUD(remaining)} left`
            : 'no spend logged'}
        </div>
        <div className="s">
          {actualSpend > 0
            ? `${fmtAUD(actualSpend)} of ${fmtAUD(monthlyBudget)}`
            : `budget ${fmtAUD(monthlyBudget)}`}
        </div>
      </div>
    </div>
  );
}

export default function EnvelopePanel({ bucketFilter = 'all' }: { bucketFilter?: 'all' | 'personal' | 'maple' }) {
  const { data: envData, isLoading: envLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.envelopes,
    queryFn: getEnvelopes,
  });
  const { data: reconData } = useQuery({
    queryKey: QUERY_KEYS.reconciliation,
    queryFn: getReconciliation,
  });

  if (envLoading) {
    return (
      <div className="card">
        <div className="hd"><h3>Variable spend · this month</h3></div>
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
  const periodPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;

  // Sum reconciliation records per budget item for the current month
  const spendByItem = new Map<string, number>();
  for (const r of reconData?.records ?? []) {
    if (r.date.startsWith(periodPrefix)) {
      spendByItem.set(r.budgetItemId, (spendByItem.get(r.budgetItemId) ?? 0) + r.actualAmount);
    }
  }

  // Only weekly/fortnightly variable items get a progress bar
  const variableEnvelopes = envData.envelopes.filter(
    (e) =>
      !e.deletedAt &&
      e.isVariable &&
      (e.frequency === 'weekly' || e.frequency === 'fortnightly') &&
      (bucketFilter === 'all' || e.bucket === bucketFilter),
  );

  return (
    <div className="card">
      <div className="hd">
        <h3>Envelope spend · this month</h3>
        <span className="sub">budget vs actual-to-date</span>
      </div>
      <div className="bd">
        {variableEnvelopes.length === 0 ? (
          <p style={{ color: 'var(--mute)', fontSize: 12, margin: 0 }}>
            No envelopes to track. Tag weekly/fortnightly items as variable in Notion to track spend here.
          </p>
        ) : (
          variableEnvelopes.map((env) => {
            const occurrences = countOccurrencesInMonth(
              env.dueDate,
              env.frequency as 'weekly' | 'fortnightly',
              env.recurInterval,
              year,
              month,
            );
            const monthlyBudget = env.forecastAmount * occurrences;
            const actualSpend = spendByItem.get(env.id) ?? 0;
            return (
              <VariableRow
                key={env.id}
                envelope={env}
                monthlyBudget={monthlyBudget}
                actualSpend={actualSpend}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
