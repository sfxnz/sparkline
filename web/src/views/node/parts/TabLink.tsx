import { ChevronRight } from 'lucide-react';
import { Link } from 'wouter';
import { paths, type NodeTab } from '../../../app/routes';

/** Quiet "Section ›" link in a panel header, to the tab with the detail. */
export function TabLink({ nodeId, tab, children }: { nodeId: string; tab: NodeTab; children: string }) {
  return (
    <Link href={paths.node(nodeId, tab)} className="ntablink">
      {children}
      <ChevronRight aria-hidden="true" />
    </Link>
  );
}
