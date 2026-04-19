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
  name: string;
  category: string | null;
  type: BudgetItemType;
  frequency: 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annual';
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

// Fixed-interval frequencies (weekly = 7, fortnightly = 14).
// Fast-forwards from anchor to the first occurrence >= from, then steps forward.
function expandFixed(anchor: Date, from: Date, to: Date, step: number): Date[] {
  const dates: Date[] = [];
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

// Monthly: same day-of-month, clamped to last day of each month.
function expandMonthly(anchor: Date, from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  const anchorDay = anchor.getDate();
  let d = clampDay(anchor.getFullYear(), anchor.getMonth(), anchorDay);
  while (d < from) {
    d = clampDay(d.getFullYear(), d.getMonth() + 1, anchorDay);
  }
  while (d <= to) {
    dates.push(d);
    d = clampDay(d.getFullYear(), d.getMonth() + 1, anchorDay);
  }
  return dates;
}

// Annual: same month+day each year, clamped (handles Feb 29 → Feb 28 on non-leap years).
function expandAnnual(anchor: Date, from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  let d = clampDay(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  while (d < from) {
    d = clampDay(d.getFullYear() + 1, anchor.getMonth(), anchor.getDate());
  }
  while (d <= to) {
    dates.push(d);
    d = clampDay(d.getFullYear() + 1, anchor.getMonth(), anchor.getDate());
  }
  return dates;
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

  switch (item.frequency) {
    case 'once':
      dates = anchor >= from && anchor <= to ? [anchor] : [];
      break;
    case 'weekly':
      dates = expandFixed(anchor, from, to, 7);
      break;
    case 'fortnightly':
      dates = expandFixed(anchor, from, to, 14);
      break;
    case 'monthly':
      dates = expandMonthly(anchor, from, to);
      break;
    case 'annual':
      dates = expandAnnual(anchor, from, to);
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

const stmtItems     = db.prepare('SELECT * FROM budget_items WHERE deleted_at IS NULL');
const stmtOverrides = db.prepare('SELECT budget_item_id, period, override_amount FROM envelope_overrides');
const stmtRecons    = db.prepare('SELECT budget_item_id, date, actual_amount, delta FROM reconciliation');

// ---------------------------------------------------------------------------
// computeCashFlow
// ---------------------------------------------------------------------------

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

  const items     = stmtItems.all()     as ItemRow[];
  const overrides = stmtOverrides.all() as OverrideRow[];
  const recons    = stmtRecons.all()    as ReconRow[];

  // Lookup maps keyed by `${id}:${period}` and `${id}:${date}` respectively
  const overrideMap = new Map<string, number>();
  for (const o of overrides) {
    overrideMap.set(`${o.budget_item_id}:${o.period}`, o.override_amount);
  }

  const reconMap = new Map<string, ReconRow>();
  for (const r of recons) {
    reconMap.set(`${r.budget_item_id}:${r.date}`, r);
  }

  // Partition into overdue (due_date < openingBalanceDate) and current.
  // An overdue card's due_date hasn't been rolled forward by the Notion
  // automation, so the whole card is suppressed from forward projection —
  // surfaced separately via overdueItems / overdueTotals.
  const overdueItems: OverdueItem[] = [];
  const overdueTotals: OverdueTotals = { personal: 0, maple: 0 };
  const currentItems: ItemRow[] = [];

  for (const item of items) {
    if (!item.frequency || !item.type || !item.due_date) continue;
    if (openingBalanceDate && item.due_date < openingBalanceDate) {
      const daysOverdue = Math.round(
        (seedDate.getTime() - parseDate(item.due_date).getTime()) / 86_400_000
      );
      overdueItems.push({
        budgetItemId:   item.id,
        name:           item.name,
        bucket:         item.bucket,
        forecastAmount: item.forecast_amount,
        dueDate:        item.due_date,
        daysOverdue,
      });
      overdueTotals[item.bucket] += item.forecast_amount;
    } else {
      currentItems.push(item);
    }
  }

  // Buckets: non-CC occurrences keyed by date; CC occurrences keyed by statement due date.
  // nonCCByDate is pre-seeded for every day in [walkStart, to] so the output has no gaps.
  const nonCCByDate = new Map<string, Occurrence[]>();
  const ccByDueDate = new Map<string, Occurrence[]>();

  for (let d = walkStart; d <= toDate; d = addDays(d, 1)) {
    nonCCByDate.set(fmtDate(d), []);
  }

  // CC items are expanded from 35 days before walkStart so that items whose
  // occurrence date falls in the previous statement period (before walkStart)
  // but whose CC due date lands inside [walkStart, to] are captured correctly.
  const ccFrom = addDays(walkStart, -35);
  const walkStartStr = fmtDate(walkStart);

  for (const item of currentItems) {
    if (item.payment === 'Credit') {
      const occs = buildOccurrences(item, ccFrom, toDate, overrideMap, reconMap);
      for (const occ of occs) {
        const due = fmtDate(ccDueDate(parseDate(occ.date), closeDay, dueDay));
        if (due >= walkStartStr && due <= to) {
          if (!ccByDueDate.has(due)) ccByDueDate.set(due, []);
          ccByDueDate.get(due)!.push(occ);
        }
      }
    } else {
      const occs = buildOccurrences(item, walkStart, toDate, overrideMap, reconMap);
      for (const occ of occs) {
        nonCCByDate.get(occ.date)?.push(occ);
      }
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

    // Non-CC items: affect the bucket they belong to
    for (const occ of nonCCByDate.get(dateStr) ?? []) {
      const amount = occ.actualAmount ?? occ.overrideAmount ?? occ.forecastAmount;

      if (occ.type === 'income') {
        if (occ.bucket === 'personal') balP += amount; else balM += amount;
        inflow += amount;
      } else {
        // expense or transfer
        if (occ.bucket === 'personal') balP -= amount; else balM -= amount;
        outflow += amount;
      }

      breakdown.push(makeLineItem(occ, false));
    }

    // CC statement deductions always hit Personal (CC is locked to Personal per spec)
    for (const occ of ccByDueDate.get(dateStr) ?? []) {
      const amount = occ.actualAmount ?? occ.overrideAmount ?? occ.forecastAmount;
      balP -= amount;
      outflow += amount;
      breakdown.push(makeLineItem(occ, true));
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

  // adjustedEntries: same walk, but with overdue totals deducted from seed per
  // bucket — represents the balance if overdue bills were paid today.
  const overdueP = overdueTotals.personal;
  const overdueM = overdueTotals.maple;
  const adjustedEntries: CashFlowEntry[] = entries.map(e => ({
    ...e,
    balP:    e.balP - overdueP,
    balM:    e.balM - overdueM,
    balance: e.balance - overdueP - overdueM,
  }));

  return { entries, adjustedEntries, overdueItems, overdueTotals };
}

function makeLineItem(occ: Occurrence, isCC: boolean): LineItem {
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
    payment:        occ.payment,
  };
}
