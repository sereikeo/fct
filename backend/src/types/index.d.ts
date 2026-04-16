export interface CashFlowDay {
  date: string;
  balance: number;
  income: number;
  expenses: number;
  dueDate: string | null;
  isOverdue: boolean;
}

export interface APIResponse {
  currentBalance: number;
  balanceAtDate: CashFlowDay;
  maxBalance: number;
  maxDate: string;
  minBalance: number;
  minDate: string;
  billsAtDate: any[];
  upcomingBills: any[];
  overdueBills: any[];
}