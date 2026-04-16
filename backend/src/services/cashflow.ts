import { getNotionBills } from './notion';
import { addDays, subDays, isAfter, isBefore } from 'date-fns';

interface CashFlowDay {
  date: string;
  balance: number;
  income: number;
  expenses: number;
  dueDate: string | null;
  isOverdue: boolean;
}

interface CashFlowResponse {
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

export async function getCashflowData(date: Date): Promise<CashFlowResponse> {
  const bills = await getNotionBills();

  let balance = bills.reduce((sum, bill) => sum + bill.amount, 0);
  let incomeSum = 0;
  let expensesSum = 0;

  const days: CashFlowDay[] = [];
  const maxBalance: { value: number } = { value: Number.MIN_VALUE };
  const minBalance: { value: number } = { value: Number.MAX_VALUE };
  let maxDate = date.toISOString();
  let minDate = date.toISOString();

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const oneMonthAgo = subDays(date, 30);

  let hasUpcomingBills = false;

  for (let i = 0; i < 30; i++) {
    const currentDate = addDays(date, i);
    const currentDateStr = currentDate.toISOString();
    const currentEndOfDay = new Date(currentDate);
    currentEndOfDay.setHours(23, 59, 59, 999);

    let currentBalance = balance;
    let currentIncome = incomeSum;
    let currentExpenses = expensesSum;

    bills.forEach(bill => {
      const billDueDate = new Date(bill.dueDate);
      billDueDate.setHours(0, 0, 0, 0);

      if (billDueDate <= currentEndOfDay && billDueDate > oneMonthAgo) {
        currentBalance -= bill.amount;
        currentIncome -= bill.amount;
        currentExpenses += bill.amount;
      }
    });

    const isOverdue = isAfter(currentEndOfDay, new Date()) || currentDate <= new Date();

    const day: CashFlowDay = {
      date: currentDateStr,
      balance: currentBalance,
      income: currentIncome,
      expenses: currentExpenses,
      dueDate: currentDate.toISOString(),
      isOverdue: isOverdue
    };

    days.push(day);

    if (currentBalance > maxBalance.value) {
      maxBalance.value = currentBalance;
      maxDate = currentDateStr;
    }
    if (currentBalance < minBalance.value) {
      minBalance.value = currentBalance;
      minDate = currentDateStr;
    }
  }

  const selectedDay = days.find(d => d.date === date.toISOString()) || days[0];

  const upcomingBills = bills.filter(bill => {
    const billDueDate = new Date(bill.dueDate);
    billDueDate.setHours(0, 0, 0, 0);
    return billDueDate >= date && isBefore(billDueDate, endOfDay);
  });

  const overdueBills = bills.filter(bill => {
    const billDueDate = new Date(bill.dueDate);
    billDueDate.setHours(0, 0, 0, 0);
    return billDueDate < new Date() && isBefore(billDueDate, new Date()) && new Date() <= endOfDay;
  });

  return {
    currentBalance,
    balanceAtDate: selectedDay,
    maxBalance: maxBalance.value,
    maxDate,
    minBalance: minBalance.value,
    minDate,
    billsAtDate: bills.slice(0, 10),
    upcomingBills,
    overdueBills
  };
}