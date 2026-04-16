import { format, differenceInDays, addDays, subDays, isAfter, isBefore } from 'date-fns';

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function formatDateDisplay(date: Date): string {
  return format(date, 'MMM dd, yyyy');
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
}

export function getNextDueDate(date: Date, bills: any[]): Date | null {
  const futureBills = bills.filter(bill => {
    const billDueDate = new Date(bill.dueDate);
    billDueDate.setHours(0, 0, 0, 0);
    return billDueDate >= date;
  });

  if (futureBills.length === 0) return null;

  return futureBills.reduce((minDate, bill) => {
    const billDueDate = new Date(bill.dueDate);
    return billDueDate < minDate ? billDueDate : minDate;
  }, new Date(futureBills[0].dueDate));
}

export function getDaysUntilNextDue(date: Date, dueDate: Date): number {
  return differenceInDays(dueDate, date);
}

export function isBillOverdue(billDate: Date): boolean {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return billDate < now;
}

export function isInTimelineRange(date: Date, days: number = 90): boolean {
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + days);
  return date >= new Date() && date <= maxDate;
}