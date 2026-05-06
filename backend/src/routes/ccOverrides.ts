import { Router } from 'express';
import { z } from 'zod';
import db from '../db';
import { DateStr, PeriodStr } from '../lib/validate';
import type { CCStatementOverride } from '../types';

export const ccOverridesRouter = Router();

interface OverrideRow {
  period: string;
  close_date: string;
  due_date: string;
}

const toOverride = (r: OverrideRow): CCStatementOverride => ({
  period:    r.period,
  closeDate: r.close_date,
  dueDate:   r.due_date,
});

const stmtAll = db.prepare('SELECT period, close_date, due_date FROM cc_statement_overrides ORDER BY period');

const stmtUpsert = db.prepare(`
  INSERT INTO cc_statement_overrides (period, close_date, due_date)
  VALUES (@period, @close_date, @due_date)
  ON CONFLICT(period) DO UPDATE SET
    close_date = excluded.close_date,
    due_date   = excluded.due_date,
    updated_at = datetime('now')
`);

const stmtDelete = db.prepare('DELETE FROM cc_statement_overrides WHERE period = ?');

const BodySchema = z
  .object({ closeDate: DateStr, dueDate: DateStr })
  .refine(d => d.closeDate <= d.dueDate, {
    message: 'closeDate must be on or before dueDate',
    path:    ['closeDate'],
  });

ccOverridesRouter.get('/', (_req, res) => {
  const rows = stmtAll.all() as OverrideRow[];
  res.json({ overrides: rows.map(toOverride) });
});

ccOverridesRouter.put('/:period', (req, res) => {
  const periodResult = PeriodStr.safeParse(req.params.period);
  if (!periodResult.success) {
    return res.status(400).json({ error: periodResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const bodyResult = BodySchema.safeParse(req.body);
  if (!bodyResult.success) {
    return res.status(400).json({ error: bodyResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const { closeDate, dueDate } = bodyResult.data;
  stmtUpsert.run({ period: periodResult.data, close_date: closeDate, due_date: dueDate });

  return res.json({ override: { period: periodResult.data, closeDate, dueDate } });
});

ccOverridesRouter.delete('/:period', (req, res) => {
  const periodResult = PeriodStr.safeParse(req.params.period);
  if (!periodResult.success) {
    return res.status(400).json({ error: periodResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const result = stmtDelete.run(periodResult.data);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Override not found', code: 'NOT_FOUND' });
  }
  return res.status(204).send();
});
