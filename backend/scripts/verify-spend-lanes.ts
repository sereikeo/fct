// Verify the cash engine routes spend_log entries by their `payment` lane:
//   cash → direct balance hit on the spend date
//   credit → bundled into the next CC statement due date
// Run with: npx ts-node scripts/verify-spend-lanes.ts

import path from 'path';
import fs from 'fs';
import os from 'os';

// MUST set DB_PATH before importing anything that pulls in db/index.ts
const tmpDb = path.join(os.tmpdir(), `fct-verify-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.FCT_OPENING_BALANCE_PERSONAL = '1000';
process.env.FCT_OPENING_BALANCE_MAPLE = '0';
process.env.CC_STMT_CLOSE_DAY = '12';
process.env.CC_STMT_DUE_DAY = '25';

import db from '../src/db';
import { computeCashFlow } from '../src/services/cashflow';

let pass = 0, fail = 0;
const results: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else      { fail++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function approx(a: number, b: number, eps = 0.001) { return Math.abs(a - b) < eps; }

// Helpers
function uuid(seed: string) {
  // Deterministic-ish; just needs to be unique within the test
  return `00000000-0000-0000-0000-${seed.padStart(12, '0').slice(-12)}`;
}

function seedItem(id: string, name: string, payment: 'Direct Debit' | 'Credit', forecast: number, dueDate: string) {
  db.prepare(`
    INSERT INTO budget_items
    (id, notion_page_id, name, type, frequency, recur_interval, due_date,
     is_variable, is_envelope, bucket, payment, forecast_amount)
    VALUES (?, ?, ?, 'expense', 'monthly', 1, ?, 1, 1, 'personal', ?, ?)
  `).run(id, `page-${id}`, name, dueDate, payment, forecast);
}

function logSpend(itemId: string, date: string, amount: number, payment: 'cash' | 'credit') {
  db.prepare(`
    INSERT INTO spend_log (id, budget_item_id, date, amount, payment)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuid(`s${Date.now()}${Math.random()}`.slice(0, 12)), itemId, date, amount, payment);
}

function reset() {
  db.exec('DELETE FROM spend_log');
  db.exec('DELETE FROM transactions');
  db.exec('DELETE FROM envelope_overrides');
  db.exec('DELETE FROM reconciliation');
  db.exec('DELETE FROM budget_items');
}

function sumOutflow(entries: ReturnType<typeof computeCashFlow>['entries'], from: string, to: string) {
  return entries.filter(e => e.date >= from && e.date <= to).reduce((t, e) => t + e.outflow, 0);
}

// Use a fixed test month so CC stmt dates are predictable
// Period 2026-04: close = 2026-04-12, due = 2026-04-25
// Spend on 2026-04-15 → closes 2026-05-12 → due 2026-05-25
// Spend on 2026-04-05 → closes 2026-04-12 → due 2026-04-25
const FROM = '2026-04-01', TO  = '2026-06-30';
const OCC_DATE = '2026-04-20'; // envelope occurrence (due_date)

// ---------------------------------------------------------------------------
// Case 1: Cash-only on a Direct Debit envelope
//   $150 cash on 2026-04-10 → balance −$150 on 2026-04-10
//   Remaining: 200 − 150 = 50 on occDate (or end-of-month if occDate < today)
// ---------------------------------------------------------------------------
reset();
seedItem(uuid('1'), 'Groceries', 'Direct Debit', 200, OCC_DATE);
logSpend(uuid('1'), '2026-04-10', 150, 'cash');
{
  const r = computeCashFlow(FROM, TO);
  const day = r.entries.find(e => e.date === '2026-04-10');
  check('case1: cash spend hits date directly',
    !!day && approx(day.outflow, 150),
    day ? `outflow=${day.outflow}` : 'no entry');

  // Total April outflow should be 150 (spend) + 50 (forecast remainder if placed in range) = 200,
  // OR just 150 + remainder placed somewhere in [from,to]. Let's check total over range.
  const total = sumOutflow(r.entries, FROM, TO);
  check('case1: total outflow over range = 200 (cash $150 + remainder $50)',
    approx(total, 200), `total=${total}`);
}

// ---------------------------------------------------------------------------
// Case 2: Credit-only on a Direct Debit envelope
//   $30 on credit on 2026-04-15 → bundled into stmt due 2026-05-25
//   Remaining cash forecast: 200 − 0 = 200 (credit is additive, not draw-down)
// ---------------------------------------------------------------------------
reset();
seedItem(uuid('2'), 'Groceries', 'Direct Debit', 200, OCC_DATE);
logSpend(uuid('2'), '2026-04-15', 30, 'credit');
{
  const r = computeCashFlow(FROM, TO);
  const stmtDay = r.entries.find(e => e.date === '2026-05-25');
  check('case2: credit spend lands on next stmt due (2026-05-25)',
    !!stmtDay && approx(stmtDay.outflow, 30),
    stmtDay ? `outflow=${stmtDay.outflow}` : 'no entry');

  const total = sumOutflow(r.entries, FROM, TO);
  // 30 (CC stmt) + 200 (full cash forecast — not drawn down by credit lane) = 230
  // BUT the next month's envelope adds another forecast occurrence too. Bound the check loosely:
  check('case2: cash forecast not drawn down by credit-lane spend (April outflow includes full $200)',
    approx(sumOutflow(r.entries, '2026-04-01', '2026-04-30'), 200),
    `apr=${sumOutflow(r.entries, '2026-04-01', '2026-04-30')}`);
  check('case2: $30 credit lands on 2026-05-25',
    approx(sumOutflow(r.entries, '2026-05-25', '2026-05-25'), 30 + 0 /* nothing else due that day */),
    `may25=${sumOutflow(r.entries, '2026-05-25', '2026-05-25')}`);
  void total;
}

