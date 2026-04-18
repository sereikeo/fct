import axios from 'axios';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

const client = axios.create({ baseURL: `${BASE}/api` });

export type BudgetItemType = 'income' | 'expense' | 'transfer';
export type Frequency = 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annual';
export type Bucket = 'personal' | 'maple';
export type Payment = 'Direct Debit' | 'Credit' | 'BPAY' | 'DD (Shared)';

export interface LineItem {
  budgetItemId: string;
  name: string;
  category: string;
  type: BudgetItemType;
  bucket: Bucket;
  forecastAmount: number;
  overrideAmount: number | null;
  actualAmount: number | null;
  delta: number | null;
  isReconciled: boolean;
  isCC: boolean;
  payment: string;
}

export interface CashFlowEntry {
  date: string;
  balance: number;
  balP: number;
  balM: number;
  inflow: number;
  outflow: number;
  breakdown: LineItem[];
}

export interface EnvelopeOverride {
  id: string;
  budgetItemId: string;
  period: string;
  overrideAmount: number;
}

export interface BudgetItem {
  id: string;
  notionPageId: string;
  name: string;
  category: string | null;
  type: BudgetItemType;
  frequency: Frequency;
  dueDate: string;
  isVariable: boolean;
  bucket: Bucket;
  payment: Payment;
  forecastAmount: number;
  deletedAt: string | null;
}

export interface EnvelopeWithOverride extends BudgetItem {
  overrides: EnvelopeOverride[];
}

export interface ReconciliationRecord {
  id: string;
  budgetItemId: string;
  date: string;
  forecastAmount: number;
  actualAmount: number;
  note: string | null;
  delta: number;
}

export interface HealthResponse {
  status: string;
  notionSyncedAt: string | null;
  syncError?: string;
}

export const QUERY_KEYS = {
  cashflow: (from: string, to: string) => ['cashflow', { from, to }] as const,
  envelopes: ['envelopes'] as const,
  reconciliation: ['reconciliation'] as const,
  health: ['health'] as const,
};

export async function getCashflow(from: string, to: string): Promise<{ entries: CashFlowEntry[] }> {
  const { data } = await client.get('/cashflow', { params: { from, to } });
  return data;
}

export async function getEnvelopes(): Promise<{ envelopes: EnvelopeWithOverride[] }> {
  const { data } = await client.get('/envelopes');
  return data;
}

export async function patchEnvelope(
  id: string,
  body: { period: string; overrideAmount: number }
): Promise<void> {
  await client.put(`/envelopes/${id}/override`, body);
}

export async function deleteEnvelope(id: string, period: string): Promise<void> {
  await client.delete(`/envelopes/${id}/override`, { params: { period } });
}

export async function postEnvelope(body: {
  period: string;
  overrideAmount: number;
  budgetItemId: string;
}): Promise<void> {
  await client.put(`/envelopes/${body.budgetItemId}/override`, body);
}

export async function getReconciliation(): Promise<{ records: ReconciliationRecord[] }> {
  const { data } = await client.get('/reconciliation');
  return data;
}

export async function postReconciliation(body: {
  budgetItemId: string;
  date: string;
  forecastAmount: number;
  actualAmount: number;
  note?: string;
}): Promise<ReconciliationRecord> {
  const { data } = await client.post('/reconciliation', body);
  return data;
}

export async function deleteReconciliation(id: string): Promise<void> {
  await client.delete(`/reconciliation/${id}`);
}

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await client.get('/health');
  return data;
}

export async function postSync(): Promise<void> {
  await client.post('/sync');
}
