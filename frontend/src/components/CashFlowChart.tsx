import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { getCashflow, QUERY_KEYS, CashFlowEntry } from '../services/api';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs space-y-1">
      <p className="text-gray-400 font-medium">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-mono">{fmt(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

interface Props {
  from: string;
  to: string;
}

export default function CashFlowChart({ from, to }: Props) {
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.cashflow(from, to),
    queryFn: () => getCashflow(from, to),
  });

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-xl p-6 h-72 flex items-center justify-center text-gray-500 text-sm">
        Loading chart…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-gray-800 rounded-xl p-6 h-72 flex items-center justify-center text-red-400 text-sm">
        Failed to load cashflow data.
      </div>
    );
  }

  const chartData = data.entries.map((e: CashFlowEntry) => ({
    date: e.date,
    Personal: e.balP,
    Maple: e.balM,
    Combined: e.balance,
  }));

  const personalFinal = data.entries.at(-1)?.balP ?? 0;
  const mapleFinal = data.entries.at(-1)?.balM ?? 0;
  const minBalance = Math.min(...data.entries.map((e) => Math.min(e.balP, e.balM)));
  const minDate = data.entries.find((e) => Math.min(e.balP, e.balM) === minBalance)?.date ?? '';

  return (
    <div className="bg-gray-800 rounded-xl p-6 space-y-4">
      <div className="flex flex-wrap gap-6">
        <div>
          <p className="text-xs text-gray-400">Projected cash on {to}</p>
          <p className="text-2xl font-mono font-semibold">
            <span className="text-blue-400">{fmt(personalFinal)}</span>
            <span className="text-gray-500 mx-1">/</span>
            <span className="text-purple-400">{fmt(mapleFinal)}</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Low point · next 90d</p>
          <p className="text-xl font-mono text-red-400">{fmt(minBalance)}</p>
          <p className="text-xs text-gray-500">{minDate}</p>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis
            dataKey="date"
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            tickFormatter={(v: string) => v.slice(5)}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="Personal"
            stroke="#1f4f7a"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="Maple"
            stroke="#6b3fa0"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
