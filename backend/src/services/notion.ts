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
  'Name', 'Type', 'Category', 'Amount',
  'Frequency', 'Due Date', 'Variable', 'Payment', 'Tags',
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

function extractCheckbox(prop: unknown): boolean {
  return (prop as any)?.checkbox ?? false;
}

function extractMultiSelect(prop: unknown): string[] {
  return (prop as any)?.multi_select?.map((t: { name: string }) => t.name) ?? [];
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

  const name = extractTitle(p['Name']);
  if (!name) return null;

  const type = extractSelect(p['Type'])?.toLowerCase();
  const frequency = extractSelect(p['Frequency'])?.toLowerCase();
  const dueDate = extractDate(p['Due Date']);

  // Core scheduling fields are required for the cash engine to work
  if (!type || !frequency || !dueDate) return null;

  const tags = extractMultiSelect(p['Tags']);
  const bucket = tags.some(t => t.toLowerCase().includes('maple')) ? 'maple' : 'personal';

  return {
    notion_page_id: page.id,
    name,
    category: extractSelect(p['Category']),
    type,
    frequency,
    due_date: dueDate,
    is_variable: extractCheckbox(p['Variable']) ? 1 : 0,
    bucket,
    payment: extractSelect(p['Payment']) ?? 'Direct Debit',
    forecast_amount: extractNumber(p['Amount']),
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
    id, notion_page_id, name, category, type, frequency,
    due_date, is_variable, bucket, payment, forecast_amount, deleted_at
  ) VALUES (
    @id, @notion_page_id, @name, @category, @type, @frequency,
    @due_date, @is_variable, @bucket, @payment, @forecast_amount, NULL
  )
  ON CONFLICT(notion_page_id) DO UPDATE SET
    name            = excluded.name,
    category        = excluded.category,
    type            = excluded.type,
    frequency       = excluded.frequency,
    due_date        = excluded.due_date,
    is_variable     = excluded.is_variable,
    bucket          = excluded.bucket,
    payment         = excluded.payment,
    forecast_amount = excluded.forecast_amount,
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
      for (const page of pages) {
        if (page.archived) {
          softDeleteOneStmt.run(page.id);
          continue;
        }

        const row = mapPageToRow(page);
        if (!row) continue;

        returnedIds.push(page.id);
        upsertStmt.run({ id: uuidv4(), ...row });
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
