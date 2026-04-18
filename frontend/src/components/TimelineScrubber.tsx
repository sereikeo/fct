interface DateRange {
  from: string;
  to: string;
}

interface Props {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
}

export default function TimelineScrubber({ dateRange, onDateRangeChange }: Props) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 flex flex-wrap items-center gap-4">
      <span className="text-gray-400 text-sm font-medium">Date range</span>
      <div className="flex items-center gap-2">
        <label className="text-gray-400 text-xs">From</label>
        <input
          type="date"
          value={dateRange.from}
          onChange={(e) => onDateRangeChange({ ...dateRange, from: e.target.value })}
          className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-gray-400 text-xs">To</label>
        <input
          type="date"
          value={dateRange.to}
          onChange={(e) => onDateRangeChange({ ...dateRange, to: e.target.value })}
          className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div className="flex gap-2 ml-auto">
        {(['1M', '3M', '6M', '1Y'] as const).map((label) => {
          const days = label === '1M' ? 30 : label === '3M' ? 90 : label === '6M' ? 180 : 365;
          return (
            <button
              key={label}
              onClick={() => {
                const from = new Date();
                const to = new Date();
                to.setDate(to.getDate() + days);
                onDateRangeChange({
                  from: from.toISOString().slice(0, 10),
                  to: to.toISOString().slice(0, 10),
                });
              }}
              className="px-3 py-1 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
