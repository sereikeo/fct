import { Router } from 'express';
import { runSync, getSyncStatus } from '../services/notion';

export const syncRouter = Router();

syncRouter.post('/', async (_req, res, next) => {
  try {
    await runSync(true);
    const { syncedAt, itemCount } = getSyncStatus();
    res.json({ syncedAt, itemCount });
  } catch (err) {
    next(err);
  }
});
