import express from 'express';
import { getCashflowData } from '../services/cashflow';
import { authenticate } from '../middleware/auth';

const router = express.Router();

router.get('/:date', authenticate, async (req, res) => {
  try {
    const date = req.params.date;
    const cashflowData = await getCashflowData(new Date(date));
    res.json(cashflowData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch cashflow data' });
  }
});

export { cashflowRouter as router };