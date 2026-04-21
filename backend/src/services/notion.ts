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
  const isVariable = tags.some(t => t.toLowerCase().includes('variable')) ? 1 : 0;
  const isEnvelope = tags.some(t => t.toLowerCase().includes('envelope')) ? 1 : 0;

  // Budget select values may be composite like 'Maple-Income' or 'Maple-Bills'.
  // All Notion amounts are positive — type determines the sign in the engine.
  // Check budget select first, fall back to Tags for the same keywords.
  const budget = extractSelect(p['Budget'])?.toLowerCase() ?? '';
  const tagStr = tags.map(t => t.toLowerCase()).join(' ');
  const combined = `${budget} ${tagStr}`;
  const type =
    combined.includes('income')   ? 'income'
    : combined.includes('transfer') ? 'transfer'
    : 'expense';

  // Recur Unit select: 'Month(s)', 'Week(s)', 'Year(s)', 'Day(s)' — or null
  // when the item is a genuine once-off (no recurrence configured in Notion).
  // Recur Interval: integer multiplier. Pair (unit, interval) maps to
  // (frequency, recur_interval) — the engine steps by base_step × interval.
  const recurUnit    = extractSelect(p['Recur Unit']);
  const rawInterval  = extractNumber(p['Recur Interval']); // 0 when unset

  const done   = extractCheckbox(p['Status']);
  const status = done ? 'done' : 'not started';

  const common = {
    notion_page_id: page.id,
    name,
    category: null,
    type,
    due_date: extractDate(p['Due']) ?? null,
    is_variable: isVariable,
    is_envelope: isEnvelope,
    bucket,
    payment: extractSelect(p['Payment']) ?? 'Direct Debit',
    forecast_amount: extractNumber(p['Amount']),
    status,
  };

  // Once-off: no Recur Unit AND no Recur Interval. These get frequency=null
  // and recur_interval=0 so the engine + ledger treat them as single-shot.
  if (!recurUnit && !rawInterval) {
    return {
      ...common,
      frequency: null,
      recur_interval: 0,
    };
  }

  const notionInterval = rawInterval || 1;
  let frequency: 'weekly' | 'fortnightly' | 'monthly' | 'annual';
  let recurInterval = notionInterval;
  const unit = recurUnit ?? '';
  if (unit.startsWith('Week')) {
    // Week(s)/1 → weekly, Week(s)/2 → fortnightly (same cadence, use
    // dedicated enum value), Week(s)/N (N≥3) → weekly × N.
    if (notionInterval === 1) { frequency = 'weekly'; recurInterval = 1; }
    else if (notionInterval === 2) { frequency = 'fortnightly'; recurInterval = 1; }
    else { frequency = 'weekly'; recurInterval = notionInterval; }
  } else if (unit.startsWith('Fortnight')) {
    frequency = 'fortnightly';
  } else if (unit.startsWith('Year')) {
    frequency = 'annual';
  } else if (unit.startsWith('Day')) {
    frequency = 'weekly'; // fallback — treat daily as weekly
  } else {
    frequency = 'monthly'; // Month(s) or unknown
  }

  return {
    ...common,
    frequency,
    recur_interval: recurInterval,
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
    due_date, is_variable, is_envelope, bucket, payment, forecast_amount, status, deleted_at
  ) VALUES (
    @id, @notion_page_id, @name, @category, @type, @frequency, @recur_interval,
    @due_date, @is_variable, @is_envelope, @bucket, @payment, @forecast_amount, @status, NULL
  )
  ON CONFLICT(notion_page_id) DO UPDATE SET
    name            = excluded.name,
    category        = excluded.category,
    type            = excluded.type,
    frequency       = excluded.frequency,
    recur_interval  = excluded.recur_interval,
    due_date        = excluded.due_date,
    is_variable     = excluded.is_variable,
    is_envelope     = excluded.is_envelope,
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

