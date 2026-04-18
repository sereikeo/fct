import { Router } from 'express';
import { getSyncStatus } from '../services/notion';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const { syncedAt, itemCount, error } = getSyncStatus();
  res.json({
    status: 'ok',
    notionSyncedAt: syncedAt,
    itemCount,
    ...(error ? { error } : {}),
  });
});
