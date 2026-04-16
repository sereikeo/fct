import { formatCurrency } from '../../utils/currency';

export interface Wallet {
  source: string;
  balance: number;
}

export interface Transaction {
  id: string;
  entity: string;
  amount: number;
  category: string;
  date: Date;
  recurring: boolean;
}

export interface Bill {
  id: string;
  name: string;
  amount: number;
  dueDate: Date;
  recurring: boolean;
}