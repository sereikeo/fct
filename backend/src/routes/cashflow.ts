import { Router } from 'express';
import { z } from 'zod';
import { DateStr } from '../lib/validate';
import { computeCashFlow } from '../services/cashflow';

export const cashflowRouter = Router();

const QuerySchema = z
  .object({ from: DateStr, to: DateStr })
  .refine(d => d.from <= d.to, { message: 'from must be on or before to', path: ['from'] });

cashflowRouter.get('/', (req, res) => {
  const result = QuerySchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ error: result.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }
  const { from, to } = result.data;
  return res.json({ entries: computeCashFlow(from, to) });
});
