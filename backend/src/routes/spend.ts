import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { IdSchema, DateStr, PeriodStr } from '../lib/validate';
import type { SpendEntry } from '../types';

export const spendRouter = Router();

interface SpendRow {
  id: string;
  budget_item_id: string;
  tx_id: string | null;
  date: string;
  amount: number;
  note: string | null;
}

function toEntry(row: SpendRow): SpendEntry {
  return {
    id:           row.id,
    budgetItemId: row.budget_item_id,
    txId:         row.tx_id,
    date:         row.date,
    amount:       row.amount,
    note:         row.note,
  };
}

const PostSchema = z.object({
  budgetItemId: z.string().uuid(),
  date:         DateStr,
  amount:       z.number().refine(n => n !== 0, 'Amount cannot be zero'),
  note:         z.string().optional(),
});

const PatchSchema = z.object({
  amount: z.number().refine(n => n !== 0, 'Amount cannot be zero').optional(),
  note:   z.string().nullable().optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), {
  message: 'At least one field required',
});

const stmtFindItem = db.prepare(
  'SELECT id, forecast_amount FROM budget_items WHERE id = ? AND deleted_at IS NULL'
);

// Find the tx occurrence this spend belongs to: prefer confirmed, fall back to
// unconfirmed. Most recent expected_date on or before the spend date.
// Confirmed rows come first so a paid occurrence always wins over a projected one.
const stmtFindTx = db.prepare(`
  SELECT t.id, t.amount AS current_amount, bi.forecast_amount
  FROM   transactions t
  JOIN   budget_items bi ON bi.notion_page_id = t.notion_page_id
  WHERE  bi.id         = @budget_item_id
    AND  t.expected_date <= @date
  ORDER  BY t.confirmed DESC, t.expected_date DESC
  LIMIT  1
`);

const stmtAllForPeriod = db.prepare(
  "SELECT * FROM spend_log WHERE budget_item_id IN (SELECT id FROM budget_items WHERE deleted_at IS NULL) AND date LIKE ? ORDER BY date DESC"
);

const stmtById = db.prepare('SELECT * FROM spend_log WHERE id = ?');

const stmtInsert = db.prepare(`
  INSERT INTO spend_log (id, budget_item_id, tx_id, date, amount, note)
  VALUES (@id, @budget_item_id, @tx_id, @date, @amount, @note)
`);

const stmtDelete = db.prepare('DELETE FROM spend_log WHERE id = ?');

const stmtSumForTx = db.prepare(
  'SELECT COALESCE(SUM(amount), 0) AS total FROM spend_log WHERE tx_id = ?'
);

const stmtForecastForTx = db.prepare(`
  SELECT bi.forecast_amount
  FROM   transactions t
  JOIN   budget_items bi ON bi.notion_page_id = t.notion_page_id
  WHERE  t.id = ?
`);

const stmtUpdateTxAmount = db.prepare(
  "UPDATE transactions SET amount = ?, updated_at = datetime('now') WHERE id = ?"
);

function recomputeTxAmount(txId: string): void {
  const { total } = stmtSumForTx.get(txId) as { total: number };
  const row = stmtForecastForTx.get(txId) as { forecast_amount: number } | undefined;
  if (!row) return;
  // If all entries deleted, revert tx to the original forecast amount
  stmtUpdateTxAmount.run(total > 0 ? total : row.forecast_amount, txId);
}

// GET /api/spend?period=YYYY-MM
spendRouter.get('/', (req, res) => {
  const periodResult = PeriodStr.safeParse(req.query.period);
  if (!periodResult.success) {
    return res.status(400).json({ error: 'period query param required (YYYY-MM)', code: 'VALIDATION_ERROR' });
  }
  const rows = stmtAllForPeriod.all(`${periodResult.data}-%`) as SpendRow[];
  return res.json({ entries: rows.map(toEntry) });
});

// POST /api/spend
spendRouter.post('/', (req, res) => {
  const result = PostSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const { budgetItemId, date, amount, note } = result.data;

  if (!stmtFindItem.get(budgetItemId)) {
    return res.status(404).json({ error: 'Budget item not found', code: 'NOT_FOUND' });
  }

  const tx = stmtFindTx.get({ budget_item_id: budgetItemId, date }) as
    { id: string; current_amount: number; forecast_amount: number } | undefined;

  const id = uuidv4();
  stmtInsert.run({
    id,
    budget_item_id: budgetItemId,
    tx_id:          tx?.id ?? null,
    date,
    amount,
    note:           note ?? null,
  });

  if (tx) recomputeTxAmount(tx.id);

  return res.status(201).json({ entry: toEntry({ id, budget_item_id: budgetItemId, tx_id: tx?.id ?? null, date, amount, note: note ?? null }) });
});

// PATCH /api/spend/:id
spendRouter.patch('/:id', (req, res) => {
  const idResult = IdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ error: idResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const bodyResult = PatchSchema.safeParse(req.body);
  if (!bodyResult.success) {
    return res.status(400).json({ error: bodyResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const existing = stmtById.get(idResult.data) as SpendRow | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'Spend entry not found', code: 'NOT_FOUND' });
  }

  const body = bodyResult.data;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.amount !== undefined) { sets.push('amount = ?'); vals.push(body.amount); }
  if (body.note   !== undefined) { sets.push('note = ?');   vals.push(body.note); }
  sets.push("updated_at = datetime('now')");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE spend_log SET ${sets.join(', ')} WHERE id = ?`) as any).run(...vals, idResult.data);

  if (existing.tx_id) recomputeTxAmount(existing.tx_id);

  const updated = stmtById.get(idResult.data) as SpendRow;
  return res.json({ entry: toEntry(updated) });
});

// DELETE /api/spend/:id
spendRouter.delete('/:id', (req, res) => {
  const idResult = IdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ error: idResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const existing = stmtById.get(idResult.data) as SpendRow | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'Spend entry not found', code: 'NOT_FOUND' });
  }

  stmtDelete.run(idResult.data);
  if (existing.tx_id) recomputeTxAmount(existing.tx_id);

  return res.status(204).send();
});
