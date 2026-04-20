import db from '../db';
import type {
  BudgetItemType, Bucket, CashFlowEntry, LineItem,
  OverdueItem, OverdueTotals, CashFlowResult,
} from '../types';

// ---------------------------------------------------------------------------
// Config — read inside computeCashFlow so tests can override process.env
// ---------------------------------------------------------------------------

function getConfig() {
  const closeDay = parseInt(process.env.CC_STMT_CLOSE_DAY ?? '12', 10);
  const dueDay   = parseInt(process.env.CC_STMT_DUE_DAY   ?? '25', 10);
  const total    = parseFloat(process.env.FCT_OPENING_BALANCE ?? '0');
  const balP     = process.env.FCT_OPENING_BALANCE_PERSONAL !== undefined
    ? parseFloat(process.env.FCT_OPENING_BALANCE_PERSONAL)
    : total / 2;
  const balM     = process.env.FCT_OPENING_BALANCE_MAPLE !== undefined
    ? parseFloat(process.env.FCT_OPENING_BALANCE_MAPLE)
    : total / 2;
  const openingBalanceDate = process.env.FCT_OPENING_BALANCE_DATE?.trim() || null;
  return { closeDay, dueDay, balP, balM, openingBalanceDate };
}

// ---------------------------------------------------------------------------
// SQLite row shapes (snake_case from DB)
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  notion_page_id: string;
  name: string;
  category: string | null;
  type: BudgetItemType;
  frequency: 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annual';
  recur_interval: number;
  due_date: string;
  bucket: Bucket;
  payment: string;
  forecast_amount: number;
}

interface OverrideRow {
  budget_item_id: string;
  period: string;
  override_amount: number;
}

interface ReconRow {
  budget_item_id: string;
  date: string;
  actual_amount: number;
  delta: number;
}

// ---------------------------------------------------------------------------
// Date helpers — all dates stay in local time to avoid UTC off-by-one errors
// ---------------------------------------------------------------------------

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(d: Date): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

function fmtPeriod(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Clamp a day value to the last valid day of the given year+month.
// e.g. clampDay(2024, 1, 31) → Feb 29 2024 (leap year)
function clampDay(year: number, month: number, day: number): Date {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last));
}

// ---------------------------------------------------------------------------
// Recurring expansion
// ---------------------------------------------------------------------------

// Fixed-interval frequencies (weekly = 7 days, fortnightly = 14 days). The
// effective step is baseStep × recurInterval — e.g. weekly × 4 = every 28 days.
// Fast-forwards from anchor to the first occurrence >= from, then steps forward.
function expandFixed(anchor: Date, from: Date, to: Date, baseStep: number, recurInterval: number): Date[] {
  const dates: Date[] = [];
  const step = baseStep * Math.max(1, recurInterval);
  let d = anchor;
  if (d < from) {
    const diffDays = Math.ceil((from.getTime() - d.getTime()) / 86_400_000);
    d = addDays(anchor, Math.ceil(diffDays / step) * step);
  }
  while (d <= to) {
    if (d >= from) dates.push(d);
    d = addDays(d, step);
  }
  return dates;
}

// Monthly: same day-of-month, clamped to last day of each month. Advances by
// recurInterval months per step (monthly × 3 = quarterly).
function expandMonthly(anchor: Date, from: Date, to: Date, recurInterval: number): Date[] {
  const dates: Date[] = [];
  const step = Math.max(1, recurInterval);
  const anchorDay = anchor.getDate();
  let d = clampDay(anchor.getFullYear(), anchor.getMonth(), anchorDay);
  while (d < from) {
    d = clampDay(d.getFullYear(), d.getMonth() + step, anchorDay);
  }
  while (d <= to) {
    dates.push(d);
    d = clampDay(d.getFullYear(), d.getMonth() + step, anchorDay);
  }
  return dates;
}

