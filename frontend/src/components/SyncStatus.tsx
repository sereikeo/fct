import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getHealth, postSync, QUERY_KEYS } from '../services/api';

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

  const stale = !data?.notionSyncedAt ||
    Date.now() - new Date(data.notionSyncedAt).getTime() > 10 * 60 * 1000;
  const hasError = !!data?.syncError;

  async function handleSync() {
    setSyncing(true);
    try {
      await postSync();
      await qc.invalidateQueries();
    } finally {
      setSyncing(false);
    }
  }

  const dotClass = `dot${hasError ? ' err' : stale ? ' stale' : ''}`;

  return (
    <>
      <div className="sync">
        <span className={dotClass} />
        <span>Notion · synced {relativeTime(data?.notionSyncedAt ?? null)}</span>
        {hasError && <span title={data!.syncError} style={{ color: 'var(--accent)', marginLeft: 4 }}>⚠</span>}
      </div>
      <button
        className="btn ghost sync-now"
        onClick={handleSync}
        disabled={syncing}
        style={{ fontSize: 12, padding: '6px 12px' }}
      >
        {syncing ? 'Syncing…' : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>
            </svg>
            Sync now
          </>
        )}
      </button>
    </>
  );
}
