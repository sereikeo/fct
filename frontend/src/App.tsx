import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from './components/Dashboard';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export default function App() {
  const today = new Date();
  const [dateRange, setDateRange] = useState({
    from: toISO(today),
    to: toISO(addDays(today, 90)),
  });

  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard dateRange={dateRange} onDateRangeChange={setDateRange} />
    </QueryClientProvider>
  );
}