// Annual: same month+day each year, clamped (handles Feb 29 → Feb 28 on non-leap
// years). Advances by recurInterval years per step.
function expandAnnual(anchor: Date, from: Date, to: Date, recurInterval: number): Date[] {
  const dates: Date[] = [];
  const step = Math.max(1, recurInterval);
  let d = clampDay(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  while (d < from) {
    d = clampDay(d.getFullYear() + step, anchor.getMonth(), anchor.getDate());
  }
  while (d <= to) {
    dates.push(d);
    d = clampDay(d.getFullYear() + step, anchor.getMonth(), anchor.getDate());
  }
  return dates;
}

// Counts occurrences from dueDate (inclusive) up to openingDate (inclusive) —
// i.e. how many payment cycles are owed. A bill due today but not yet ack'd
// counts as one cycle; a bill three months late counts as however many
// anchored cycles have landed on or before today.
function countMissedCycles(
  frequency: ItemRow['frequency'],
  recurInterval: number,
  dueDate: Date,
  openingDate: Date,
): number {
  if (dueDate > openingDate) return 0;
  const to = openingDate;
  switch (frequency) {
    case 'once':        return 1;
    case 'weekly':      return expandFixed(dueDate, dueDate, to, 7, recurInterval).length;
    case 'fortnightly': return expandFixed(dueDate, dueDate, to, 14, recurInterval).length;
    case 'monthly':     return expandMonthly(dueDate, dueDate, to, recurInterval).length;
    case 'annual':      return expandAnnual(dueDate, dueDate, to, recurInterval).length;
    default:            return 1;
  }
}

// ---------------------------------------------------------------------------
// CC statement due date
//
// Statement period: from (closeDay+1 of prev month) to closeDay of current month.
// If the item's day <= closeDay  → closes this month → due this month (or next if dueDay < closeDay).
// If the item's day >  closeDay → closes next month → due accordingly.
// ---------------------------------------------------------------------------

function ccDueDate(occDate: Date, closeDay: number, dueDay: number): Date {
  const day = occDate.getDate();
  let cm = occDate.getMonth();
  let cy = occDate.getFullYear();

  if (day > closeDay) {
    // Statement closes in the following month
    cm++;
    if (cm > 11) { cm = 0; cy++; }
  }

  // Due date is in the close month unless dueDay < closeDay (due wraps to next month)
  let dm = cm, dy = cy;
  if (dueDay < closeDay) {
    dm++;
    if (dm > 11) { dm = 0; dy++; }
  }

  return clampDay(dy, dm, dueDay);
}

// ---------------------------------------------------------------------------
// Internal occurrence type — richer than LineItem, used during computation
// ---------------------------------------------------------------------------

interface Occurrence {
  date: string;
  budgetItemId: string;
  name: string;
  category: string | null;
  type: BudgetItemType;
  bucket: Bucket;
  payment: string;
  forecastAmount: number;
  overrideAmount: number | null;
  actualAmount: number | null;
  delta: number | null;
  isReconciled: boolean;
}

function buildOccurrences(
  item: ItemRow,
  from: Date,
  to: Date,
  overrideMap: Map<string, number>,
  reconMap: Map<string, ReconRow>,
): Occurrence[] {
  const anchor = parseDate(item.due_date);
  let dates: Date[];

  const interval = Math.max(1, item.recur_interval ?? 1);
  switch (item.frequency) {
    case 'once':
      dates = anchor >= from && anchor <= to ? [anchor] : [];
      break;
    case 'weekly':
      dates = expandFixed(anchor, from, to, 7, interval);
      break;
    case 'fortnightly':
      dates = expandFixed(anchor, from, to, 14, interval);
      break;
    case 'monthly':
      dates = expandMonthly(anchor, from, to, interval);
      break;
    case 'annual':
      dates = expandAnnual(anchor, from, to, interval);
      break;
    default:
      dates = [];
  }

  return dates.map(d => {
    const dateStr  = fmtDate(d);
    const period   = fmtPeriod(d);
    const override = overrideMap.get(`${item.id}:${period}`) ?? null;
    const recon    = reconMap.get(`${item.id}:${dateStr}`) ?? null;

    return {
      date:           dateStr,
      budgetItemId:   item.id,
      name:           item.name,
      category:       item.category,
      type:           item.type,
      bucket:         item.bucket,
      payment:        item.payment,
      forecastAmount: item.forecast_amount,
      overrideAmount: override,
      actualAmount:   recon?.actual_amount ?? null,
      delta:          recon?.delta ?? null,
      isReconciled:   recon !== null,
    };
  });
}

// ---------------------------------------------------------------------------
// Prepared statements (compiled once at module load, schema is already applied)
// ---------------------------------------------------------------------------

const stmtItems        = db.prepare('SELECT * FROM budget_items WHERE deleted_at IS NULL');
const stmtOverrides    = db.prepare('SELECT budget_item_id, period, override_amount FROM envelope_overrides');
const stmtRecons       = db.prepare('SELECT budget_item_id, date, actual_amount, delta FROM reconciliation');
const stmtTransactions = db.prepare('SELECT * FROM transactions');

interface TxRow {
  id: string;
  notion_page_id: string;
  name: string;
  type: BudgetItemType;
  bucket: Bucket;
  frequency: ItemRow['frequency'] | null;
  recur_interval: number | null;
  expected_date: string | null;
  amount: number;
  confirmed: 0 | 1;
  confirmed_date: string | null;
}

// Returns the date exactly one interval after `expected`. Mirrors the stepping
// logic in the expansion helpers — used when starting forward projection from
// the occurrence after the ledger's current unconfirmed row.
function oneIntervalAhead(
  expected: Date,
  frequency: ItemRow['frequency'],
  recurInterval: number,
): Date {
  const step = Math.max(1, recurInterval);
  switch (frequency) {
    case 'weekly':      return addDays(expected, 7 * step);
    case 'fortnightly': return addDays(expected, 14 * step);
    case 'monthly':     return clampDay(expected.getFullYear(), expected.getMonth() + step, expected.getDate());
    case 'annual':      return clampDay(expected.getFullYear() + step, expected.getMonth(), expected.getDate());
    case 'once':        return expected;
    default:            return expected;
  }
}

// ---------------------------------------------------------------------------
// computeCashFlow
// ---------------------------------------------------------------------------

// DayBucket entry — wraps an Occurrence with ledger state.
interface Scheduled {
  occ: Occurrence;
  isConfirmed: boolean;
  isPending: boolean;
  isProjected: boolean;
}

export function computeCashFlow(from: string, to: string): CashFlowResult {
  const { closeDay, dueDay, balP: initBalP, balM: initBalM, openingBalanceDate } = getConfig();

  const fromDate = parseDate(from);
  const toDate   = parseDate(to);

  // Seed is anchored at openingBalanceDate (fallback: fromDate). The walk
  // always starts at the seed — if the seed is before `from`, we walk
  // forward through `from` to arrive at the correct seed for [from, to];
  // if the seed is after `from`, we have no balance information for dates
  // before the seed, so we skip them.
  const seedDate     = openingBalanceDate ? parseDate(openingBalanceDate) : fromDate;
  const walkStart    = seedDate;
  const emitStart    = seedDate > fromDate ? seedDate : fromDate;
  const emitStartStr = fmtDate(emitStart);

  const items        = stmtItems.all()        as ItemRow[];
  const overrides    = stmtOverrides.all()    as OverrideRow[];
  const recons       = stmtRecons.all()       as ReconRow[];
  const transactions = stmtTransactions.all() as TxRow[];

  // Lookup maps keyed by `${id}:${period}` and `${id}:${date}` respectively
  const overrideMap = new Map<string, number>();
  for (const o of overrides) {
    overrideMap.set(`${o.budget_item_id}:${o.period}`, o.override_amount);
  }

  const reconMap = new Map<string, ReconRow>();
  for (const r of recons) {
    reconMap.set(`${r.budget_item_id}:${r.date}`, r);
  }

  // Index items by notion_page_id for cross-referencing with the transaction ledger.
  const itemByPage = new Map<string, ItemRow>();
  for (const item of items) itemByPage.set(item.notion_page_id, item);

  // Partition transactions into overdue, confirmed, and projected.
  //   - Overdue: unconfirmed AND expected_date <= openingBalanceDate. The day
  //     has arrived (or passed) without user acknowledgement. Surfaced via
  //     overdueItems/overdueTotals AND placed in the breakdown on expected_date
  //     so today's awaiting-ack rows still appear in the chart-day view.
  //     Balance is NOT moved (the real debit/credit hasn't happened yet).
  //   - Confirmed: moves the balance on its cash-effect date (confirmed_date,
  //     or the statement due date for CC items).
  //   - Projected: unconfirmed AND expected_date > openingBalanceDate. Genuine
  //     forecast — moves the balance as if paid on time.
  //
  // Future cycles are still forecast for overdue items — the card being
  // overdue only means the *current* cycle hasn't been ack'd, not that the
  // whole schedule is frozen. Expansion uses oneIntervalAhead(tracked) for
  // both overdue and projected rows.
  const overdueItems: OverdueItem[] = [];
  const overdueTotals: OverdueTotals = {
    personal: { owedIn: 0, owedOut: 0 },
    maple:    { owedIn: 0, owedOut: 0 },
  };
  const unconfirmedExpectedByPage = new Map<string, string>(); // page id → expected_date of active ledger row (overdue or projected)
  const confirmedTxs:  TxRow[] = [];
  const projectedTxs:  TxRow[] = [];
  const overdueTxs:    TxRow[] = [];

  for (const tx of transactions) {
    if (tx.confirmed === 1) {
      confirmedTxs.push(tx);
      continue;
    }
    if (!tx.expected_date) continue;

    unconfirmedExpectedByPage.set(tx.notion_page_id, tx.expected_date);

    if (openingBalanceDate && tx.expected_date <= openingBalanceDate) {
      const item = itemByPage.get(tx.notion_page_id);
      const frequency = (tx.frequency ?? item?.frequency ?? 'once') as ItemRow['frequency'];
      const interval  = Math.max(1, tx.recur_interval ?? item?.recur_interval ?? 1);
      const expected  = parseDate(tx.expected_date);
      const missedCycles = countMissedCycles(frequency, interval, expected, seedDate);
      const totalOwed    = tx.amount * missedCycles;
      const daysOverdue  = Math.round((seedDate.getTime() - expected.getTime()) / 86_400_000);
      overdueItems.push({
        budgetItemId:   item?.id ?? tx.notion_page_id,
        name:           tx.name,
        type:           tx.type,
        bucket:         tx.bucket,
        forecastAmount: tx.amount,
        dueDate:        tx.expected_date,
        daysOverdue,
        missedCycles,
        totalOwed,
      });
      if (tx.type === 'income') overdueTotals[tx.bucket].owedIn  += totalOwed;
      else                       overdueTotals[tx.bucket].owedOut += totalOwed;
      overdueTxs.push(tx);
    } else {
      projectedTxs.push(tx);
    }
  }

  // Buckets: non-CC occurrences keyed by date; CC occurrences keyed by statement due date.
  // Pre-seeded for every day in [walkStart, to] so the output has no gaps.
  const nonCCByDate = new Map<string, Scheduled[]>();
  const ccByDueDate = new Map<string, Scheduled[]>();

  for (let d = walkStart; d <= toDate; d = addDays(d, 1)) {
    nonCCByDate.set(fmtDate(d), []);
  }

  const walkStartStr = fmtDate(walkStart);

  function occurrenceFrom(
    item: ItemRow | undefined,
    tx: TxRow | null,
    dateStr: string,
  ): Occurrence {
    const period   = fmtPeriod(parseDate(dateStr));
    const override = item ? overrideMap.get(`${item.id}:${period}`) ?? null : null;
    const recon    = item ? reconMap.get(`${item.id}:${dateStr}`) ?? null : null;
    return {
      date:           dateStr,
      budgetItemId:   item?.id ?? tx?.notion_page_id ?? '',
      name:           tx?.name ?? item?.name ?? '',
      category:       item?.category ?? null,
      type:           (tx?.type ?? item?.type ?? 'expense') as BudgetItemType,
      bucket:         (tx?.bucket ?? item?.bucket ?? 'personal') as Bucket,
      payment:        item?.payment ?? '',
      forecastAmount: tx?.amount ?? item?.forecast_amount ?? 0,
      overrideAmount: override,
      actualAmount:   recon?.actual_amount ?? null,
      delta:          recon?.delta ?? null,
      isReconciled:   recon !== null,
    };
  }

  function placeOnDay(
    occ: Occurrence,
    payment: string,
    targetDateStr: string,
    flags: { isConfirmed: boolean; isPending: boolean; isProjected: boolean },
  ): void {
    if (payment === 'Credit') {
      const stmtDue = fmtDate(ccDueDate(parseDate(targetDateStr), closeDay, dueDay));
      if (stmtDue >= walkStartStr && stmtDue <= to) {
        if (!ccByDueDate.has(stmtDue)) ccByDueDate.set(stmtDue, []);
        ccByDueDate.get(stmtDue)!.push({ occ, ...flags });
      }
    } else {
      if (targetDateStr >= walkStartStr && targetDateStr <= to) {
        nonCCByDate.get(targetDateStr)?.push({ occ, ...flags });
      }
    }
  }

  // 1. Confirmed transactions — move the balance on their cash-effect date.
  for (const tx of confirmedTxs) {
    if (!tx.confirmed_date) continue;
    const item = itemByPage.get(tx.notion_page_id);
    const occ = occurrenceFrom(item, tx, tx.confirmed_date);
    placeOnDay(occ, item?.payment ?? '', tx.confirmed_date, {
      isConfirmed: true, isPending: false, isProjected: false,
    });
  }

  // 2. Projected (future, unconfirmed) transactions — move the balance on
  //    expected_date as if paid on time.
  for (const tx of projectedTxs) {
    if (!tx.expected_date) continue;
    const item = itemByPage.get(tx.notion_page_id);
    const occ = occurrenceFrom(item, tx, tx.expected_date);
    placeOnDay(occ, item?.payment ?? '', tx.expected_date, {
      isConfirmed: false, isPending: false, isProjected: true,
    });
  }

  // 3. Overdue transactions — show in breakdown on expected_date (so today's
  //    awaiting-ack rows appear in the chart day), but do NOT move the
  //    balance. Strictly-past overdue (expected_date before walkStart) won't
  //    land via placeOnDay's range check and stay only in the overdue panel.
  for (const tx of overdueTxs) {
    if (!tx.expected_date) continue;
    const item = itemByPage.get(tx.notion_page_id);
    const occ = occurrenceFrom(item, tx, tx.expected_date);
    placeOnDay(occ, item?.payment ?? '', tx.expected_date, {
      isConfirmed: false, isPending: true, isProjected: false,
    });
  }

  // 4. Expansion — future occurrences beyond the ledger's currently-tracked one.
  // Overdue items still get their future cycles forecast: only the current
  // cycle is awaiting ack; subsequent ones are expected on schedule.
  const ccFrom = addDays(walkStart, -35);

  for (const item of items) {
    if (!item.frequency || !item.type || !item.due_date) continue;

    const interval = Math.max(1, item.recur_interval ?? 1);

    // If a ledger row exists, expand starting one interval past its expected_date
    // so we don't duplicate the already-placed unconfirmed occurrence.
    const tracked = unconfirmedExpectedByPage.get(item.notion_page_id);
    const anchor  = tracked
      ? oneIntervalAhead(parseDate(tracked), item.frequency, interval)
      : parseDate(item.due_date);

    if (item.frequency === 'once') {
      // Once-off: the ledger row (if any) already covers the single occurrence.
      // With no ledger row, place the single occurrence if it falls in range.
      if (!tracked && anchor >= walkStart && anchor <= toDate) {
        const dateStr = fmtDate(anchor);
        const occ = occurrenceFrom(item, null, dateStr);
        placeOnDay(occ, item.payment, dateStr, {
          isConfirmed: false, isPending: false, isProjected: true,
        });
      }
      continue;
    }

    const expansionFrom = item.payment === 'Credit' ? ccFrom : walkStart;
    let dates: Date[];
    switch (item.frequency) {
      case 'weekly':      dates = expandFixed(anchor, expansionFrom, toDate, 7, interval); break;
      case 'fortnightly': dates = expandFixed(anchor, expansionFrom, toDate, 14, interval); break;
      case 'monthly':     dates = expandMonthly(anchor, expansionFrom, toDate, interval); break;
      case 'annual':      dates = expandAnnual(anchor, expansionFrom, toDate, interval); break;
      default:            dates = [];
    }

    for (const d of dates) {
      const dateStr = fmtDate(d);
      const occ = occurrenceFrom(item, null, dateStr);
      placeOnDay(occ, item.payment, dateStr, {
        isConfirmed: false, isPending: false, isProjected: true,
      });
    }
  }

  // Day-by-day balance computation
  let balP = initBalP;
  let balM = initBalM;
  const entries: CashFlowEntry[] = [];

  for (let d = walkStart; d <= toDate; d = addDays(d, 1)) {
    const dateStr = fmtDate(d);
    let inflow = 0;
    let outflow = 0;
    const breakdown: LineItem[] = [];

    for (const s of nonCCByDate.get(dateStr) ?? []) {
      const amount = s.occ.actualAmount ?? s.occ.overrideAmount ?? s.occ.forecastAmount;

      // Confirmed (historical) and projected (future forecast) both move the
      // balance. Pending (past unconfirmed) is surfaced separately via
      // overdueItems and must not be double-counted here.
      if (s.isConfirmed || s.isProjected) {
        if (s.occ.type === 'income') {
          if (s.occ.bucket === 'personal') balP += amount; else balM += amount;
          inflow += amount;
        } else {
          if (s.occ.bucket === 'personal') balP -= amount; else balM -= amount;
          outflow += amount;
        }
      }

      breakdown.push(makeLineItem(s.occ, false, s.isPending, s.isProjected));
    }

    // CC statement deductions hit Personal only (CC is locked to Personal).
    for (const s of ccByDueDate.get(dateStr) ?? []) {
      const amount = s.occ.actualAmount ?? s.occ.overrideAmount ?? s.occ.forecastAmount;

      if (s.isConfirmed || s.isProjected) {
        balP -= amount;
        outflow += amount;
      }

      breakdown.push(makeLineItem(s.occ, true, s.isPending, s.isProjected));
    }

    if (dateStr >= emitStartStr) {
      entries.push({
        date:      dateStr,
        balance:   balP + balM,
        balP,
        balM,
        inflow,
        outflow,
        breakdown,
      });
    }
  }

  // adjustedEntries: same walk, but shifted by the net overdue impact per
  // bucket — represents the balance if all overdue were resolved. owedIn
  // raises the balance (money arriving), owedOut lowers it (bills paid).
  const netP = overdueTotals.personal.owedIn - overdueTotals.personal.owedOut;
  const netM = overdueTotals.maple.owedIn    - overdueTotals.maple.owedOut;
  const adjustedEntries: CashFlowEntry[] = entries.map(e => ({
    ...e,
    balP:    e.balP + netP,
    balM:    e.balM + netM,
    balance: e.balance + netP + netM,
  }));

  return { entries, adjustedEntries, overdueItems, overdueTotals };
}

function makeLineItem(
  occ: Occurrence,
  isCC: boolean,
  isPending: boolean,
  isProjected: boolean,
): LineItem {
  return {
    budgetItemId:   occ.budgetItemId,
    name:           occ.name,
    category:       occ.category ?? '',
    type:           occ.type,
    bucket:         occ.bucket,
    forecastAmount: occ.forecastAmount,
    overrideAmount: occ.overrideAmount,
    actualAmount:   occ.actualAmount,
    delta:          occ.delta,
    isReconciled:   occ.isReconciled,
    isCC,
    isPending,
    isProjected,
    payment:        occ.payment,
  };
}
