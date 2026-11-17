// Console answers for the Recommendations tests: three settings (one-click and forgotten at a reboot, one-click and
// persistent, not one-click), a measurement, and builders for what a node says.
import type { NodeRecState, NodeRecommendations, Problem, RecMeasurement, RecState, Recommendation, RecommendationsView } from '../../lib/types';

export const gpuCap: Recommendation = {
  id: 'gpu-clock-cap',
  title: 'Cap the GPU clock at 2200 MHz',
  summary: 'Sets a ceiling on the GPU clock. It is forgotten at a reboot.',
  goal: 'cooler',
  benefit: 'Owners report a cooler GPU that draws less power.',
  cost: 'Owners report little or no loss in decode speed.',
  sources: [
    { title: 'NVIDIA forum: Cooler GB10 temps', url: 'https://forums.developer.nvidia.com/t/cooler-gb10-temps/372662' },
    { title: 'NVIDIA DGX Spark release notes', url: 'https://docs.nvidia.com/dgx/dgx-spark/release-notes.html' },
  ],
  measurement: null,
  apply: ['sudo nvidia-smi -lgc 0,2200', 'sudo systemctl enable --now gpu-clock-cap.service'],
  undo: ['sudo nvidia-smi -rgc', 'sudo systemctl disable --now gpu-clock-cap.service'],
  one_click: true,
  persists: 'until-reboot',
  risks: ['It does not cool the CPU cores.', '2200 MHz may not be low enough for every unit.'],
  verified: false,
};

export const headless: Recommendation = {
  id: 'headless-boot',
  title: 'Boot without the desktop',
  summary: 'Makes the machine boot to text mode.',
  goal: 'roomier',
  benefit: 'Owners report 2 to 3 GB of memory back.',
  cost: 'There is no local desktop.',
  sources: [{ title: 'NVIDIA forum: Memory creep on DGX Spark', url: 'https://forums.developer.nvidia.com/t/memory-creep/364886' }],
  measurement: null,
  apply: ['sudo systemctl set-default multi-user.target'],
  undo: ['sudo systemctl set-default graphical.target'],
  one_click: true,
  persists: 'persistent',
  risks: ['On old firmware a unit without a display could stop its fans.'],
  verified: false,
};

export const displayMemory: Recommendation = {
  id: 'display-reserved-memory',
  title: 'Set Display Reserved Memory to Auto',
  summary: 'A firmware setting. It needs a reboot.',
  goal: 'roomier',
  benefit: 'NVIDIA documents up to 1.5 GB more memory.',
  cost: 'None reported on a machine without a display.',
  sources: [{ title: 'NVIDIA DGX Spark UEFI manual', url: 'https://docs.nvidia.com/dgx/dgx-spark-uefi/advanced-tab.html' }],
  measurement: null,
  apply: ["printf '\\x07' | sudo tee /sys/firmware/efi/efivars/NvidiaDispFrmSizeRequest", 'sudo reboot'],
  undo: ["printf '\\x03' | sudo tee /sys/firmware/efi/efivars/NvidiaDispFrmSizeRequest", 'sudo reboot'],
  one_click: false,
  persists: 'persistent',
  risks: ['Auto looks for displays only at boot.'],
  verified: false,
};

export const measurement: RecMeasurement = {
  date: '2026-11-20',
  machine: 'DGX Spark Founders Edition, firmware OTA2610',
  method: 'Ten minutes of sustained decode, three runs each way, GPU power read every second.',
  results: [
    { label: 'GPU power under load', before: 84, after: 51, unit: 'W' },
    { label: 'Decode speed', before: 51.3, after: 51.4, unit: 'tokens/s' },
  ],
  doc: 'docs/recommendations/gpu-clock-cap.md',
};

export const noHelper: Problem = {
  message: 'spark3 does not take one-click settings',
  cause: '/etc/systemd/system/sparkline-tune.path is not installed',
  fix: 'Reinstall the agent on spark3 with install.sh agent --enable-tune, or type the commands',
};

export const unreachable: Problem = {
  message: 'Agent unreachable on spark4',
  cause: 'Connection refused',
  fix: 'Check `systemctl status sparkline-agent` on spark4',
};

export const item = (id: string, state: RecState, detail: string, more: Partial<NodeRecState> = {}): NodeRecState => ({ id, state, detail, managed: false, last: null, ...more });

export const node = (items: NodeRecState[], one_click: Problem | null = null): NodeRecommendations => ({ one_click, items });

export const view = (catalog: Recommendation[], nodes: RecommendationsView['nodes'], problems: RecommendationsView['problems'] = {}): RecommendationsView => ({ catalog, nodes, problems });
