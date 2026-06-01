import crypto from 'crypto';
import db from '../db';

// ---------------------------------------------------------------------------
// CSV reconciliation import — Phase 1: parse + preview (NO writes).
//
// Takes a bank CSV export, diffs every row against what's already in the DB
// (hand-logged spend, reconciliations, prior imports) and proposes an action
// per row. Nothing is written here — the route returns the proposals for the
// user to review; commit lands in a later phase.
// ---------------------------------------------------------------------------

export type ImportAccount = 'maple-debit' | 'personal-cc';

const ACCOUNT_META: Record<ImportAccount, { bucket: 'personal' | 'maple'; lane: 'cash' | 'credit' }> = {
  'maple-debit': { bucket: 'maple', lane: 'cash' },
  'personal-cc': { bucket: 'personal', lane: 'credit' },
};

// Catch-all envelope per account for discretionary spend no rule matched.
const FALLBACK_ENVELOPE: Record<ImportAccount, string> = {
  'maple-debit': 'Maple Spend',
  'personal-cc': 'Personal spend',
};

export interface ParsedRow {
  postDate: string;    // YYYY-MM-DD (statement posting date)
  valueDate: string;   // YYYY-MM-DD (real txn date from "Value Date:", else postDate)
  amount: number;      // signed; negative = money out
  description: string; // raw merchant string
  raw: string;         // original CSV line
}

export type ProposalStatus =
  | 'seen'            // already processed in a prior import (idempotent skip)
  | 'matched'         // matches an existing hand-logged spend / reconciliation
  | 'new-spend'       // create a spend_log entry in an envelope
  | 'reconcile-bill'  // reconcile a forecast bill to this actual
  | 'income'          // inflow — confirm in Notion, default skip
  | 'unmatched';      // no rule matched — user must categorise

export interface Proposal {
  fingerprint: string;
  postDate: string;
  valueDate: string;
  amount: number;
  description: string;
  status: ProposalStatus;
  confidence: 'high' | 'med' | 'low';
  targetItemId: string | null;
  targetName: string | null;
  bucket: 'personal' | 'maple' | null;
  lane: 'cash' | 'credit' | null;
  note: string | null;
}

// --- Payee map -------------------------------------------------------------
// Seeded from the merchants observed during the May reconciliation. Rules
// reference budget-item NAMES; they only resolve if such an item exists in the
// imported account's bucket, so the same list is safe across accounts.
interface PayeeRule { re: RegExp; item: string; kind: 'envelope' | 'bill'; }

const PAYEE_RULES: PayeeRule[] = [
  // Bills (match by payee; confidence refined by amount-vs-forecast below)
  { re: /OVO ENERGY/i,                       item: 'OVO Electricity',     kind: 'bill' },
  { re: /GLOBIRD/i,                          item: 'GloBird Energy Gas',  kind: 'bill' },
  { re: /JELC|KNOXFIELD/i,                   item: 'Childcare',           kind: 'bill' },
  { re: /SUPERLOOP/i,                        item: 'Superloop Internet',  kind: 'bill' },
  { re: /SOUTH EAST WATER/i,                 item: 'South East Water',    kind: 'bill' },
  { re: /HOSPITALS CONTRI/i,                 item: 'Health insurance',    kind: 'bill' },
  { re: /APPLE\.COM\/BILL|ICLOUD/i,          item: 'icloud',              kind: 'bill' },
  { re: /KNOX CITY COUNCIL/i,                item: 'Rates',               kind: 'bill' },
  // Groceries
  { re: /COLES|WOOLWORTH|\bWW\b|ALDI|\bIGA\b|HENRY|MERCATO|\bWBT\b|\bNQR\b|MARKET ?PLACE|SEAFOOD|BUTCHER|YARRA RANGE|ASIAN FOOD|AFC KNOX|GLOBAL FUSION|FOOD FACTORY|EVERYPLATE|GLEN ASIAN|TOPINDUSTRIES|BUYEMART/i, item: 'Groceries', kind: 'envelope' },
  // Dining
  { re: /BREADTOP|SY HE|UBER|MACHI|TGTG|TOO GOOD TO GO|DANIELS|BANH MI|HAYSUNG|MAGURO|PROSERPINA|YO ?MY|YOMG|\bKFC\b|SUSHI|SHANHE|MANTA RAY/i, item: 'Dining', kind: 'envelope' },
];

const INCOME_RE = /TRANSFER FROM|SEREI BILLS|RENT|DAYCARE|DAY CARE|SALARY|REFUND/i;

// --- CSV parsing -----------------------------------------------------------

// RFC-style field splitter: handles quoted fields and embedded commas/quotes.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function toIso(ddmmyyyy: string): string | null {
  const m = ddmmyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// CommBank export: `DD/MM/YYYY,"-5.03","DESCRIPTION",", +485.44"` — 4 cols, no
// header. Description often carries `Value Date: DD/MM/YYYY` (the real txn date)
// and a `Card xxNNNN`. Lines that don't parse cleanly (headers, blanks) are
// skipped.
export function parseCommBankCsv(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = splitCsvLine(line);
    if (cols.length < 3) continue;
    const postDate = toIso(cols[0]);
    const amount = parseFloat((cols[1] ?? '').replace(/[^0-9.\-]/g, ''));
    const description = (cols[2] ?? '').trim();
    if (!postDate || Number.isNaN(amount)) continue;
    const vd = description.match(/Value Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const valueDate = vd ? (toIso(vd[1]) ?? postDate) : postDate;
    rows.push({ postDate, valueDate, amount, description, raw: line });
  }
  return rows;
}

