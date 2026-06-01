import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { IdSchema, DateStr } from '../lib/validate';

export const manualEntriesRouter = Router();

interface ManualRow {
  id: string;
  date: string;
  type: 'income' | 'expense';
  bucket: 'personal' | 'maple';
  amount: number;
  lane: 'cash' | 'credit';
  note: string | null;
}

const PostSchema = z.object({
  date:   DateStr,
  type:   z.enum(['income', 'expense']),
  bucket: z.enum(['personal', 'maple']),
  amount: z.number().positive('amount must be > 0'),
  lane:   z.enum(['cash', 'credit']).optional(),
  note:   z.string().optional(),
});

const stmtAll    = db.prepare('SELECT id, date, type, bucket, amount, lane, note FROM manual_entries ORDER BY date DESC');
const stmtInsert = db.prepare(`
  INSERT INTO manual_entries (id, date, type, bucket, amount, lane, note)
  VALUES (@id, @date, @type, @bucket, @amount, @lane, @note)
`);
const stmtDelete = db.prepare('DELETE FROM manual_entries WHERE id = ?');

manualEntriesRouter.get('/', (_req, res) => {
  res.json({ entries: stmtAll.all() as ManualRow[] });
});

manualEntriesRouter.post('/', (req, res) => {
  const result = PostSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }
  const { date, type, bucket, amount, lane, note } = result.data;
  const id = uuidv4();
  const row: ManualRow = { id, date, type, bucket, amount, lane: lane ?? 'cash', note: note ?? null };
  stmtInsert.run(row);
  return res.status(201).json({ entry: row });
});

manualEntriesRouter.delete('/:id', (req, res) => {
  const idResult = IdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ error: idResult.error.errors[0].message, code: 'VALIDATION_ERROR' });
  }
  const result = stmtDelete.run(idResult.data);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Manual entry not found', code: 'NOT_FOUND' });
  }
  return res.status(204).send();
});
