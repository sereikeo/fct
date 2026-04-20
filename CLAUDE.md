# FCT — Future Cash Timeline

A personal financial dashboard that syncs a Notion budget database and projects cash position forward in time via an interactive timeline scrubber.

Hosted at `fct.sereikeo.dev` via Cloudflare Tunnel on a Synology NAS Docker host.

---

## Architecture

```
Browser → Cloudflare Access (GitHub OAuth) → Cloudflare Tunnel → Caddy → React frontend
                                                                         → /api/* → Node.js BFF → SQLite (NAS volume)
                                                                                                 → Notion API (scheduled sync, read-only)
```

**BFF pattern.** The frontend never calls Notion directly. All Notion access is proxied through the Node.js backend. The Notion integration token lives server-side only.

**Two data stores:**
- **Notion** — read-only source of truth for budget envelopes. Never written to.
- **SQLite** — everything else: cached Notion snapshot, envelope overrides, reconciliation records.

**Scheduled sync.** Notion is polled every 5 minutes and denormalised into SQLite. The frontend always reads from SQLite, never Notion directly. This sidesteps the 3 req/s rate limit.

**Cash engine runs server-side.** The BFF computes `{date, balance, inflow, outflow, breakdown}[]` and serves it as a pre-computed array. The frontend scrubs through it without any re-calculation.

---

## Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Fast dev, type safety |
| Styling | Tailwind CSS | Utility-first, consistent with design tokens |
| Charts / scrubber | Recharts | Declarative JSX API; scrubber interaction wires to React state naturally. Chart.js was considered and rejected — its imperative canvas API makes the scrubber awkward |
| Data fetching | TanStack Query | Cache, background refetch, stale-while-revalidate out of the box |
| Backend | Node.js + Express + TypeScript | Lightweight BFF |
| Validation | Zod | All routes validate input before hitting the service layer |
| DB client | better-sqlite3 | Synchronous, no ORM — plain query functions |
| DB | SQLite (NAS volume mount) | Local, zero latency, no cloud dependency |
| Proxy | Caddy | HTTPS termination, CORS, routing — matches fitness-tracker setup |
| Containers | Docker Compose | Same pattern as fitness-tracker |
| CI/CD | GitHub Actions, self-hosted runner on NAS | Push to main → docker compose pull && up -d |

---

## Repo structure

```
fct/
  frontend/
    src/
      components/
        Dashboard.tsx          # Container, owns date range + scrubber state
        TimelineScrubber.tsx   # Recharts LineChart + custom cursor; drag on SVG also moves it
        CashFlowChart.tsx      # Area chart, balance over time
        EnvelopePanel.tsx      # Lists envelopes; inline override input for variable ones
        ReconciliationPanel.tsx # Add/edit/delete actual spends
        SyncStatus.tsx         # Shows last sync time; warns if > 10 min stale
      services/
        api.ts                 # Axios instance + typed fetch helpers
      main.tsx
      App.tsx
  backend/
    src/
      index.ts                 # Express entry, startup sync, scheduled sync
      routes/
        cashflow.ts            # GET /api/cashflow
        envelopes.ts           # GET/PUT/DELETE /api/envelopes/:id/override
        reconciliation.ts      # GET/POST/PATCH/DELETE /api/reconciliation
        health.ts              # GET /api/health
        sync.ts                # POST /api/sync (manual trigger)
      services/
        notion.ts              # Notion sync service
        cashflow.ts            # Cash engine — the core domain logic
      db/
        index.ts               # SQLite connection, PRAGMAs on startup
        schema.sql             # Applied on first run
      types/
        index.d.ts
      middleware/
        auth.ts
  proxy/
    Caddyfile
  .github/
    workflows/
      deploy.yml
  docker-compose.yml
  .env.example
```

---

## Domain model

### Buckets

