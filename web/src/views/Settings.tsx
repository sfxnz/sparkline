import { Panel } from '../design/components/Panel';
import { Skeleton } from '../design/components/Skeleton';
import './views.css';

const GROUPS: [string, number][] = [['Appearance', 2], ['Energy', 2], ['Sampling', 1], ['History', 1]];

export default function Settings() {
  return (
    <div className="view view--narrow" aria-busy="true">
      {GROUPS.map(([title, rows]) => (
        <Panel key={title} title={title} busy>
          <div className="ph-settings">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="ph-setting">
                <div className="ph-setting__text">
                  <Skeleton width={140} height={14} />
                  <Skeleton width={260} height={12} />
                </div>
                <Skeleton width={180} height={28} radius={10} />
              </div>
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}