// --- Matching helpers ------------------------------------------------------

function fingerprint(account: string, valueDate: string, description: string, amount: number): string {
  return crypto
    .createHash('sha1')
    .update(`${account}|${valueDate}|${description}|${amount.toFixed(2)}`)
    .digest('hex');
}

function withinDays(a: string, b: string, n: number): boolean {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db_ = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db_)) return false;
  return Math.abs(da - db_) <= n * 86_400_000;
}

interface ItemRow { id: string; name: string; type: string; payment: string; forecast_amount: number; }

// --- Preview ---------------------------------------------------------------

export interface PreviewResult {
  account: ImportAccount;
  parsed: number;
  rows: Proposal[];
  summary: Record<ProposalStatus, number> & { newOutflow: number };
}

export function previewImport(account: ImportAccount, csv: string): PreviewResult {
  const { bucket, lane } = ACCOUNT_META[account];
  const rows = parseCommBankCsv(csv);

  const items = db
    .prepare('SELECT id, name, type, payment, forecast_amount FROM budget_items WHERE bucket = ? AND deleted_at IS NULL')
    .all(bucket) as ItemRow[];
  const itemByName = new Map(items.map(i => [i.name.toLowerCase(), i]));

  // Existing logged entries for dedup against hand-logging (date ±3d + |amount|;
  // description can't be used — the user's notes don't match bank merchant text).
  const spends = db
    .prepare('SELECT sl.date, sl.amount FROM spend_log sl JOIN budget_items bi ON bi.id = sl.budget_item_id WHERE bi.bucket = ?')
    .all(bucket) as Array<{ date: string; amount: number }>;
  const recons = db
    .prepare('SELECT r.date, r.actual_amount FROM reconciliation r JOIN budget_items bi ON bi.id = r.budget_item_id WHERE bi.bucket = ?')
    .all(bucket) as Array<{ date: string; actual_amount: number }>;
  const seen = new Set(
    (db.prepare('SELECT fingerprint FROM import_log WHERE account = ?').all(account) as Array<{ fingerprint: string }>)
      .map(r => r.fingerprint),
  );

  const fallback = itemByName.get(FALLBACK_ENVELOPE[account].toLowerCase()) ?? null;

  const proposals: Proposal[] = rows.map((row): Proposal => {
    const fp = fingerprint(account, row.valueDate, row.description, row.amount);
    const base = {
      fingerprint: fp, postDate: row.postDate, valueDate: row.valueDate,
      amount: row.amount, description: row.description,
    };
    const abs = Math.abs(row.amount);

    if (seen.has(fp)) {
      return { ...base, status: 'seen', confidence: 'high', targetItemId: null, targetName: null, bucket: null, lane: null, note: 'already imported on a prior run' };
    }

    const dupSpend = spends.find(s => Math.abs(s.amount) === abs && withinDays(s.date, row.valueDate, 3));
    const dupRecon = recons.find(r => r.actual_amount === abs && withinDays(r.date, row.valueDate, 3));
    if (dupSpend || dupRecon) {
      return { ...base, status: 'matched', confidence: 'high', targetItemId: null, targetName: null, bucket, lane, note: 'already logged by hand' };
    }

    // Inflows: contributions/transfers/refunds — handled by confirming in Notion.
    if (row.amount > 0) {
      return { ...base, status: 'income', confidence: INCOME_RE.test(row.description) ? 'med' : 'low', targetItemId: null, targetName: null, bucket, lane, note: 'inflow — confirm transfer/contribution in Notion' };
    }

    const rule = PAYEE_RULES.find(r => r.re.test(row.description));
    if (rule) {
      const item = itemByName.get(rule.item.toLowerCase());
      if (item) {
        if (rule.kind === 'bill') {
          const tol = Math.max(1, item.forecast_amount * 0.1);
          const conf = Math.abs(item.forecast_amount - abs) <= tol ? 'high' : 'med';
          return { ...base, status: 'reconcile-bill', confidence: conf, targetItemId: item.id, targetName: item.name, bucket, lane, note: `forecast ${item.forecast_amount.toFixed(2)}` };
        }
        return { ...base, status: 'new-spend', confidence: 'high', targetItemId: item.id, targetName: item.name, bucket, lane, note: null };
      }
    }

    // No rule: default discretionary spend to the catch-all envelope, low conf.
    return {
      ...base,
      status: fallback ? 'new-spend' : 'unmatched',
      confidence: 'low',
      targetItemId: fallback?.id ?? null,
      targetName: fallback?.name ?? null,
      bucket, lane,
      note: 'no rule matched — confirm category',
    };
  });

  const summary = proposals.reduce(
    (acc, p) => {
      acc[p.status] += 1;
      if (p.status === 'new-spend') acc.newOutflow += Math.abs(p.amount);
      return acc;
    },
    { seen: 0, matched: 0, 'new-spend': 0, 'reconcile-bill': 0, income: 0, unmatched: 0, newOutflow: 0 } as PreviewResult['summary'],
  );

  return { account, parsed: rows.length, rows: proposals, summary };
}