// ---------------------------------------------------------------------------
// Case 3: Mixed on a Direct Debit envelope
//   $150 cash on 04-10, $30 credit on 04-15
//   Cash draws down forecast: remaining = 200 − 150 = 50
//   Credit additive: extra $30 on stmt due
// ---------------------------------------------------------------------------
reset();
seedItem(uuid('3'), 'Groceries', 'Direct Debit', 200, OCC_DATE);
logSpend(uuid('3'), '2026-04-10', 150, 'cash');
logSpend(uuid('3'), '2026-04-15', 30, 'credit');
{
  const r = computeCashFlow(FROM, TO);
  check('case3: cash $150 on 04-10',
    approx(sumOutflow(r.entries, '2026-04-10', '2026-04-10'), 150));
  check('case3: April total = 150 cash + 50 remainder = 200',
    approx(sumOutflow(r.entries, '2026-04-01', '2026-04-30'), 200),
    `apr=${sumOutflow(r.entries, '2026-04-01', '2026-04-30')}`);
  check('case3: credit $30 on stmt due 05-25',
    approx(sumOutflow(r.entries, '2026-05-25', '2026-05-25'), 30),
    `may25=${sumOutflow(r.entries, '2026-05-25', '2026-05-25')}`);
}

// ---------------------------------------------------------------------------
// Case 4: Refund (negative credit) reduces stmt total
// ---------------------------------------------------------------------------
reset();
seedItem(uuid('4'), 'Groceries', 'Direct Debit', 200, OCC_DATE);
logSpend(uuid('4'), '2026-04-15', 30, 'credit');
logSpend(uuid('4'), '2026-04-18', -20, 'credit');
{
  const r = computeCashFlow(FROM, TO);
  // Net stmt = 30 + (-20) = 10; both have stmt due 2026-05-25
  const may25 = sumOutflow(r.entries, '2026-05-25', '2026-05-25');
  check('case4: net credit on stmt due = 10 (30 - 20 refund)',
    approx(may25, 10), `may25=${may25}`);
}

// ---------------------------------------------------------------------------
// Case 5: Cash on a Credit envelope (additive — not drawing down)
//   Envelope payment=Credit, forecast=200 (forecast lane=credit, hits stmt due)
//   $50 cash on 04-10 → −$50 directly on 04-10
//   Forecast credit lane unchanged: $200 on stmt due
// ---------------------------------------------------------------------------
reset();
seedItem(uuid('5'), 'CC Subs', 'Credit', 200, OCC_DATE);
logSpend(uuid('5'), '2026-04-10', 50, 'cash');
{
  const r = computeCashFlow(FROM, TO);
  check('case5: cash $50 on 04-10 (additive)',
    approx(sumOutflow(r.entries, '2026-04-10', '2026-04-10'), 50));
  // Forecast remainder routes via item.payment ('Credit') → stmt due of occDate (04-20)
  // 04-20 > closeDay (12) → closes 05-12 → due 05-25
  check('case5: full $200 credit forecast remains on stmt due',
    approx(sumOutflow(r.entries, '2026-05-25', '2026-05-25'), 200),
    `may25=${sumOutflow(r.entries, '2026-05-25', '2026-05-25')}`);
}

// ---------------------------------------------------------------------------
// Case 6: Credit on a Credit envelope (matching lane — draws down)
//   $50 credit on 04-15 → bundled to stmt 05-25
//   Forecast credit remainder: 200 − 50 = 150 on stmt due of occDate (also 05-25)
//   Total on 05-25 = 50 (spend) + 150 (remainder) = 200
// ---------------------------------------------------------------------------
reset();
seedItem(uuid('6'), 'CC Subs', 'Credit', 200, OCC_DATE);
logSpend(uuid('6'), '2026-04-15', 50, 'credit');
{
  const r = computeCashFlow(FROM, TO);
  const may25 = sumOutflow(r.entries, '2026-05-25', '2026-05-25');
  check('case6: credit-matching-lane draws down forecast (total 05-25 = 200)',
    approx(may25, 200), `may25=${may25}`);
}

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------
console.log('\nverify-spend-lanes results:\n');
for (const r of results) console.log(r);
console.log(`\n${pass} passed, ${fail} failed\n`);

// Cleanup tmp DB
try { fs.unlinkSync(tmpDb); } catch {}
process.exit(fail > 0 ? 1 : 0);
