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
  recurInterval: number;   // multiplier on the frequency (e.g. monthly/3 = quarterly)
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
  delta: number;
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
  isConfirmed: boolean;  // ledger row confirmed (ticked off in Notion) — balance IS moved on confirmed_date
  isPending: boolean;    // ledger row exists, not yet confirmed, expected_date is in the past — balance NOT moved
  isProjected: boolean;  // future occurrence (ledger row with future expected_date, or expansion beyond ledger) — balance NOT moved
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
  type: BudgetItemType;     // drives direction: income = owed to you, expense/transfer = owed by you
  bucket: Bucket;
  forecastAmount: number;   // per-cycle amount
  dueDate: string;
  daysOverdue: number;
  missedCycles: number;     // occurrences from dueDate up to FCT_OPENING_BALANCE_DATE
  totalOwed: number;        // forecastAmount * missedCycles — unsigned magnitude
}

export interface OverdueBucketTotal {
  owedIn: number;   // money owed TO you on this bucket (unconfirmed income)
  owedOut: number;  // money owed BY you on this bucket (unconfirmed expense/transfer)
}

export interface OverdueTotals {
  personal: OverdueBucketTotal;
  maple:    OverdueBucketTotal;
}

export interface CashFlowResult {
  entries: CashFlowEntry[];
  adjustedEntries: CashFlowEntry[];
  overdueItems: OverdueItem[];
  overdueTotals: OverdueTotals;
}

export interface EnvelopeWithOverride extends BudgetItem {
  overrides: EnvelopeOverride[];
}
