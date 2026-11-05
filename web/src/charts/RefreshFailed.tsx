import { TriangleAlert } from 'lucide-react';
import { Tooltip } from '../design/components/Tooltip';
import { problemOf } from '../lib/api';

export function RefreshFailed({ error }: { error: unknown }) {
  const p = problemOf(error, 'refresh this history');
  return (
    <Tooltip content={<>{p.cause || p.message}<br />Showing the history loaded last. It refreshes again automatically.</>}>
      <button type="button" className="refresh-failed" data-refresh-failed>
        <TriangleAlert aria-hidden="true" />
        Couldn’t refresh
      </button>
    </Tooltip>
  );
}
