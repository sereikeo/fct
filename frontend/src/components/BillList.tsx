import React, { useState, useEffect } from 'react';
import { formatCurrency } from '../../utils/currency';

interface Bill {
  id: string;
  name: string;
  amount: number;
  dueDate: Date;
  recurring: boolean;
}

interface BillListProps {
  bills: Bill[];
  selectedDate: Date;
  showUpcoming: boolean;
}

const BillList: React.FC<BillListProps> = ({ bills, selectedDate, showUpcoming }) => {
  const getDueStatus = (bill: Bill, date: Date) => {
    if (!bill.dueDate) return 'unknown';

    const billDate = new Date(bill.dueDate);
    const diff = billDate.getTime() - date.getTime();
    const daysDiff = Math.ceil(diff / (1000 * 60 * 60 * 24));

    if (daysDiff < 0) return 'overdue';
    if (daysDiff === 0) return 'due';
    if (daysDiff <= 3) return 'soon';
    return 'upcoming';
  };

  const sortBills = (bills: Bill[]) => {
    return [...bills].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-xl font-semibold mb-4">
        {showUpcoming ? 'Upcoming Bills' : 'Bills for Selected Date'}
      </h2>
      <div className="space-y-4">
        {sortBills(bills).map(bill => {
          const status = getDueStatus(bill, selectedDate);
          const isDueToday = status === 'due';
          const isOverdue = status === 'overdue';

          let statusClass = '';
          let statusText = '';

          switch (status) {
            case 'overdue':
              statusClass = 'bg-red-100 text-red-800';
              statusText = 'Overdue';
              break;
            case 'due':
              statusClass = 'bg-yellow-100 text-yellow-800';
              statusText = 'Due Today';
              break;
            case 'soon':
              statusClass = 'bg-orange-100 text-orange-800';
              const daysUntil = Math.ceil(
                new Date(bill.dueDate).getTime() - new Date().getTime()
              ) / (1000 * 60 * 60 * 24);
              statusText = `Due in ${daysUntil} days`;
              break;
            case 'upcoming':
              statusClass = 'bg-green-100 text-green-800';
              statusText = 'Upcoming';
              break;
            default:
              statusClass = 'bg-gray-100 text-gray-800';
              statusText = 'Unknown';
          }

          return (
            <div
              key={bill.id}
              className={`border rounded-lg p-4 ${isDueToday ? 'border-yellow-400 bg-yellow-50' : isOverdue ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}
            >
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="font-semibold text-lg">{bill.name}</h3>
                  <div className="flex items-center space-x-2 mt-1">
                    {bill.recurring && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                        Recurring
                      </span>
                    )}
                    <span className={`text-xs px-2 py-1 rounded ${statusClass}`}>
                      {statusText}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xl font-bold text-gray-800">
                    {formatCurrency(bill.amount)}
                  </p>
                  <p className="text-sm text-gray-500">
                    Due: {new Date(bill.dueDate).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
        {bills.length === 0 && (
          <div className="text-gray-500 text-center py-8">
            {showUpcoming ? 'No upcoming bills found' : 'No bills for this date'}
          </div>
        )}
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

export default BillList;