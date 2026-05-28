import db from '../db';
import type {
  BudgetItemType, Bucket, CashFlowEntry, LineItem,
  OverdueItem, OverdueTotals, CashFlowResult, CCStatement,
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
  is_variable: number;
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
// CC statement cycle
//
// Each statement is { period, periodStart, closeDate, dueDate }. Spend lands
// on the first statement whose closeDate >= occurrence date; the bundled
// total is debited on that statement's dueDate.
//
// Defaults: close on closeDay-of-month; due on dueDay-of-month (wrapped to
// next month if dueDay < closeDay). Overrides from cc_statement_overrides
// replace the default close/due for that period.
// ---------------------------------------------------------------------------

interface CCOverrideRow {
  period: string;
  close_date: string;
  due_date: string;
}

function defaultCloseDate(year: number, month: number, closeDay: number): Date {
  return clampDay(year, month, closeDay);
}

function defaultDueDate(closeYear: number, closeMonth: number, closeDay: number, dueDay: number): Date {
  // Due wraps into the next month when dueDay < closeDay (e.g. close 7th, due 4th of next month).
  let dy = closeYear, dm = closeMonth;
  if (dueDay < closeDay) {
    dm++;
    if (dm > 11) { dm = 0; dy++; }
  }
  return clampDay(dy, dm, dueDay);
}

// Build a sorted statements list covering [walkStart - 2 months, toDate + 2 months].
// The buffer keeps us safe against past credit spend bundling forward and
// future occurrences bundling onto a statement just past the range.
function buildStatements(
  walkStart: Date,
  toDate: Date,
  closeDay: number,
  dueDay: number,
  overrides: CCOverrideRow[],
): CCStatement[] {
  const overrideMap = new Map(overrides.map(o => [o.period, o] as const));

  const start = new Date(walkStart.getFullYear(), walkStart.getMonth() - 2, 1);
  const end   = new Date(toDate.getFullYear(),   toDate.getMonth() + 2,   1);

  const stmts: CCStatement[] = [];
  for (let m = new Date(start); m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const period = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    const ov     = overrideMap.get(period);
    const close  = ov ? parseDate(ov.close_date) : defaultCloseDate(m.getFullYear(), m.getMonth(), closeDay);
    const due    = ov ? parseDate(ov.due_date)   : defaultDueDate(m.getFullYear(), m.getMonth(), closeDay, dueDay);

    stmts.push({
      period,
      periodStart: '', // filled below
      closeDate:   fmtDate(close),
      dueDate:     fmtDate(due),
      isOverride:  !!ov,
    });
  }

  // periodStart = day after previous statement's close. The first statement
  // has no predecessor in the buffer; default it to one day after a synthetic
  // prior-month close (which lies before the buffer anyway).
  for (let i = 0; i < stmts.length; i++) {
    if (i === 0) {
      const prior = new Date(start.getFullYear(), start.getMonth() - 1, 1);
      const priorClose = defaultCloseDate(prior.getFullYear(), prior.getMonth(), closeDay);
      stmts[i].periodStart = fmtDate(addDays(priorClose, 1));
    } else {
      stmts[i].periodStart = fmtDate(addDays(parseDate(stmts[i - 1].closeDate), 1));
    }
  }

  return stmts;
}

// First statement whose closeDate >= occDateStr. Returns null if none —
// caller drops the occurrence (it falls past the buffered statement range).
function statementForOccurrence(occDateStr: string, statements: CCStatement[]): CCStatement | null {
  for (const s of statements) {
    if (s.closeDate >= occDateStr) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal occurrence type — richer than LineItem, used during computation
// ---------------------------------------------------------------------------

interface Occurrence {
  date: string;
  budgetItemId: string;
  txId: string | null;
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
      txId:           null,
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

const stmtItems         = db.prepare('SELECT * FROM budget_items WHERE deleted_at IS NULL');
const stmtOverrides     = db.prepare('SELECT budget_item_id, period, override_amount FROM envelope_overrides');
const stmtRecons        = db.prepare('SELECT budget_item_id, date, actual_amount, delta FROM reconciliation');
const stmtTransactions  = db.prepare('SELECT * FROM transactions');
const stmtCCOverrides   = db.prepare('SELECT period, close_date, due_date FROM cc_statement_overrides');
const stmtSpendLog     = db.prepare(`
  SELECT sl.budget_item_id, sl.date, sl.amount, sl.payment, sl.note
  FROM   spend_log sl
  JOIN   budget_items bi ON bi.id = sl.budget_item_id
  WHERE  bi.deleted_at IS NULL
  ORDER  BY sl.date
`);

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
  isEnvelopeRemainder: boolean;
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
  const ccOverrides  = stmtCCOverrides.all()  as { period: string; close_date: string; due_date: string }[];

  // Statement cycle list — drives CC bundling. One entry per (close month)
  // across [walkStart - 2mo, toDate + 2mo]. Overrides replace defaults.
  const ccStatements = buildStatements(walkStart, toDate, closeDay, dueDay, ccOverrides);

  interface SpendLogRow { budget_item_id: string; date: string; amount: number; payment: 'cash' | 'credit'; note: string | null; }
  const spendRows = stmtSpendLog.all() as SpendLogRow[];
  const spendByItemPeriod = new Map<string, SpendLogRow[]>();
  for (const s of spendRows) {
    const key = `${s.budget_item_id}:${s.date.slice(0, 7)}`;
    if (!spendByItemPeriod.has(key)) spendByItemPeriod.set(key, []);
    spendByItemPeriod.get(key)!.push(s);
  }

  const todayDate    = new Date();
  const todayStr     = fmtDate(todayDate);
  const currentPeriod = fmtPeriod(todayDate);

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
  //   - Overdue: unconfirmed AND expected_date <= today. The day has arrived
  //     (or passed) without user acknowledgement. Surfaced via overdueItems/
  //     overdueTotals AND placed in the breakdown on expected_date so today's
  //     awaiting-ack rows still appear in the chart-day view. Balance is NOT
  //     moved (the real debit/credit hasn't happened yet).
  //   - Confirmed: moves the balance on its cash-effect date (confirmed_date,
  //     or the statement due date for CC items).
  //   - Projected: unconfirmed AND expected_date > today. Genuine forecast —
  //     moves the balance as if paid on time.
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
    // Envelope items (is_variable) bypass the transaction path entirely —
    // their spend entries are placed directly from spend_log below.
    const txItem = itemByPage.get(tx.notion_page_id);
    if (!txItem) continue; // budget item deleted — skip its transactions
    if (txItem.is_variable) continue;

    if (tx.confirmed === 1) {
      confirmedTxs.push(tx);
      continue;
    }
    if (!tx.expected_date) continue;

    unconfirmedExpectedByPage.set(tx.notion_page_id, tx.expected_date);

    if (tx.expected_date <= todayStr) {
      const item = itemByPage.get(tx.notion_page_id);
      const frequency = (tx.frequency ?? item?.frequency ?? 'once') as ItemRow['frequency'];
      const interval  = Math.max(1, tx.recur_interval ?? item?.recur_interval ?? 1);
      const expected  = parseDate(tx.expected_date);
      const missedCycles = countMissedCycles(frequency, interval, expected, todayDate);
      const totalOwed    = tx.amount * missedCycles;
      const daysOverdue  = Math.round((todayDate.getTime() - expected.getTime()) / 86_400_000);
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
      txId:           tx?.id ?? null,
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
    isEnvelopeRemainder = false,
  ): void {
    const scheduled: Scheduled = { occ, ...flags, isEnvelopeRemainder };
    if (payment === 'Credit') {
      const stmt = statementForOccurrence(targetDateStr, ccStatements);
      if (!stmt) return; // beyond statement buffer — drop
      const stmtDue = stmt.dueDate;
      if (stmtDue >= walkStartStr && stmtDue <= to) {
        if (!ccByDueDate.has(stmtDue)) ccByDueDate.set(stmtDue, []);
        ccByDueDate.get(stmtDue)!.push(scheduled);
      }
    } else {
      if (targetDateStr >= walkStartStr && targetDateStr <= to) {
        nonCCByDate.get(targetDateStr)?.push(scheduled);
      }
    }
  }

  // 1. Confirmed transactions — move the balance on their cash-effect date.
  // For formerly-overdue items, deduct ALL missed cycles (not just one): the
  // ledger tracks one tx row but the user paid the full overdue liability.
  for (const tx of confirmedTxs) {
    if (!tx.confirmed_date) continue;
    const item = itemByPage.get(tx.notion_page_id);
    let occ = occurrenceFrom(item, tx, tx.confirmed_date);

    const expDate = tx.expected_date;
    if (expDate && expDate <= todayStr) {
      const freq     = (tx.frequency ?? item?.frequency ?? 'once') as ItemRow['frequency'];
      const interval = Math.max(1, tx.recur_interval ?? item?.recur_interval ?? 1);
      const missed   = countMissedCycles(freq, interval, parseDate(expDate), todayDate);
      if (missed > 1) occ = { ...occ, forecastAmount: tx.amount * missed };
    }

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
    if (item.is_variable) continue; // handled in envelope pass below
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

  // 5. Envelope items (is_variable) — individual spend entries as actuals on
  //    their real dates, plus a projected "remaining budget" occurrence on the
  //    period's occurrence date (or end-of-month if that date has already passed).
  function lastDayOfMonth(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }

  for (const item of items) {
    if (!item.is_variable || !item.frequency || !item.due_date) continue;

    const interval = Math.max(1, item.recur_interval ?? 1);
    const anchor   = parseDate(item.due_date);
    let occDates: Date[];
    switch (item.frequency) {
      case 'weekly':      occDates = expandFixed(anchor, walkStart, toDate, 7, interval); break;
      case 'fortnightly': occDates = expandFixed(anchor, walkStart, toDate, 14, interval); break;
      case 'monthly':     occDates = expandMonthly(anchor, walkStart, toDate, interval); break;
      case 'annual':      occDates = expandAnnual(anchor, walkStart, toDate, interval); break;
      case 'once':        occDates = anchor >= walkStart && anchor <= toDate ? [anchor] : []; break;
      default:            occDates = [];
    }

    const periodsSeen = new Set<string>();

    // Lane-aware: each spend entry is routed by its own payment lane (cash →
    // direct cash-flow hit, credit → bundled into next CC statement). The
    // forecast remainder draws down only the lane that matches the envelope's
    // default payment — the other lane is purely additive on top of forecast.
    const matchingLane: 'cash' | 'credit' =
      item.payment === 'Credit' ? 'credit' : 'cash';

    for (const occDate of occDates) {
      const period = fmtPeriod(occDate);
      if (periodsSeen.has(period)) continue;
      periodsSeen.add(period);

      const entries       = spendByItemPeriod.get(`${item.id}:${period}`) ?? [];
      const matchingTotal = entries
        .filter(e => e.payment === matchingLane)
        .reduce((t, e) => t + e.amount, 0);
      const cap           = overrideMap.get(`${item.id}:${period}`) ?? item.forecast_amount;
      const remaining     = Math.max(0, cap - matchingTotal);

      // Place each actual spend entry on its real date, routed by its own
      // lane: 'credit' → CC bundling, 'cash' → direct balance hit. The
      // routing key ('Credit' triggers placeOnDay's CC branch) is separate
      // from the display label shown in the LineItem.
      for (const entry of entries) {
        if (entry.date > to) continue;
        const isCreditLane = entry.payment === 'credit';
        // Cash entries dated before walkStart already hit the bank — skip them.
        // Credit entries dated before walkStart are still outstanding on the
        // card; placeOnDay will land them on the upcoming statement-due date,
        // which it already gates against walkStart.
        if (!isCreditLane && entry.date < walkStartStr) continue;
        const routeKey     = isCreditLane ? 'Credit' : 'Cash';
        // Display name prefers the per-spend note (what the user typed when
        // logging it — e.g. "Coffee at Bell Lane"), falling back to the
        // envelope name when the note is empty. Without this, every entry
        // shows up as the envelope name (e.g. "Personal Spend") in the CC
        // tile, ledger, and on-this-date card.
        const displayName = entry.note?.trim() ? entry.note.trim() : item.name;
        placeOnDay(
          {
            date: entry.date, budgetItemId: item.id, txId: null, name: displayName,
            category: item.category, type: item.type, bucket: item.bucket,
            payment: routeKey, forecastAmount: 0,
            overrideAmount: null, actualAmount: entry.amount,
            delta: null, isReconciled: true,
          },
          routeKey, entry.date,
          { isConfirmed: true, isPending: false, isProjected: false },
        );
      }

      // Project remaining budget only for the current and future periods.
      if (remaining > 0 && period >= currentPeriod) {
        const occDateStr   = fmtDate(occDate);
        const remainingDate = (period === currentPeriod && occDateStr < todayStr)
          ? fmtDate(lastDayOfMonth(todayDate))
          : occDateStr;

        if (remainingDate >= walkStartStr && remainingDate <= to) {
          placeOnDay(
            {
              date: remainingDate, budgetItemId: item.id, txId: null, name: item.name,
              category: item.category, type: item.type, bucket: item.bucket,
              payment: item.payment, forecastAmount: remaining,
              overrideAmount: null, actualAmount: null,
              delta: null, isReconciled: false,
            },
            item.payment, remainingDate,
            { isConfirmed: false, isPending: false, isProjected: true },
            true, // isEnvelopeRemainder — excluded from actualsEntries
          );
        }
      }
    }
  }

  // 5b. Past-period credit spend. The envelope loop only walks occurrences
  //     within [walkStart, toDate], so periods strictly before currentPeriod
  //     are never visited. Cash spend in those periods has already settled
  //     against the bank; credit spend is still outstanding on the card and
  //     bundles onto the upcoming statement.
  const itemById = new Map(items.map(i => [i.id, i] as const));
  for (const s of spendRows) {
    if (s.payment !== 'credit') continue;
    if (s.date.slice(0, 7) >= currentPeriod) continue;
    const item = itemById.get(s.budget_item_id);
    if (!item) continue;
    // Same note-vs-envelope name preference as step 5 above — keep them in
    // sync or we'll get inconsistent labels between current and prior periods.
    const displayName = s.note?.trim() ? s.note.trim() : item.name;
    placeOnDay(
      {
        date: s.date, budgetItemId: item.id, txId: null, name: displayName,
        category: item.category, type: item.type, bucket: item.bucket,
        payment: 'Credit', forecastAmount: 0,
        overrideAmount: null, actualAmount: s.amount,
        delta: null, isReconciled: true,
      },
      'Credit', s.date,
      { isConfirmed: true, isPending: false, isProjected: false },
    );
  }

  // Day-by-day balance computation
  let balP = initBalP,  balM = initBalM;
  let actP = initBalP,  actM = initBalM;
  const entries: CashFlowEntry[]        = [];
  const actualsEntries: CashFlowEntry[] = [];

  for (let d = walkStart; d <= toDate; d = addDays(d, 1)) {
    const dateStr = fmtDate(d);
    let inflow = 0, outflow = 0;
    const breakdown: LineItem[] = [];

    for (const s of nonCCByDate.get(dateStr) ?? []) {
      const amount = s.occ.actualAmount ?? s.occ.overrideAmount ?? s.occ.forecastAmount;

      if (s.isConfirmed || s.isProjected) {
        if (s.occ.type === 'income') {
          if (s.occ.bucket === 'personal') { balP += amount; if (!s.isEnvelopeRemainder) actP += amount; }
          else                             { balM += amount; if (!s.isEnvelopeRemainder) actM += amount; }
          inflow += amount;
        } else {
          if (s.occ.bucket === 'personal') { balP -= amount; if (!s.isEnvelopeRemainder) actP -= amount; }
          else                             { balM -= amount; if (!s.isEnvelopeRemainder) actM -= amount; }
          outflow += amount;
        }
      }

      breakdown.push(makeLineItem(s.occ, false, s.isConfirmed, s.isPending, s.isProjected));
    }

    for (const s of ccByDueDate.get(dateStr) ?? []) {
      const amount = s.occ.actualAmount ?? s.occ.overrideAmount ?? s.occ.forecastAmount;

      if (s.isConfirmed || s.isProjected) {
        balP -= amount;
        if (!s.isEnvelopeRemainder) actP -= amount;
        outflow += amount;
      }

      breakdown.push(makeLineItem(s.occ, true, s.isConfirmed, s.isPending, s.isProjected));
    }

    if (dateStr >= emitStartStr) {
      entries.push({ date: dateStr, balance: balP + balM, balP, balM, inflow, outflow, breakdown });
      actualsEntries.push({ date: dateStr, balance: actP + actM, balP: actP, balM: actM, inflow, outflow, breakdown });
    }
  }

  const netP = overdueTotals.personal.owedIn - overdueTotals.personal.owedOut;
  const netM = overdueTotals.maple.owedIn    - overdueTotals.maple.owedOut;
  const adjustedEntries: CashFlowEntry[] = entries.map(e => ({
    ...e,
    balP:    e.balP + netP,
    balM:    e.balM + netM,
    balance: e.balance + netP + netM,
  }));

  return {
    entries, actualsEntries, adjustedEntries, overdueItems, overdueTotals,
    ccConfig: { closeDay, dueDay },
    ccStatements,
  };
}

function makeLineItem(
  occ: Occurrence,
  isCC: boolean,
  isConfirmed: boolean,
  isPending: boolean,
  isProjected: boolean,
): LineItem {
  return {
    budgetItemId:   occ.budgetItemId,
    txId:           occ.txId,
    name:           occ.name,
    category:       occ.category ?? '',
    type:           occ.type,
    bucket:         occ.bucket,
    date:           occ.date,
    forecastAmount: occ.forecastAmount,
    overrideAmount: occ.overrideAmount,
    actualAmount:   occ.actualAmount,
    delta:          occ.delta,
    isReconciled:   occ.isReconciled,
    isCC,
    isConfirmed,
    isPending,
    isProjected,
    payment:        occ.payment,
  };
}