The design has two named budget buckets — **Personal** and **Maple** (the household/shared account). Every budget item belongs to one bucket. The top bar has an All / Personal / Maple filter that drives all views simultaneously: the chart, the ledger, the Notion preview, and the variable bars.

### Budget items (from Notion)

Canonical budget envelopes synced from Notion. Each has:
- `type`: `income | expense | transfer`
- `frequency`: `once | weekly | fortnightly | monthly | annual`
- `recurInterval`: integer multiplier on the frequency (e.g. `monthly × 3` = quarterly, `weekly × 4` = 4-weekly). Defaults to 1.
- `dueDate`: ISO-8601 — the anchor date for recurring expansion
- `isVariable`: boolean — whether the user can set an override amount
- `bucket`: `personal | maple`
- `payment`: `Direct Debit | Credit | BPAY | DD (Shared)` — used for CC bundling logic

### Envelope overrides

For `isVariable` items, the user can set a per-month override amount that replaces `forecastAmount` in the cash engine for that period. Stored in SQLite only. Keyed by `budget_item_id + period (YYYY-MM)`.

### Reconciliation records

Actual spends recorded against forecast line items. Stored in SQLite only. Keyed back to Notion page IDs so the link is maintained without writing to Notion.

The reconciliation wizard (3-step modal) supports:
1. Choose source: CC statement | bank feed | mixed
2. Upload/paste/drop a file (screenshot, CSV, PDF)
3. Review auto-matched rows — each row shows match confidence (high/med/low), matched bill name or guessed category, bucket (Personal/Maple), checkbox to include/skip

CC transactions are locked to the Personal bucket. Bank feed rows auto-guess bucket based on payee patterns.

### Cash engine

Core server-side logic in `backend/src/services/cashflow.ts`. Accepts `from`, `to` date range:

1. Load all `budget_items` from SQLite (excluding soft-deleted)
2. Expand recurring items into individual dated entries across the range. The base cadence comes from `frequency`, multiplied by `recurInterval`:
   - `once` → single entry on `dueDate`
   - `weekly` → every `7 × recurInterval` days from `dueDate`
   - `fortnightly` → every `14 × recurInterval` days from `dueDate`
   - `monthly` → every `recurInterval` months, same day-of-month (clamp to last day of month if needed — e.g. 31st Feb → 28th/29th)
   - `annual` → every `recurInterval` years, same month+day
