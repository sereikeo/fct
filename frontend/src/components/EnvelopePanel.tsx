import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getEnvelopes, patchEnvelope, deleteEnvelope, QUERY_KEYS, EnvelopeWithOverride } from '../services/api';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

interface OverrideRowProps {
  envelope: EnvelopeWithOverride;
}

function OverrideRow({ envelope }: OverrideRowProps) {
  const qc = useQueryClient();
  const period = currentPeriod();
  const existing = envelope.overrides.find((o) => o.period === period);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(existing?.overrideAmount ?? envelope.forecastAmount));

  const save = useMutation({
    mutationFn: () =>
      patchEnvelope(envelope.id, { period, overrideAmount: parseFloat(draft) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.envelopes }),
  });

  const remove = useMutation({
    mutationFn: () => deleteEnvelope(envelope.id, period),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.envelopes }),
  });

  return (
    <tr className="border-t border-gray-700 hover:bg-gray-700/40 transition-colors">
      <td className="px-3 py-2 text-sm text-white">{envelope.name}</td>
      <td className="px-3 py-2 text-xs text-gray-400 capitalize">{envelope.bucket}</td>
      <td className="px-3 py-2 text-xs text-gray-400">{envelope.frequency}</td>
      <td className="px-3 py-2 text-right font-mono text-sm text-gray-300">
        {fmt(envelope.forecastAmount)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-sm">
        {envelope.isVariable ? (
          editing ? (
            <input
              autoFocus
              type="number"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditing(false);
                if (draft && parseFloat(draft) !== envelope.forecastAmount) {
                  save.mutate();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') { setDraft(String(existing?.overrideAmount ?? envelope.forecastAmount)); setEditing(false); }
              }}
              className="w-28 bg-gray-700 border border-indigo-500 rounded px-2 py-0.5 text-white text-right text-sm focus:outline-none"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className={`hover:underline ${existing ? 'text-indigo-400' : 'text-gray-400'}`}
            >
              {existing ? fmt(existing.overrideAmount) : '—'}
            </button>
          )
        ) : (
          <span className="text-gray-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        {existing && (
          <button
            onClick={() => remove.mutate()}
            className="text-xs text-red-400 hover:text-red-300"
            title="Remove override"
          >
            ×
          </button>
        )}
      </td>
    </tr>
  );
}

export default function EnvelopePanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.envelopes,
    queryFn: getEnvelopes,
  });

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-xl p-6 text-gray-500 text-sm">Loading envelopes…</div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-gray-800 rounded-xl p-6 text-red-400 text-sm">Failed to load envelopes.</div>
    );
  }

  const envelopes = data.envelopes.filter((e) => !e.deletedAt);

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Budget Envelopes</h2>
        <span className="text-xs text-gray-400">{envelopes.length} items</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Bucket</th>
              <th className="px-3 py-2">Freq</th>
              <th className="px-3 py-2 text-right">Forecast</th>
              <th className="px-3 py-2 text-right">Override</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {envelopes.map((env) => (
              <OverrideRow key={env.id} envelope={env} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
