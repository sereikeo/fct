import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import type { EnvelopeWithOverride, EnvelopeOverride, BudgetItem } from '../types';

export const envelopesRouter = Router();

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  notion_page_id: string;
  name: string;
  category: string | null;
  type: string;
  frequency: string;
  due_date: string;
  is_variable: 0 | 1;
  bucket: string;
  payment: string;
  forecast_amount: number;
  deleted_at: string | null;
}

interface OverrideRow {
  id: string;
  budget_item_id: string;
  period: string;
  override_amount: number;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

function toOverride(row: OverrideRow): EnvelopeOverride {
  return {
    id: row.id,
    budgetItemId: row.budget_item_id,
    period: row.period,
    overrideAmount: row.override_amount,
  };
}

function toEnvelope(item: ItemRow, overrides: OverrideRow[]): EnvelopeWithOverride {
  const base: BudgetItem = {
    id:              item.id,
    notionPageId:    item.notion_page_id,
    name:            item.name,
    category:        item.category,
    type:            item.type as BudgetItem['type'],
    frequency:       item.frequency as BudgetItem['frequency'],
    dueDate:         item.due_date,
    isVariable:      item.is_variable === 1,
    bucket:          item.bucket as BudgetItem['bucket'],
    payment:         item.payment as BudgetItem['payment'],
    forecastAmount:  item.forecast_amount,
    deletedAt:       item.deleted_at,
  };
  return { ...base, overrides: overrides.map(toOverride) };
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmtItems     = db.prepare('SELECT * FROM budget_items WHERE deleted_at IS NULL ORDER BY name');
const stmtOverrides = db.prepare('SELECT * FROM envelope_overrides');
const stmtFindItem  = db.prepare('SELECT id FROM budget_items WHERE id = ? AND deleted_at IS NULL');

const stmtUpsertOverride = db.prepare(`
  INSERT INTO envelope_overrides (id, budget_item_id, period, override_amount)
  VALUES (@id, @budget_item_id, @period, @override_amount)
  ON CONFLICT(budget_item_id, period) DO UPDATE SET
    override_amount = excluded.override_amount,
    updated_at      = datetime('now')
`);

const stmtDeleteOverride = db.prepare(
  'DELETE FROM envelope_overrides WHERE budget_item_id = ? AND period = ?'
);

const stmtGetOverridesByItem = db.prepare(
  'SELECT * FROM envelope_overrides WHERE budget_item_id = ?'
);

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const IdSchema      = z.string().uuid('id must be a valid UUID');
const PeriodSchema  = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');

const OverrideBodySchema = z.object({
  period:         PeriodSchema,
  overrideAmount: z.number().nonnegative('overrideAmount must be >= 0'),
});

const OverrideDeleteSchema = z.object({
  period: PeriodSchema,
});

// ---------------------------------------------------------------------------
// GET /api/envelopes
// ---------------------------------------------------------------------------

envelopesRouter.get('/', (_req, res) => {
  const items     = stmtItems.all() as ItemRow[];
  const overrides = stmtOverrides.all() as OverrideRow[];

  const byItem = new Map<string, OverrideRow[]>();
  for (const o of overrides) {
    if (!byItem.has(o.budget_item_id)) byItem.set(o.budget_item_id, []);
    byItem.get(o.budget_item_id)!.push(o);
  }

  const envelopes = items.map(item => toEnvelope(item, byItem.get(item.id) ?? []));
  res.json({ envelopes });
});

// ---------------------------------------------------------------------------
// PUT /api/envelopes/:id/override
// ---------------------------------------------------------------------------

envelopesRouter.put('/:id/override', (req, res) => {
  const idResult = IdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ error: idResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const bodyResult = OverrideBodySchema.safeParse(req.body);
  if (!bodyResult.success) {
    return res.status(400).json({ error: bodyResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const { period, overrideAmount } = bodyResult.data;
  const item = stmtFindItem.get(idResult.data);
  if (!item) {
    return res.status(404).json({ error: 'Budget item not found', code: 'NOT_FOUND' });
  }

  stmtUpsertOverride.run({ id: uuidv4(), budget_item_id: idResult.data, period, override_amount: overrideAmount });

  const overrides = stmtGetOverridesByItem.all(idResult.data) as OverrideRow[];
  return res.json({ overrides: overrides.map(toOverride) });
});

// ---------------------------------------------------------------------------
// DELETE /api/envelopes/:id/override?period=YYYY-MM
// ---------------------------------------------------------------------------

envelopesRouter.delete('/:id/override', (req, res) => {
  const idResult = IdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ error: idResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const queryResult = OverrideDeleteSchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({ error: queryResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const item = stmtFindItem.get(idResult.data);
  if (!item) {
    return res.status(404).json({ error: 'Budget item not found', code: 'NOT_FOUND' });
  }

  const result = stmtDeleteOverride.run(idResult.data, queryResult.data.period);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Override not found', code: 'NOT_FOUND' });
  }

  return res.status(204).send();
});
