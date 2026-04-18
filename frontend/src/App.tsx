import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from './components/Dashboard';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function App() {
  const today = new Date();
  const plus90 = new Date(today);
  plus90.setDate(plus90.getDate() + 90);

  const [dateRange, setDateRange] = useState({
    from: toISO(today),
    to: toISO(plus90),
  });

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-900 text-white">
        <Dashboard dateRange={dateRange} onDateRangeChange={setDateRange} />
      </div>
    </QueryClientProvider>
  );
}