const stmtInsertConfirmedTx = db.prepare(`
  INSERT INTO transactions (
    id, notion_page_id, name, type, bucket, frequency, recur_interval,
    expected_date, amount, confirmed, confirmed_date
  ) VALUES (
    @id, @notion_page_id, @name, @type, @bucket, @frequency, @recur_interval,
    @expected_date, @amount, 1, date('now')
  )
`);

// Used to find a confirmed once-off tx that the user may have un-ticked in Notion.
const stmtGetConfirmedOnceTx = db.prepare(
  'SELECT id FROM transactions WHERE notion_page_id = ? AND confirmed = 1 LIMIT 1'
);

const stmtDeleteTx = db.prepare('DELETE FROM transactions WHERE id = ?');

// Confirms a tx and snapshots the current Notion amount so the confirmed
// record reflects what was actually paid, not a stale per-cycle figure.
const stmtConfirmTx = db.prepare(`
  UPDATE transactions
  SET    confirmed = 1, confirmed_date = date('now'), amount = @amount, updated_at = datetime('now')
  WHERE  id = @id
`);

// Syncs an unconfirmed ledger row with the latest Notion state. Confirmed
// rows are historical snapshots and are never touched here.
const stmtSyncUnconfirmedTx = db.prepare(`
  UPDATE transactions
  SET    name           = @name,
         type           = @type,
         bucket         = @bucket,
         frequency      = @frequency,
         recur_interval = @recur_interval,
         expected_date  = @expected_date,
         amount         = @amount,
         updated_at     = datetime('now')
  WHERE  id = @id AND confirmed = 0
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
  frequency: string | null;
  recur_interval: number;
  due_date: string | null;
  forecast_amount: number;
  status: string;
}): void {
  if (!row.due_date) return;

  const existing = stmtGetUnconfirmedTx.get(row.notion_page_id) as TxRow | undefined;
  const isOnce = isOnceOff(row.frequency, row.recur_interval);

  // Mutable fields we want the active unconfirmed row to mirror from Notion
  // (amount, name, category, due-date shifts — anything the user can edit
  // after we first created the ledger row).
  const syncArgs = () => ({
    id:             existing!.id,
    name:           row.name,
    type:           row.type,
    bucket:         row.bucket,
    frequency:      row.frequency || null,
    recur_interval: row.recur_interval || null,
    expected_date:  row.due_date,
    amount:         row.forecast_amount,
  });

  const insertArgs = () => ({
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

  if (isOnce) {
    const confirmedRow = stmtGetConfirmedOnceTx.get(row.notion_page_id) as { id: string } | undefined;
    if (confirmedRow) return; // confirmed snapshot exists — never overwrite

    const today = new Date().toISOString().slice(0, 10);
    const isDue  = row.due_date <= today;

    if (isDue) {
      // Once-offs are auto-confirmed on or after their due date.
      // No Notion automation or status change required.
      if (existing) {
        stmtConfirmTx.run({ id: existing.id, amount: row.forecast_amount });
      } else {
        stmtInsertConfirmedTx.run(insertArgs());
      }
    } else {
      // Future once-off — keep as a projected unconfirmed entry.
      if (existing) {
        stmtSyncUnconfirmedTx.run(syncArgs());
      } else {
        stmtInsertTx.run(insertArgs());
      }
    }
    return;
  }

  // Recurring: compare due_date against the ledger's expected_date.
  if (!existing) {
    stmtInsertTx.run(insertArgs());
    return;
  }

  if (!existing.expected_date) return;

  const expected   = parseIsoDate(existing.expected_date);
  const currentDue = parseIsoDate(row.due_date);
  const nextCycle  = oneIntervalAhead(expected, existing.frequency, existing.recur_interval);

  if (currentDue >= nextCycle) {
    // Notion advanced by ≥ one full interval → previous cycle was paid.
    stmtConfirmTx.run({ id: existing.id, amount: row.forecast_amount });
    stmtInsertTx.run(insertArgs());
    return;
  }

  // Unchanged or short reschedule — keep the row, sync every mutable field
  // so a post-creation Notion edit (amount, name, small date bump) is
  // reflected in the ledger.
  stmtSyncUnconfirmedTx.run(syncArgs());
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
