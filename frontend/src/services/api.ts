import axios from 'axios';

const BASE = import.meta.env.VITE_API_BASE_URL || '';

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
  isConfirmed: boolean;
  isPending: boolean;
  isProjected: boolean;
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

export interface OverdueItem {
  budgetItemId: string;
  name: string;
  type: BudgetItemType;
  bucket: Bucket;
  forecastAmount: number;
  dueDate: string;
  daysOverdue: number;
  missedCycles: number;
  totalOwed: number;
}

export interface OverdueBucketTotal {
  owedIn: number;
  owedOut: number;
}

export interface OverdueTotals {
  personal: OverdueBucketTotal;
  maple:    OverdueBucketTotal;
}

export interface CashFlowResponse {
  entries: CashFlowEntry[];
  actualsEntries: CashFlowEntry[];
  overdueItems: OverdueItem[];
  overdueTotals: OverdueTotals;
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
  recurInterval: number;
  dueDate: string;
  isVariable: boolean;
  isEnvelope: boolean;
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

export interface SpendEntry {
  id: string;
  budgetItemId: string;
  txId: string | null;
  date: string;
  amount: number;
  note: string | null;
}

export interface HealthResponse {
  status: string;
  notionSyncedAt: string | null;
  error?: string;
}

export const QUERY_KEYS = {
  cashflow: (from: string, to: string) => ['cashflow', { from, to }] as const,
  envelopes: ['envelopes'] as const,
  reconciliation: ['reconciliation'] as const,
  spend: (period: string) => ['spend', period] as const,
  health: ['health'] as const,
};

export async function getCashflow(from: string, to: string): Promise<CashFlowResponse> {
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

export async function getSpend(period: string): Promise<{ entries: SpendEntry[] }> {
  const { data } = await client.get('/spend', { params: { period } });
  return data;
}

export async function postSpend(body: {
  budgetItemId: string;
  date: string;
  amount: number;
  note?: string;
}): Promise<SpendEntry> {
  const { data } = await client.post('/spend', body);
  return data.entry;
}

export async function deleteSpend(id: string): Promise<void> {
  await client.delete(`/spend/${id}`);
}

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await client.get('/health');
  return data;
}

export async function postSync(): Promise<void> {
  await client.post('/sync');
}
