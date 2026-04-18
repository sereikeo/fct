import SyncStatus from './SyncStatus';
import TimelineScrubber from './TimelineScrubber';
import CashFlowChart from './CashFlowChart';
import EnvelopePanel from './EnvelopePanel';
import ReconciliationPanel from './ReconciliationPanel';

interface DateRange {
  from: string;
  to: string;
}

interface Props {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
}

export default function Dashboard({ dateRange, onDateRangeChange }: Props) {
  return (
    <div className="max-w-[1440px] mx-auto px-7 py-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Future Cash Timeline</h1>
          <p className="text-gray-400 text-sm mt-0.5">Personal financial dashboard</p>
        </div>
        <SyncStatus />
      </div>

      <TimelineScrubber dateRange={dateRange} onDateRangeChange={onDateRangeChange} />

      <CashFlowChart from={dateRange.from} to={dateRange.to} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <EnvelopePanel />
        <ReconciliationPanel />
      </div>
    </div>
  );
}
