import React, { useState, useEffect } from 'react';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid
} from 'recharts';
import { formatCurrency } from '../../utils/currency';

interface CashFlowChartProps {
  data: any;
}

const CashFlowChart: React.FC<CashFlowChartProps> = ({ data }) => {
  const [chartData, setChartData] = useState<any[]>([]);

  useEffect(() => {
    if (data && data.balanceAtDate) {
      const chartInfo: any = {
        date: formatCurrency(data.balanceAtDate.date),
        balance: data.balanceAtDate.balance,
        income: data.balanceAtDate.income,
        expenses: data.balanceAtDate.expenses
      };
      setChartData([chartInfo]);
    }
  }, [data]);

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-xl font-semibold mb-4">90-Day Cash Flow Analysis</h2>
      <div className="relative" style={{ height: '400px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={(value) => value}
            />
            <YAxis
              tickFormatter={formatCurrency}
            />
            <Tooltip
              formatter={(value: number) => formatCurrency(value)}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="balance"
              stroke="#3b82f6"
              strokeWidth={2}
              name="Balance"
            />
            <Line
              type="monotone"
              dataKey="income"
              stroke="#10b981"
              strokeWidth={2}
              name="Income"
            />
            <Line
              type="monotone"
              dataKey="expenses"
              stroke="#ef4444"
              strokeWidth={2}
              name="Expenses"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-blue-50 p-4 rounded-lg">
          <p className="text-sm text-gray-600">Current Balance</p>
          <p className="text-2xl font-bold text-blue-600">
            {formatCurrency(data.currentBalance)}
          </p>
        </div>
        <div className="bg-green-50 p-4 rounded-lg">
          <p className="text-sm text-gray-600">Max Balance</p>
          <p className="text-2xl font-bold text-green-600">
            {formatCurrency(data.maxBalance)}
          </p>
          <p className="text-xs text-gray-500">{data.maxDate}</p>
        </div>
        <div className="bg-red-50 p-4 rounded-lg">
          <p className="text-sm text-gray-600">Min Balance</p>
          <p className="text-2xl font-bold text-red-600">
            {formatCurrency(data.minBalance)}
          </p>
          <p className="text-xs text-gray-500">{data.minDate}</p>
        </div>
        <div className="bg-purple-50 p-4 rounded-lg">
          <p className="text-sm text-gray-600">Balance on Selected Date</p>
          <p className="text-2xl font-bold text-purple-600">
            {formatCurrency(data.balanceAtDate.balance)}
          </p>
        </div>
      </div>
    </div>
  );
};

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(value);
};

export default CashFlowChart;