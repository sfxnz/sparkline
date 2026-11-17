// A node that has never answered the console: what was tried, the likely cause, the fix in full with each command
// copyable, and when the console tries again. A setup step, not an outage: no warning colour, nothing truncated.
// The overview card and the node's own page both show this block.
import { Ban, RotateCw, Server, Unplug } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../design/components/Button';
import { CommandLine } from '../../design/components/CommandLine';
import { InlineCode } from '../../design/components/InlineCode';
import { useNow } from '../../design/useNow';
import { api } from '../../lib/api';
import { agentAddress, fixSteps, reachOf, retryWait } from '../../lib/onboarding';
import type { NodeState } from '../../lib/types';
import { serverNow } from '../../store/cluster';
import './nodeSetup.css';

function Mark() {
  return (
    <svg className="setup-link__mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--accent-fill)" />
      <path d="M7 19.5h4l2.5-7 4 12 3-9 1.5 4H25" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Console -> node, with a mark where the request stopped. Solid line: reached. Dotted: not reached. */
function LinkPicture({ node }: { node: NodeState }) {
  const reach = reachOf(node.status);
  const Stop = reach === 'turned-away' ? Ban : Unplug;
  const said = reach === 'turned-away'
    ? `The console reached the agent on ${node.node_id} at ${agentAddress(node.url)}, and the agent turned it away.`
    : `The console tried ${node.node_id} at ${agentAddress(node.url)} and nothing answered.`;
  return (
    <div className="setup-link" data-reach={reach} role="img" aria-label={said}>
      <span className="setup-link__end"><Mark />Console</span>
      <span className="setup-link__wire"><span className="setup-link__stop"><Stop /></span></span>
      <span className="setup-link__end setup-link__end--far"><Server />{node.node_id}</span>
    </div>
  );
}

function Retry({ node }: { node: NodeState }) {
  useNow(1000);
  const now = serverNow();
  const next = node.next_retry_ts;
  // When this wait was first seen, so the bar can show how much of it is left.
  const [wait, setWait] = useState({ next, learned: now });
  if (wait.next !== next) setWait({ next, learned: now });
  // "Retry now" was pressed for this wait: say so until the console reports the outcome (a new wait, or online).
  const [askedFor, setAskedFor] = useState<number | null | undefined>(undefined);
  const { secs, left } = retryWait(next, wait.learned, now);
  const trying = secs === 0 || askedFor === next;
  // An agent that answered and said no gives the next try the same answer: the fix is the news, not the wait.
  const turnedAway = reachOf(node.status) === 'turned-away';
  return (
    <div className="setup-retry">
      <div className="setup-retry__bar" aria-hidden="true"><i style={{ transform: `scaleX(${trying || turnedAway ? 0 : left})` }} /></div>
      <div className="setup-retry__row">
        <span className="setup-retry__status">
          <RotateCw aria-hidden="true" className={trying ? 'status__icon--spin' : undefined} />
          {trying ? (
            <span>Trying now…</span>
          ) : turnedAway ? (
            <span>It goes live once the fix above is done. Until then every try gets the same answer (next in <span className="num">{secs}&nbsp;s</span>).</span>
          ) : (
            <span>Trying again in <span className="num">{secs}&nbsp;s</span></span>
          )}
        </span>
        {/* Never disabled: it may hold the keyboard focus, and asking twice does no harm. */}
        <Button size="sm" icon={<RotateCw />} onClick={() => { setAskedFor(next); void api.retryNode(node.node_id).catch(() => { setAskedFor(undefined); }); }}>
          Retry now
        </Button>
      </div>
      <span className="visually-hidden" role="status">{askedFor === next ? `Trying ${node.node_id} now` : ''}</span>
    </div>
  );
}

export function NodeSetup({ node, headingLevel = 3 }: { node: NodeState; headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as const;
  const problem = node.error;
  const steps = fixSteps(problem?.fix ?? `Check that sparkline-agent is running on ${node.node_id} and that the console can reach ${agentAddress(node.url)}`);
  return (
    <div className="setup">
      <div className="setup__grid">
        <div className="setup__what">
          <LinkPicture node={node} />
          <Heading className="setup__msg">{problem?.message ?? `${node.node_id} has not answered yet`}</Heading>
          {problem?.cause ? (
            <div className="setup__row">
              <span className="setup__label">Likely cause</span>
              <p className="setup__cause"><InlineCode text={problem.cause} /></p>
            </div>
          ) : null}
        </div>
        <div className="setup__row setup__fix">
          <span className="setup__label">How to fix</span>
          {steps.map((step) => (
            <div key={step.text} className="setup__step">
              <p className="setup__fix-text"><InlineCode text={step.text} /></p>
              {step.commands.map((c) => <CommandLine key={c} text={c} />)}
            </div>
          ))}
        </div>
      </div>
      <Retry node={node} />
    </div>
  );
}
