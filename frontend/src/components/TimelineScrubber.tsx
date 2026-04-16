import React, { useState, useEffect } from 'react';
import { format, addDays } from 'date-fns';

interface TimelineScrubberProps {
  currentDate: Date;
  onDateChange: (date: Date) => void;
}

const TimelineScrubber: React.FC<TimelineScrubberProps> = ({ currentDate, onDateChange }) => {
  const [selectedDate, setSelectedDate] = useState(currentDate);
  const [daysToShow, setDaysToShow] = useState(30);

  const handleDateChange = (date: Date) => {
    setSelectedDate(date);
    onDateChange(date);
  };

  const resetToToday = () => {
    handleDateChange(new Date());
  };

  const handleNextDay = () => {
    handleDateChange(addDays(selectedDate, 1));
  };

  const handlePrevDay = () => {
    handleDateChange(addDays(selectedDate, -1));
  };

  const renderDay = (date: Date) => {
    const isToday = format(date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
    const isSelected = format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd');

    return (
      <button
        key={date.toISOString()}
        onClick={() => handleDateChange(date)}
        className={`px-4 py-2 rounded-lg transition-all ${
          isSelected
            ? 'bg-blue-600 text-white'
            : isToday
            ? 'bg-green-600 text-white'
            : 'bg-gray-100 hover:bg-gray-200'
        }`}
      >
        {format(date, 'MMM dd')}
      </button>
    );
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          <button
            onClick={handlePrevDay}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={resetToToday}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Today
          </button>
          <button
            onClick={handleNextDay}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        <div className="text-lg font-semibold">
          {format(selectedDate, 'MMMM d, yyyy')}
        </div>
      </div>
      <div className="flex space-x-1 overflow-x-auto pb-2">
        {Array.from({ length: daysToShow }, (_, i) => {
          const date = addDays(selectedDate, i - Math.floor(daysToShow / 2));
          return renderDay(date);
        })}
      </div>
    </div>
  );
};

export default TimelineScrubber;