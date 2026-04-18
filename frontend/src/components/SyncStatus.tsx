import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getHealth, postSync, QUERY_KEYS } from '../services/api';
import { useState } from 'react';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function SyncStatus() {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const { data } = useQuery({
    queryKey: QUERY_KEYS.health,
    queryFn: getHealth,
    refetchInterval: 60_000,
  });

  const stale =
    data?.notionSyncedAt
      ? Date.now() - new Date(data.notionSyncedAt).getTime() > 10 * 60 * 1000
      : true;

  async function handleSync() {
    setSyncing(true);
    try {
      await postSync();
      await qc.invalidateQueries();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 bg-gray-800 rounded-full px-3 py-1.5 text-xs">
        <span
          className={`w-2 h-2 rounded-full ${stale ? 'bg-yellow-400' : 'bg-green-400'}`}
        />
        <span className="text-gray-300">
          Notion · synced {relativeTime(data?.notionSyncedAt ?? null)}
        </span>
        {data?.syncError && (
          <span className="text-red-400 ml-1" title={data.syncError}>⚠</span>
        )}
      </div>
      <button
        onClick={handleSync}
        disabled={syncing}
        className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 rounded-full px-3 py-1.5 transition-colors"
      >
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}
