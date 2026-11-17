import { CommandLine } from '../../design/components/CommandLine';
import { Panel } from '../../design/components/Panel';
import { useHashTarget } from '../../design/useHashTarget';
import { SettingRow } from './parts';

export const PROMETHEUS_DOCS = 'https://github.com/sfxnz/sparkline#prometheus';

export function scrapeConfig(host: string, https: boolean): string {
  return [
    'scrape_configs:',
    '  - job_name: sparkline',
    '    scrape_interval: 15s',
    ...(https ? ['    scheme: https'] : []),
    '    static_configs:',
    `      - targets: ["${host}"]`,
    '    authorization:',
    '      credentials_file: /etc/prometheus/sparkline-metrics-token',
  ].join('\n');
}

/** Where Prometheus scrapes this console, and the job to paste. Nothing to switch on: /metrics is always served. */
export function PrometheusSection({ origin = window.location.origin }: { origin?: string }) {
  useHashTarget('prometheus');
  const url = new URL(origin);
  return (
    <Panel id="prometheus" title="Prometheus" subtitle="Every node’s latest reading is already served for Prometheus. Nothing to turn on here.">
      <div className="set-rows">
        <SettingRow id="set-prom-url" title="Scrape address" description="The address of this console as your browser reaches it. Prometheus needs to reach the same one.">
          <div className="set-copy"><CommandLine text={`${url.origin}/metrics`} what="scrape address" prompt={false} /></div>
        </SettingRow>
        <div className="set-block">
          <span className="set-row__title" id="set-prom-job-label">Scrape job</span>
          <p className="set-row__desc">
            Add this to <code>prometheus.yml</code>. The file it names holds the token Prometheus sends: set the same value as{' '}
            <code>metrics_token</code> in <code>console.toml</code>. That token opens <code>/metrics</code> and nothing else.
          </p>
          <CommandLine text={scrapeConfig(url.host, url.protocol === 'https:')} what="scrape job" />
          <p className="set-row__desc">
            <a href={PROMETHEUS_DOCS} target="_blank" rel="noreferrer">Series, units and setup in the README</a>
          </p>
        </div>
      </div>
    </Panel>
  );
}
