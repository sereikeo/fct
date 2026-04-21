import { Router } from 'express';
import db from '../db';

export const driftRouter = Router();

interface DriftRow {
  name: string;
  bucket: string;
  type: string;
  frequency: string | null;
  tx_amount: number;
  notion_amount: number;
  drift: number;
  confirmed_date: string;
  expected_date: string | null;
}

// Confirmed transactions whose snapshotted amount differs from the current
// Notion forecast. These are candidates for manual correction — either the
// Notion price changed after confirmation, or the payment was a different
// amount to the forecast.
const stmtDrift = db.prepare<[], DriftRow>(`
  SELECT
    t.name,
    t.bucket,
    t.type,
    t.frequency,
    round(t.amount, 2)            AS tx_amount,
    round(b.forecast_amount, 2)   AS notion_amount,
    round(b.forecast_amount - t.amount, 2) AS drift,
    t.confirmed_date,
    t.expected_date
  FROM transactions t
  JOIN budget_items b ON t.notion_page_id = b.notion_page_id
  WHERE t.confirmed = 1
    AND b.deleted_at IS NULL
    AND round(t.amount, 2) != round(b.forecast_amount, 2)
  ORDER BY abs(b.forecast_amount - t.amount) DESC
`);

// All confirmed transactions — useful for a full audit.
const stmtAll = db.prepare(`
  SELECT
    t.name,
    t.bucket,
    t.type,
    t.frequency,
    round(t.amount, 2)          AS tx_amount,
    round(b.forecast_amount, 2) AS notion_amount,
    round(b.forecast_amount - t.amount, 2) AS drift,
    t.confirmed_date,
    t.expected_date
  FROM transactions t
  JOIN budget_items b ON t.notion_page_id = b.notion_page_id
  WHERE t.confirmed = 1
    AND b.deleted_at IS NULL
  ORDER BY t.confirmed_date DESC
`);

driftRouter.get('/', (_req, res) => {
  const drifted = stmtDrift.all();
  const all     = stmtAll.all();
  res.json({
    driftCount: drifted.length,
    drifted,
    confirmed: all,
  });
});

// PATCH /api/drift/:notionPageId — correct the confirmed tx amount to match
// current Notion forecast (or a supplied override), then record why.
const stmtApply = db.prepare(`
  UPDATE transactions
  SET    amount = @amount, updated_at = datetime('now')
  WHERE  notion_page_id = @notion_page_id AND confirmed = 1
`);

driftRouter.patch('/:notionPageId', (req, res) => {
  const { notionPageId } = req.params;
  const { amount } = req.body as { amount?: number };

  if (amount !== undefined && (typeof amount !== 'number' || amount < 0)) {
    return res.status(400).json({ error: 'amount must be a non-negative number', code: 'VALIDATION_ERROR' });
  }

  // If no amount supplied, pull the current Notion forecast.
  let effective = amount;
  if (effective === undefined) {
    const row = db.prepare(
      'SELECT forecast_amount FROM budget_items WHERE notion_page_id = ? AND deleted_at IS NULL'
    ).get(notionPageId) as { forecast_amount: number } | undefined;
    if (!row) return res.status(404).json({ error: 'Budget item not found', code: 'NOT_FOUND' });
    effective = row.forecast_amount;
  }

  const result = stmtApply.run({ amount: effective, notion_page_id: notionPageId });
  if (result.changes === 0) {
    return res.status(404).json({ error: 'No confirmed transaction found for that item', code: 'NOT_FOUND' });
  }

  return res.json({ updated: result.changes, amount: effective });
});
