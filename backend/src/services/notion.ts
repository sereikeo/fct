import { Client, isFullPage } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';

export type SyncStatus = {
  syncedAt: string | null;
  itemCount: number;
  error?: string;
};

const EXPECTED_PROPERTIES = [
  'Bill', 'Amount', 'Budget', 'Payment', 'Due', 'Recur Interval', 'Recur Unit', 'Tags', 'Status',
];

let syncStatus: SyncStatus = { syncedAt: null, itemCount: 0 };
let lastSyncTime: Date | null = null;

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ---------------------------------------------------------------------------
// Property extractors
// ---------------------------------------------------------------------------

function extractTitle(prop: unknown): string {
  return (prop as any)?.title?.[0]?.plain_text ?? '';
}

function extractSelect(prop: unknown): string | null {
  return (prop as any)?.select?.name ?? null;
}

function extractNumber(prop: unknown): number {
  return (prop as any)?.number ?? 0;
}

function extractDate(prop: unknown): string | null {
  return (prop as any)?.date?.start ?? null;
}

function extractMultiSelect(prop: unknown): string[] {
  return (prop as any)?.multi_select?.map((t: { name: string }) => t.name) ?? [];
}

function extractCheckbox(prop: unknown): boolean {
  return (prop as any)?.checkbox === true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateProperties(props: Record<string, unknown>): string[] {
  return EXPECTED_PROPERTIES.filter(p => !(p in props));
}

// ---------------------------------------------------------------------------
// Page → row mapping
// ---------------------------------------------------------------------------

function mapPageToRow(page: PageObjectResponse): Record<string, unknown> | null {
  const p = page.properties;

  const name = extractTitle(p['Bill']);
  if (!name) return null;

  const tags = extractMultiSelect(p['Tags']);
  if (tags.some(t => t.toLowerCase() === 'excluded')) return null;
  const bucket = tags.some(t => t.toLowerCase().includes('maple')) ? 'maple' : 'personal';
  const isVariable = tags.includes('Variable expense') ? 1 : 0;

  // Budget select: 'Income', 'Expense', 'subscription' → normalise to type
  const budget = extractSelect(p['Budget'])?.toLowerCase() ?? 'expense';
  const type =
    budget === 'income' ? 'income'
    : budget === 'transfer' ? 'transfer'
    : 'expense';

  // Recur Unit select: 'Month(s)', 'Week(s)', 'Year(s)', 'Day(s)'
  // Recur Interval: integer multiplier. Pair (unit, interval) maps to
  // (frequency, recur_interval) — the engine steps by base_step × interval.
  const recurUnit = extractSelect(p['Recur Unit']) ?? '';
  const notionInterval = extractNumber(p['Recur Interval']) || 1;
  let frequency: 'weekly' | 'fortnightly' | 'monthly' | 'annual';
  let recurInterval = notionInterval;
  if (recurUnit.startsWith('Week')) {
    // Week(s)/1 → weekly, Week(s)/2 → fortnightly (same cadence, use
    // dedicated enum value), Week(s)/N (N≥3) → weekly × N.
    if (notionInterval === 1) { frequency = 'weekly'; recurInterval = 1; }
    else if (notionInterval === 2) { frequency = 'fortnightly'; recurInterval = 1; }
    else { frequency = 'weekly'; recurInterval = notionInterval; }
  } else if (recurUnit.startsWith('Fortnight')) {
    frequency = 'fortnightly';
  } else if (recurUnit.startsWith('Year')) {
    frequency = 'annual';
  } else if (recurUnit.startsWith('Day')) {
    frequency = 'weekly'; // fallback — treat daily as weekly
  } else {
    frequency = 'monthly'; // Month(s) or unknown
  }

  const done = extractCheckbox(p['Status']);
  const status = done ? 'done' : 'not started';

  return {
    notion_page_id: page.id,
    name,
    category: null,
    type,
    frequency,
    recur_interval: recurInterval,
    due_date: extractDate(p['Due']) ?? null,
    is_variable: isVariable,
    bucket,
    payment: extractSelect(p['Payment']) ?? 'Direct Debit',
    forecast_amount: extractNumber(p['Amount']),
    status,
  };
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// INSERT OR REPLACE would delete-then-reinsert, triggering FK violations once
// envelope_overrides / reconciliation child rows exist. ON CONFLICT DO UPDATE
// updates in place — same upsert semantics, no FK cascade risk.
const upsertStmt = db.prepare(`
  INSERT INTO budget_items (
    id, notion_page_id, name, category, type, frequency, recur_interval,
    due_date, is_variable, bucket, payment, forecast_amount, status, deleted_at
  ) VALUES (
    @id, @notion_page_id, @name, @category, @type, @frequency, @recur_interval,
    @due_date, @is_variable, @bucket, @payment, @forecast_amount, @status, NULL
  )
  ON CONFLICT(notion_page_id) DO UPDATE SET
    name            = excluded.name,
    category        = excluded.category,
    type            = excluded.type,
    frequency       = excluded.frequency,
    recur_interval  = excluded.recur_interval,
    due_date        = excluded.due_date,
    is_variable     = excluded.is_variable,
    bucket          = excluded.bucket,
    payment         = excluded.payment,
    forecast_amount = excluded.forecast_amount,
    status          = excluded.status,
    deleted_at      = NULL,
    updated_at      = datetime('now')
`);

// Used in full sync: soft-delete rows absent from the returned set.
// Guarded by returnedIds.length > 0 so an empty response never wipes the table.
const softDeleteMissingStmt = db.prepare(`
  UPDATE budget_items
  SET    deleted_at = datetime('now')
  WHERE  deleted_at IS NULL
    AND  notion_page_id NOT IN (SELECT value FROM json_each(?))
`);

const softDeleteOneStmt = db.prepare(`
  UPDATE budget_items
  SET    deleted_at = datetime('now')
  WHERE  notion_page_id = ?
`);

const countActiveStmt = db.prepare(
  `SELECT COUNT(*) AS count FROM budget_items WHERE deleted_at IS NULL`
);

// ---------------------------------------------------------------------------
// Transaction ledger — detects confirmations by comparing Notion's current
// state against what FCT last recorded.
// ---------------------------------------------------------------------------

interface TxRow {
  id: string;
  notion_page_id: string;
  frequency: string | null;
  recur_interval: number | null;
  expected_date: string | null;
}

const stmtGetUnconfirmedTx = db.prepare(
  'SELECT id, notion_page_id, frequency, recur_interval, expected_date FROM transactions WHERE notion_page_id = ? AND confirmed = 0 LIMIT 1'
);

const stmtInsertTx = db.prepare(`
  INSERT INTO transactions (
    id, notion_page_id, name, type, bucket, frequency, recur_interval,
    expected_date, amount, confirmed, confirmed_date
  ) VALUES (
    @id, @notion_page_id, @name, @type, @bucket, @frequency, @recur_interval,
    @expected_date, @amount, 0, NULL
  )
`);

const stmtConfirmTx = db.prepare(`
  UPDATE transactions
  SET    confirmed = 1, confirmed_date = date('now'), updated_at = datetime('now')
  WHERE  id = ?
`);

const stmtRescheduleTx = db.prepare(`
  UPDATE transactions
  SET    expected_date = ?, updated_at = datetime('now')
  WHERE  id = ?
`);

function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function clampLastDay(year: number, month: number, day: number): Date {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last));
}

