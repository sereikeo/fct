import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { healthRouter }        from './routes/health';
import { cashflowRouter }      from './routes/cashflow';
import { envelopesRouter }     from './routes/envelopes';
import { reconciliationRouter } from './routes/reconciliation';
import { syncRouter }          from './routes/sync';
import { runSync, startScheduledSync } from './services/notion';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/health',         healthRouter);
app.use('/api/cashflow',       cashflowRouter);
app.use('/api/envelopes',      envelopesRouter);
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/sync',           syncRouter);

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  const status  = (err as { statusCode?: number }).statusCode ?? 500;
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(status).json({ error: message, code: 'INTERNAL_ERROR' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  try {
    await runSync(true);
    console.log('[startup] Initial Notion sync complete');
  } catch (err) {
    // Log but don't crash — the server is useful even if Notion is unreachable
    console.error('[startup] Initial Notion sync failed:', err);
  }

  startScheduledSync();

  app.listen(PORT, () => {
    console.log(`[fct-backend] listening on :${PORT}`);
  });
}

start();
