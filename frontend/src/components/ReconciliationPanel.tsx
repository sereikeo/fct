import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getReconciliation,
  postReconciliation,
  deleteReconciliation,
  getEnvelopes,
  QUERY_KEYS,
  ReconciliationRecord,
} from '../services/api';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);

function deltaColor(delta: number) {
  if (delta < 0) return 'text-green-400';
  if (delta > 0) return 'text-red-400';
  return 'text-gray-400';
}

interface AddFormProps {
  envelopeMap: Record<string, string>;
  onClose: () => void;
}

function AddForm({ envelopeMap, onClose }: AddFormProps) {
  const qc = useQueryClient();
  const [budgetItemId, setBudgetItemId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [forecastAmount, setForecastAmount] = useState('');
  const [actualAmount, setActualAmount] = useState('');
  const [note, setNote] = useState('');

  const add = useMutation({
    mutationFn: () =>
      postReconciliation({
        budgetItemId,
        date,
        forecastAmount: parseFloat(forecastAmount),
        actualAmount: parseFloat(actualAmount),
        note: note || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.reconciliation });
      onClose();
    },
  });

  const valid = budgetItemId && date && forecastAmount && actualAmount;

  return (
    <div className="border-t border-gray-700 p-4 space-y-3">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Add reconciliation</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-400 mb-1">Budget item</label>
          <select
            value={budgetItemId}
            onChange={(e) => setBudgetItemId(e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Select…</option>
            {Object.entries(envelopeMap).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Forecast amount</label>
          <input
            type="number"
            value={forecastAmount}
            onChange={(e) => setForecastAmount(e.target.value)}
            placeholder="0.00"
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Actual amount</label>
          <input
            type="number"
            value={actualAmount}
            onChange={(e) => setActualAmount(e.target.value)}
            placeholder="0.00"
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Note (optional)</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => add.mutate()}
          disabled={!valid || add.isPending}
          className="px-4 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-white transition-colors"
        >
          {add.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function ReconciliationPanel() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.reconciliation,
    queryFn: getReconciliation,
  });

  const { data: envData } = useQuery({
    queryKey: QUERY_KEYS.envelopes,
    queryFn: getEnvelopes,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteReconciliation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.reconciliation }),
  });

  const envelopeMap: Record<string, string> = {};
  if (envData) {
    for (const e of envData.envelopes) {
      envelopeMap[e.id] = e.name;
    }
  }

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-xl p-6 text-gray-500 text-sm">Loading reconciliations…</div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-gray-800 rounded-xl p-6 text-red-400 text-sm">Failed to load reconciliations.</div>
    );
  }

  const records: ReconciliationRecord[] = data.records;

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Reconciliations</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg px-3 py-1 transition-colors"
        >
          + Add
        </button>
      </div>

      {showForm && <AddForm envelopeMap={envelopeMap} onClose={() => setShowForm(false)} />}

      <div className="overflow-x-auto">
        {records.length === 0 ? (
          <p className="px-4 py-6 text-center text-gray-500 text-sm">No reconciliations yet.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Forecast</th>
                <th className="px-3 py-2 text-right">Actual</th>
                <th className="px-3 py-2 text-right">Delta</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-t border-gray-700 hover:bg-gray-700/40 transition-colors">
                  <td className="px-3 py-2 text-xs font-mono text-gray-400">{r.date}</td>
                  <td className="px-3 py-2 text-sm text-white">
                    {envelopeMap[r.budgetItemId] ?? r.budgetItemId}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-gray-300">
                    {fmt(r.forecastAmount)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-white">
                    {fmt(r.actualAmount)}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono text-sm ${deltaColor(r.delta)}`}>
                    {r.delta > 0 ? '+' : ''}{fmt(r.delta)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => remove.mutate(r.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                      title="Delete"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