// Returns the date exactly one interval after `expected` for the given frequency.
function oneIntervalAhead(expected: Date, frequency: string | null, recurInterval: number | null): Date {
  const step = Math.max(1, recurInterval ?? 1);
  switch (frequency) {
    case 'weekly':
      return new Date(expected.getFullYear(), expected.getMonth(), expected.getDate() + 7 * step);
    case 'fortnightly':
      return new Date(expected.getFullYear(), expected.getMonth(), expected.getDate() + 14 * step);
    case 'monthly':
      return clampLastDay(expected.getFullYear(), expected.getMonth() + step, expected.getDate());
    case 'annual':
      return clampLastDay(expected.getFullYear() + step, expected.getMonth(), expected.getDate());
    default:
      return expected;
  }
}

function isOnceOff(frequency: string | null | undefined, recurInterval: number | null | undefined): boolean {
  return !frequency || frequency === 'once' || !recurInterval || recurInterval === 0;
}

function updateTransactionLedger(row: {
  notion_page_id: string;
  name: string;
  type: string;
  bucket: string;
  frequency: string;
  recur_interval: number;
  due_date: string | null;
  forecast_amount: number;
  status: string;
}): void {
  if (!row.due_date) return;

  const existing = stmtGetUnconfirmedTx.get(row.notion_page_id) as TxRow | undefined;
  const isOnce = isOnceOff(row.frequency, row.recur_interval);

  if (isOnce) {
    if (!existing) {
      stmtInsertTx.run({
        id:             uuidv4(),
        notion_page_id: row.notion_page_id,
        name:           row.name,
        type:           row.type,
        bucket:         row.bucket,
        frequency:      row.frequency || null,
        recur_interval: row.recur_interval || null,
        expected_date:  row.due_date,
        amount:         row.forecast_amount,
      });
    } else if (row.status === 'done') {
      stmtConfirmTx.run(existing.id);
    }
    return;
  }

  // Recurring: compare due_date against the ledger's expected_date.
  if (!existing) {
    stmtInsertTx.run({
      id:             uuidv4(),
      notion_page_id: row.notion_page_id,
      name:           row.name,
      type:           row.type,
      bucket:         row.bucket,
      frequency:      row.frequency,
      recur_interval: row.recur_interval,
      expected_date:  row.due_date,
      amount:         row.forecast_amount,
    });
    return;
  }

  if (!existing.expected_date) return;
  if (existing.expected_date === row.due_date) return; // unchanged

  const expected    = parseIsoDate(existing.expected_date);
  const currentDue  = parseIsoDate(row.due_date);
  const nextCycle   = oneIntervalAhead(expected, existing.frequency, existing.recur_interval);

  if (currentDue >= nextCycle) {
    // Notion advanced by ≥ one full interval → previous cycle was paid.
    stmtConfirmTx.run(existing.id);
    stmtInsertTx.run({
      id:             uuidv4(),
      notion_page_id: row.notion_page_id,
      name:           row.name,
      type:           row.type,
      bucket:         row.bucket,
      frequency:      row.frequency,
      recur_interval: row.recur_interval,
      expected_date:  row.due_date,
      amount:         row.forecast_amount,
    });
  } else {
    // Rescheduled — keep unconfirmed, just bump expected_date.
    stmtRescheduleTx.run(row.due_date, existing.id);
  }
}

