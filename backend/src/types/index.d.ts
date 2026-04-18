export type BudgetItemType = 'income' | 'expense' | 'transfer';
export type Frequency = 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annual';
export type Bucket = 'personal' | 'maple';
export type Payment = 'Direct Debit' | 'Credit' | 'BPAY' | 'DD (Shared)';

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

export interface EnvelopeOverride {
  id: string;
  budgetItemId: string;
  period: string;
  overrideAmount: number;
}

export interface ReconciliationRecord {
  id: string;
  budgetItemId: string;
  date: string;
  forecastAmount: number;
  actualAmount: number;
  note: string | null;
}

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

export interface EnvelopeWithOverride extends BudgetItem {
  overrides: EnvelopeOverride[];
}
