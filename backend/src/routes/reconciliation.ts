import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import type { ReconciliationRecord } from '../types';

export const reconciliationRouter = Router();

// ---------------------------------------------------------------------------
// DB row shape
// ---------------------------------------------------------------------------

interface ReconRow {
  id: string;
  budget_item_id: string;
  date: string;
  forecast_amount: number;
  actual_amount: number;
  note: string | null;
  delta: number;
}

function toRecord(row: ReconRow): ReconciliationRecord {
  return {
    id:             row.id,
    budgetItemId:   row.budget_item_id,
    date:           row.date,
    forecastAmount: row.forecast_amount,
    actualAmount:   row.actual_amount,
    note:           row.note,
    delta:          row.delta,
  };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const IdSchema   = z.string().uuid('id must be a valid UUID');
const DateStr    = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const PostSchema = z.object({
  budgetItemId:   z.string().uuid(),
  date:           DateStr,
  forecastAmount: z.number().nonnegative(),
  actualAmount:   z.number().nonnegative(),
  note:           z.string().optional(),
});

const PatchSchema = z
  .object({
    date:           DateStr.optional(),
    forecastAmount: z.number().nonnegative().optional(),
    actualAmount:   z.number().nonnegative().optional(),
    note:           z.string().nullable().optional(),
  })
  .refine(
    d => Object.values(d).some(v => v !== undefined),
    { message: 'At least one field must be provided' }
  );

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmtAll    = db.prepare('SELECT * FROM reconciliation ORDER BY date DESC');
const stmtById   = db.prepare('SELECT * FROM reconciliation WHERE id = ?');
const stmtInsert = db.prepare(`
  INSERT INTO reconciliation (id, budget_item_id, date, forecast_amount, actual_amount, note)
  VALUES (@id, @budget_item_id, @date, @forecast_amount, @actual_amount, @note)
`);
const stmtDelete = db.prepare('DELETE FROM reconciliation WHERE id = ?');
const stmtItemExists = db.prepare(
  'SELECT id FROM budget_items WHERE id = ? AND deleted_at IS NULL'
);

// ---------------------------------------------------------------------------
// GET /api/reconciliation
// ---------------------------------------------------------------------------

reconciliationRouter.get('/', (_req, res) => {
  const rows = stmtAll.all() as ReconRow[];
  res.json({ records: rows.map(toRecord) });
});

// ---------------------------------------------------------------------------
// POST /api/reconciliation
// ---------------------------------------------------------------------------

reconciliationRouter.post('/', (req, res) => {
  const result = PostSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const { budgetItemId, date, forecastAmount, actualAmount, note } = result.data;

  if (!stmtItemExists.get(budgetItemId)) {
    return res.status(404).json({ error: 'Budget item not found', code: 'NOT_FOUND' });
  }

  const id = uuidv4();
  stmtInsert.run({
    id,
    budget_item_id: budgetItemId,
    date,
    forecast_amount: forecastAmount,
    actual_amount:   actualAmount,
    note:            note ?? null,
  });

  const row = stmtById.get(id) as ReconRow;
  return res.status(201).json({ record: toRecord(row) });
});

// ---------------------------------------------------------------------------
// PATCH /api/reconciliation/:id
// ---------------------------------------------------------------------------

reconciliationRouter.patch('/:id', (req, res) => {
  const idResult = IdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ error: idResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const bodyResult = PatchSchema.safeParse(req.body);
  if (!bodyResult.success) {
    return res.status(400).json({ error: bodyResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const existing = stmtById.get(idResult.data) as ReconRow | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'Reconciliation record not found', code: 'NOT_FOUND' });
  }

  const body = bodyResult.data;
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.date !== undefined)           { sets.push('date = ?');            vals.push(body.date); }
  if (body.forecastAmount !== undefined) { sets.push('forecast_amount = ?'); vals.push(body.forecastAmount); }
  if (body.actualAmount !== undefined)   { sets.push('actual_amount = ?');   vals.push(body.actualAmount); }
  if (body.note !== undefined)           { sets.push('note = ?');            vals.push(body.note); }

  sets.push("updated_at = datetime('now')");

  // Dynamic SET clause — cast needed because TS can't statically type the
  // spread of a runtime-built values array against the prepared statement.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE reconciliation SET ${sets.join(', ')} WHERE id = ?`) as any)
    .run(...vals, idResult.data);

  const updated = stmtById.get(idResult.data) as ReconRow;
  return res.json({ record: toRecord(updated) });
});

// ---------------------------------------------------------------------------
// DELETE /api/reconciliation/:id
// ---------------------------------------------------------------------------

reconciliationRouter.delete('/:id', (req, res) => {
  const idResult = IdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ error: idResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const result = stmtDelete.run(idResult.data);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Reconciliation record not found', code: 'NOT_FOUND' });
  }

  return res.status(204).send();
});