// ---------------------------------------------------------------------------
// Notion API fetch (paginated, rate-limited)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllPages(
  filter?: Record<string, unknown>
): Promise<PageObjectResponse[]> {
  const databaseId = process.env.NOTION_DATABASE_ID!;
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  let first = true;

  while (true) {
    if (!first) await sleep(350); // stay under 3 req/s
    first = false;

    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      ...(filter ? { filter: filter as any } : {}),
    });

    for (const page of response.results) {
      if (isFullPage(page)) pages.push(page);
    }

    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

export async function runSync(full = false): Promise<void> {
  if (!process.env.NOTION_DATABASE_ID) throw new Error('NOTION_DATABASE_ID is not set');

  const filter =
    !full && lastSyncTime
      ? {
          timestamp: 'last_edited_time',
          last_edited_time: { after: lastSyncTime.toISOString() },
        }
      : undefined;

  // Capture start time before fetching so any pages edited during a slow sync
  // are not missed on the next incremental run.
  const syncStartTime = new Date();

  try {
    const pages = await fetchAllPages(filter);

    // Validate property names against the first page on every full sync.
    if (full && pages.length > 0) {
      const missing = validateProperties(pages[0].properties);
      if (missing.length > 0) {
        // Preserve the mapping error in status but continue — map what we can.
        syncStatus = {
          ...syncStatus,
          error: `Missing Notion properties: ${missing.join(', ')}`,
        };
      }
    }

    const returnedIds: string[] = [];

    const doSync = db.transaction(() => {
      const mapped: Array<ReturnType<typeof mapPageToRow>> = [];

      for (const page of pages) {
        if (page.archived) {
          softDeleteOneStmt.run(page.id);
          continue;
        }

        const row = mapPageToRow(page);
        if (!row) continue;

        returnedIds.push(page.id);
        upsertStmt.run({ id: uuidv4(), ...row });
        mapped.push(row);
      }

      // Second pass: update transactions ledger for each mapped row. Runs in
      // the same transaction so a failure rolls back both the upsert and the
      // ledger writes.
      for (const row of mapped) {
        if (!row) continue;
        updateTransactionLedger(row as Parameters<typeof updateTransactionLedger>[0]);
      }

      // Only soft-delete on a full sync and only when we have mapped rows —
      // guards against an all-unmappable response wiping existing data.
      if (full && returnedIds.length > 0) {
        softDeleteMissingStmt.run(JSON.stringify(returnedIds));
      }
    });

    doSync();
    lastSyncTime = syncStartTime;

    const { count } = countActiveStmt.get() as { count: number };
    syncStatus = {
      syncedAt: syncStartTime.toISOString(),
      itemCount: count,
      // Preserve any mapping errors from validation; clear transport errors.
      ...(syncStatus.error?.startsWith('Missing Notion') ? { error: syncStatus.error } : {}),
    };
  } catch (err) {
    syncStatus = {
      ...syncStatus,
      error: err instanceof Error ? err.message : String(err),
    };
    throw err;
  }
}

export function startScheduledSync(): void {
  const interval = parseInt(process.env.SYNC_INTERVAL_MS ?? '300000', 10);
  setInterval(() => {
    runSync(false).catch(err =>
      console.error('[notion-sync] scheduled sync failed:', err)
    );
  }, interval);
}

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}
