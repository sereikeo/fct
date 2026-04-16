import React, { useState, useEffect } from 'react';
import TimelineScrubber from './TimelineScrubber';
import CashFlowChart from './CashFlowChart';
import BillList from './BillList';
import { cashflowApi } from '../services/api';
import { APIResponse, NotionBill } from '../types';
import { formatDate, formatCurrency } from '../../utils/currency';

interface DashboardProps {}

const Dashboard: React.FC<DashboardProps> = () => {
  const [data, setData] = useState<APIResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCashflowData();
  }, []);

  const fetchCashflowData = async () => {
    try {
      setLoading(true);
      const dateStr = formatDate(selectedDate);
      const response = await cashflowApi.getDate(dateStr);
      setData(response.data);
      setError(null);
    } catch (err) {
      setError('Failed to fetch cashflow data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDateChange = (date: Date) => {
    setSelectedDate(date);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="bg-white rounded-lg shadow p-6 text-center">
          <p className="text-red-600 mb-4">{error || 'No data available'}</p>
          <button
            onClick={fetchCashflowData}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-6xl mx-auto py-8 px-4">
        <div className="mb-6">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">Future Cash Timeline</h1>
          <p className="text-gray-600">Track your current and future cash positions with bill management</p>
        </div>

        <TimelineScrubber currentDate={selectedDate} onDateChange={handleDateChange} />

        <div className="mt-6">
          <CashFlowChart data={data} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
          <div>
            <h2 className="text-xl font-semibold mb-4">Bills for Selected Date</h2>
            <BillList
              bills={data.billsAtDate}
              selectedDate={selectedDate}
              showUpcoming={false}
            />
          </div>
          <div>
            <h2 className="text-xl font-semibold mb-4">Upcoming Bills</h2>
            <BillList
              bills={data.upcomingBills}
              selectedDate={selectedDate}
              showUpcoming={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(value);
};

export default Dashboard;