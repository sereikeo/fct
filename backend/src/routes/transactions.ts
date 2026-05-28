import { Router } from 'express';
import { z } from 'zod';
import db from '../db';
import { DateStr } from '../lib/validate';

export const transactionsRouter = Router();

const stmtUpdateConfirmedDate = db.prepare(`
  UPDATE transactions
  SET    confirmed_date = @confirmed_date,
         updated_at     = datetime('now')
  WHERE  id             = @id
    AND  confirmed      = 1
`);

const PatchBody = z.object({
  confirmedDate: DateStr,
});

transactionsRouter.patch('/:id', (req, res) => {
  const id = req.params.id;
  if (!id) {
    return res.status(400).json({ error: 'id required', code: 'VALIDATION_ERROR' });
  }

  const body = PatchBody.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: body.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }

  const result = stmtUpdateConfirmedDate.run({ id, confirmed_date: body.data.confirmedDate });
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Confirmed transaction not found', code: 'NOT_FOUND' });
  }

  return res.json({ id, confirmedDate: body.data.confirmedDate });
});
