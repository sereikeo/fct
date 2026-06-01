import axios from 'axios';

const BASE = import.meta.env.VITE_API_BASE_URL || '';

const client = axios.create({ baseURL: `${BASE}/api` });

export type BudgetItemType = 'income' | 'expense' | 'transfer';
export type Frequency = 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annual';
export type Bucket = 'personal' | 'maple';
export type Payment = 'Direct Debit' | 'Credit' | 'BPAY' | 'DD (Shared)';

export interface LineItem {
  budgetItemId: string;
  txId: string | null;
  name: string;
  category: string;
  type: BudgetItemType;
  bucket: Bucket;
  date: string;
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

export interface CCStatement {
  period: string;        // YYYY-MM of close month
  periodStart: string;   // YYYY-MM-DD
  closeDate: string;     // YYYY-MM-DD
  dueDate: string;       // YYYY-MM-DD
  isOverride: boolean;
}

export interface CCStatementOverride {
  period: string;
  closeDate: string;
  dueDate: string;
}

export interface CashFlowResponse {
  entries: CashFlowEntry[];
  actualsEntries: CashFlowEntry[];
  adjustedEntries: CashFlowEntry[];
  overdueItems: OverdueItem[];
  overdueTotals: OverdueTotals;
  ccConfig: { closeDay: number; dueDay: number };
  ccStatements: CCStatement[];
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
  payment: 'cash' | 'credit';
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
  ccOverrides: ['cc-overrides'] as const,
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
  payment?: 'cash' | 'credit';
  note?: string;
}): Promise<SpendEntry> {
  const { data } = await client.post('/spend', body);
  return data.entry;
}

export async function patchSpend(
  id: string,
  body: { amount?: number; payment?: 'cash' | 'credit'; note?: string | null }
): Promise<SpendEntry> {
  const { data } = await client.patch(`/spend/${id}`, body);
  return data.entry;
}

export async function deleteSpend(id: string): Promise<void> {
  await client.delete(`/spend/${id}`);
}

export async function getCCOverrides(): Promise<{ overrides: CCStatementOverride[] }> {
  const { data } = await client.get('/cc-overrides');
  return data;
}

export async function putCCOverride(period: string, body: { closeDate: string; dueDate: string }): Promise<void> {
  await client.put(`/cc-overrides/${period}`, body);
}

export async function deleteCCOverride(period: string): Promise<void> {
  await client.delete(`/cc-overrides/${period}`);
}

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await client.get('/health');
  return data;
}

export async function postSync(): Promise<void> {
  await client.post('/sync');
}

export async function patchTransaction(
  id: string,
  body: { confirmedDate: string },
): Promise<void> {
  await client.patch(`/transactions/${id}`, body);
}

// --- CSV reconciliation import (Phase 1: preview / dry-run, no writes) ---
export type ImportAccount = 'maple-debit' | 'personal-cc';
export type ImportStatus =
  | 'seen' | 'matched' | 'new-spend' | 'reconcile-bill' | 'income' | 'unmatched';

export interface ImportProposal {
  fingerprint: string;
  postDate: string;
  valueDate: string;
  amount: number;
  description: string;
  status: ImportStatus;
  confidence: 'high' | 'med' | 'low';
  targetItemId: string | null;
  targetName: string | null;
  bucket: Bucket | null;
  lane: 'cash' | 'credit' | null;
  note: string | null;
}

export interface ImportPreviewResult {
  account: ImportAccount;
  parsed: number;
  rows: ImportProposal[];
  summary: Record<ImportStatus, number> & { newOutflow: number };
}

export async function previewImport(account: ImportAccount, csv: string, from?: string): Promise<ImportPreviewResult> {
  const { data } = await client.post('/reconciliation/import/preview', { account, csv, from });
  return data;
}
