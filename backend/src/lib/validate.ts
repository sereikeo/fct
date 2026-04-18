import { z } from 'zod';

export const IdSchema     = z.string().uuid('id must be a valid UUID');
export const DateStr      = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const PeriodStr    = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');