3. Apply `envelope_overrides` — replace `forecastAmount` for the relevant month
4. Apply `reconciliation` deltas — shift balance by `actual - forecast` on the reconciliation date
5. **Bundle CC items** — items where `payment = 'Credit'` accumulate into the CC statement. They do NOT appear as individual deductions on their due dates. Instead, a single CC statement deduction lands on the CC statement due date. This is a key design behaviour — credit purchases are invisible in the balance until statement day.
6. **Partition overdue items** — when `FCT_OPENING_BALANCE_DATE` is set, any budget item with `due_date < FCT_OPENING_BALANCE_DATE` is treated as overdue (Notion's automation advances the `due_date` only when a bill is marked paid, so a past date means unpaid). For each overdue item, the engine steps forward from `due_date` in the item's frequency cadence and counts occurrences before `FCT_OPENING_BALANCE_DATE` — that count is `missedCycles`, and `totalOwed = forecastAmount × missedCycles` is the real liability. Overdue cards are suppressed from the forward projection entirely and surfaced in a separate `overdueItems` array; `overdueTotals` per bucket sum `totalOwed`.
7. Compute running balance day-by-day. Seed is valid at `FCT_OPENING_BALANCE_DATE` (or `from` if unset). If the seed date is before `from`, the engine walks seed → from first to arrive at the correct seed, emitting entries only within `[from, to]`.
8. **adjustedEntries** — the same series as `entries` but with `overdueTotals` deducted from the seed per bucket, so the frontend can toggle between "forecast as-is" and "if overdue bills were paid today".

Returns `CashFlowResult`:
```typescript
interface CashFlowEntry {
  date: string             // ISO-8601
  balance: number          // Running balance at end of day
  inflow: number
  outflow: number
  breakdown: LineItem[]    // Per-envelope detail for this date
}

interface LineItem {
  budgetItemId: string
  name: string
  category: string
  type: 'income' | 'expense' | 'transfer'
  bucket: 'personal' | 'maple'
  forecastAmount: number
  overrideAmount: number | null
  actualAmount: number | null
  delta: number | null       // actual - forecast; null if not reconciled
  isReconciled: boolean
  isCC: boolean              // true if this item routes through the CC statement
  payment: string
}

interface OverdueItem {
  budgetItemId: string
  name: string
  bucket: 'personal' | 'maple'
  forecastAmount: number     // per-cycle amount
  dueDate: string            // ISO-8601
  daysOverdue: number        // as of FCT_OPENING_BALANCE_DATE
  missedCycles: number       // occurrences from dueDate up to FCT_OPENING_BALANCE_DATE
  totalOwed: number          // forecastAmount * missedCycles — the real liability
}

interface CashFlowResult {
  entries: CashFlowEntry[]
  adjustedEntries: CashFlowEntry[]   // entries with overdueTotals deducted from seed
  overdueItems: OverdueItem[]
  overdueTotals: { personal: number; maple: number }
}
```

The balance tracks Personal and Maple **separately**:
- `balP` — Personal running balance
- `balM` — Maple running balance
- `bal` — combined (shown when filter = All)

### CC statement card

A distinct UI element (not just a ledger row) showing:
- Total pending on the card for the current statement period
- Statement close date and due date
- Expandable list of individual CC line items
- `due day` is configurable (default: 25th of month)

---

## Design system (from the hi-fi)

The UI is designed. Do not deviate from these tokens when implementing components.

### Colour tokens (CSS custom properties)

```css
--paper: #f3efe6        /* page background — warm off-white */
--paper-2: #ebe5d6      /* surface / card hover */
--paper-3: #e2dac6      /* input tracks, chip backgrounds */
--ink: #131211          /* primary text, buttons */
--ink-2: #3a342b        /* secondary text */
--mute: #8a8275         /* labels, placeholders, sub-text */
--line: rgba(19,18,17,0.16)   /* borders */
--line-2: rgba(19,18,17,0.08) /* subtle dividers */
--accent: #c7442b       /* today marker, alerts, over-budget state */
--green: #2e6a3a        /* income, under-budget state, scheduled pill */
--cc: #5b3b8a           /* credit card purple — CC statement card, CC items */
--maple: #6b3fa0        /* Maple bucket colour */
--personal: #1f4f7a     /* Personal bucket colour */
--shadow: 0 1px 0 rgba(19,18,17,0.04), 0 12px 30px -18px rgba(19,18,17,0.25)
--radius: 14px
```

Background also has two subtle radial gradients (rust top-right, purple top-left) — don't strip these.

### Typography

- **Body / UI**: Inter (400, 500, 600, 700), 13.5px base
- **Display / large numbers**: Instrument Serif (400, italic variant) — used for the hero h1, stat `.val` amounts (48px), CC statement amount (40px)
- **Monospace / numbers**: JetBrains Mono — used for all currency amounts in tables, ledger columns, sidebar KV values, scrubber readout. Use `font-variant-numeric: tabular-nums`

### Layout

```
max-width: 1440px, padding: 28px
hero section (grid 1fr auto)
main grid: 1fr 380px (chart left, sidebar stack right)
below chart: row2 — two equal columns
breakpoint < 1100px: all grids collapse to 1fr
```

### Key component patterns

**Top bar** (`header.bar`): sticky, blurred background `rgba(243,239,230,0.82) + backdrop-filter:blur(14px)`, contains:
- Logo (30×30 dark pill with line-chart SVG icon)
- Brand name + subtitle ("connected to Notion · Budgets DB")
- Bucket segmented control: All / Personal / Maple (each with a colour dot)
- Sync status pill (green dot + "Notion · synced Xm ago")
- Spacer
- "Reconcile" ghost button (opens 3-step modal)

**Chart card** (`.curve-card`): no `.hd` — custom top area with three stat blocks:
- **Projected cash on [date]** — 48px Instrument Serif mono amount. In All mode: Personal amount / Maple amount side-by-side in their bucket colours
- **Low point · next 90d** — 28px, `--accent` colour, shows date + threshold warning
- **Next CC statement** — 28px, `--cc` colour, shows due date + item count

**SVG chart**: `viewBox="0 0 1000 360" preserveAspectRatio="none"`, `cursor:ew-resize`, `touch-action:none`. Two area series (Personal = `--personal`, Maple = `--maple`) with dashed lines + gradient fills. Event ticks: `▲` for income, `▼` for bills, `◆` for CC statements. Today = vertical dashed `--accent` line.

**Scrubber**: dual-input — range slider below the chart AND direct drag on the SVG. Both update the same state. Readout tooltip: dark pill, JetBrains Mono, `transform: translate(-50%, calc(-100% - 10px))`, opacity transitions on show/hide.

**Horizon buttons**: 1M / 3M / 6M / 1Y segmented control, changes `max` of range slider.

**Sidebar "On this date"** card: KV list — Projected balance, Personal, Maple, Income received, Bills paid, Pending on CC, Variable spend MTD.

**CC statement card** (`.stmt-card`): gradient background `#efe8d5 → #e6dcbe`, `--cc` border, radial gradient pseudo-element overlay. Contains: chip (gold gradient), tag, amount (40px Instrument Serif), meta (due date / close date), period pill, expandable items list, Import statement + Paste screenshot buttons.

**Alerts card**: Two alert types — `warn` (rust background + ⚠ icon) and `cc` (purple background + ◆ icon).

**Variable spend bars** (`.var-row`): 3-column grid (180px label | flex bar | 160px numbers). Bar fill states: default dark, `.good` = `--green`, `.over` = `--accent`. Budget marker line on the bar.

**Reconcile drop zone** (`.drop`): dashed border, drag-and-drop target. Supports PNG / JPG / PDF / CSV / Cmd+V paste.

**Ledger table** (`.ledger`): columns — Due, Bill, Budget, Payment, Amount (right-align mono), Bal after (right-align mono), Status. CC statement rows span as a group: `stmt-row-head` with left `--cc` border, then `stmt-item` sub-rows indented. Status pills: `reco-pill` (dashed, mute) for pending, `reco-pill ok` (solid green) for scheduled/reconciled.

**Notion preview**: columns — Name (icon + bold), Amount (mono, green for income), Date (mono mute), Recur chip, Payment chip, Tags chips.

**Reconcile modal** (3 steps):
1. Source picker — CC statement | Bank/debit feed | Mixed
2. Upload zone + simulate parse button
3. Review table — checkbox | raw transaction | amount | match tag (✓ green or ? dashed) | bucket selector | confidence badge (high/med/low)

---

## API contract

All endpoints prefixed `/api/`. All amounts are floats in AUD. All dates are ISO-8601.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ status, notionSyncedAt, syncError? }` |
| GET | `/cashflow?from=&to=` | `CashFlowResult` — `entries`, `adjustedEntries`, `overdueItems`, `overdueTotals` |
| GET | `/envelopes` | `{ envelopes: EnvelopeWithOverride[] }` |
| PUT | `/envelopes/:id/override` | Body: `{ period, overrideAmount }` |
| DELETE | `/envelopes/:id/override?period=` | Removes override, reverts to Notion forecast |
| GET | `/reconciliation` | `{ records: ReconciliationRecord[] }` |
| POST | `/reconciliation` | Body: `{ budgetItemId, date, forecastAmount, actualAmount, note? }` |
| PATCH | `/reconciliation/:id` | Partial update |
| DELETE | `/reconciliation/:id` | |
| POST | `/sync` | Manual Notion sync trigger |

---

## SQLite

File: `/volume1/docker/fct/data/fct.db` on NAS host → `/app/data/fct.db` in container.

Connection PRAGMAs (apply on every connection open):
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Three tables: `budget_items`, `envelope_overrides`, `reconciliation`. See Data Design in Notion docs for full schema. Key conventions:
- IDs are UUID4 strings, generated server-side
- Dates as ISO-8601 text (`YYYY-MM-DD`)
- `budget_items` rows are **upserted** on sync, keyed by `notion_page_id`
- Deleted Notion pages get `deleted_at` timestamp — **never hard-delete** — reconciliation records need their FK to stay valid
- No ORM — plain `better-sqlite3` synchronous calls

---

## Environment variables

| Variable | Service | Default | Description |
|---|---|---|---|
| `NOTION_TOKEN` | backend | — | Notion integration token (required) |
| `NOTION_DATABASE_ID` | backend | — | Budget DB page ID (required) |
| `FCT_OPENING_BALANCE` | backend | `0` | Starting cash balance for engine |
| `FCT_OPENING_BALANCE_PERSONAL` | backend | — | Personal bucket starting balance |
| `FCT_OPENING_BALANCE_MAPLE` | backend | — | Maple bucket starting balance |
| `FCT_OPENING_BALANCE_DATE` | backend | — | ISO-8601 date the opening balance is valid at. Items with `due_date < this` are treated as overdue/unpaid and surfaced via `overdueItems`. When set and before `from`, the engine walks seed → from to arrive at the correct seed. |
| `SYNC_INTERVAL_MS` | backend | `300000` | Notion poll interval (5 min) |
| `CC_STMT_DUE_DAY` | backend | `25` | Day of month CC statement is due |
| `CC_STMT_CLOSE_DAY` | backend | `12` | Day of month CC statement closes |
| `LOW_BALANCE_ALERT` | backend | `3500` | Threshold for low-balance alert |
| `PORT` | backend | `3001` | Express HTTP port |

---

## TanStack Query keys

```typescript
['cashflow', { from, to }]     // refetch when date range changes
['envelopes']
['reconciliation']
['health']                     // polled every 60s for sync status
```

---

## Coding conventions

- TypeScript strict mode end-to-end
- Zod validation on all API route inputs before service layer
- No ORM — `better-sqlite3` synchronous calls only
- Currency: all amounts stored and computed as floats; format for display with `Intl.NumberFormat` in `en-AU` locale (prefix `A$`)
- Never write back to Notion — SQLite is the only write store
- Soft-delete only on `budget_items` (set `deleted_at`); hard-delete is fine on `envelope_overrides` and `reconciliation`
- CC bundling is a cash engine concern — routes and components don't need to know about it; the engine handles it before returning `CashFlowEntry[]`
- The `isCC` flag on `LineItem` tells the frontend whether to style an item with the `--cc` colour and `◆` symbol

---

## Build order

1. `backend/src/db/` — SQLite connection module + apply `schema.sql`
2. `backend/src/services/notion.ts` — sync service; verify rows land in `budget_items`
3. `backend/src/services/cashflow.ts` — cash engine; unit-test with fixture data before wiring to routes
4. `backend/src/routes/` — REST endpoints; verify with curl/Postman
5. `frontend/src/` — wire existing design to live API; focus on data binding not visual design (design is done)
6. `proxy/Caddyfile` + `docker-compose.yml`
7. `.github/workflows/deploy.yml`
8. Cloudflare Tunnel DNS record for `fct.sereikeo.dev`

---

## Out of scope (v1)

- Notion write-back
- Bank/open banking API integration
- Automated SQLite backup
- Multi-user / sharing
- Native mobile app or PWA
- Push notifications / bill-due alerts
- OAuth other than Cloudflare Access
