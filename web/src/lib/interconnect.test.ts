import shared from '../test/fixtures/rails.json';
import { ifaceLabel, nicAbbr, nicHeading, nicModel, nicNoun, noLinkReason, railName, rdmaCounting } from './interconnect';
import type { NetIfInfo } from './types';

const nif = (name: string, p: Partial<NetIfInfo> = {}): NetIfInfo => ({
  name, role: 'interconnect', label: 'Interconnect A', mac: null, ipv4: [], speed_mbps: null, rdma_device: null, counter_source: 'netdev', peer: null, ...p,
});

describe('ifaceLabel', () => {
  it('names a lettered interconnect by its NIC model', () => {
    expect(ifaceLabel({ label: 'Interconnect A', nic_model: 'ConnectX-7' })).toBe('ConnectX-7 rail A');
    expect(ifaceLabel({ label: 'Interconnect B', nic_model: 'Intel E810-C' })).toBe('Intel E810-C rail B');
  });

  it('keeps the rest of an interconnect label after the model', () => {
    expect(ifaceLabel({ label: 'Interconnect port (no cable)', nic_model: 'ConnectX-7' })).toBe('ConnectX-7 port (no cable)');
  });

  it('shows labels as sent without a model or outside the interconnect wording', () => {
    expect(ifaceLabel({ label: 'ConnectX-7 rail A' })).toBe('ConnectX-7 rail A');
    expect(ifaceLabel({ label: 'Interconnect A', nic_model: null })).toBe('Interconnect A');
    expect(ifaceLabel({ label: 'LAN', nic_model: 'Intel E810-C' })).toBe('LAN');
  });
});

describe('railName', () => {
  it.each(shared.cases)('$case', ({ net, rails }) => {
    const letterOf = new Map(Object.entries(rails).map(([letter, name]) => [name, letter]));
    for (const n of (net as NetIfInfo[]).filter((x) => x.role === 'interconnect')) {
      const letter = letterOf.get(n.name);
      expect(railName(n)).toBe(letter ? `Rail ${letter}` : n.name);
    }
  });
});

describe('nicModel', () => {
  it('is the model every interconnect reports, across one node or several', () => {
    const cx7 = [nif('a', { nic_model: 'ConnectX-7' }), nif('b', { nic_model: 'ConnectX-7' }), nif('lan', { role: 'lan', nic_model: 'Intel E810-C' })];
    expect(nicModel(cx7)).toBe('ConnectX-7');
    expect(nicModel([...cx7, nif('c', { nic_model: 'ConnectX-7' })])).toBe('ConnectX-7');
  });

  it('is null when no interconnect reports one, they disagree, or one is unknown', () => {
    expect(nicModel([nif('a')])).toBeNull();
    expect(nicModel([nif('a', { nic_model: 'ConnectX-7' }), nif('b', { nic_model: 'Intel E810-C' })])).toBeNull();
    expect(nicModel([nif('a', { nic_model: 'ConnectX-7' }), nif('b', { nic_model: null })])).toBeNull();
    expect(nicModel([nif('lan', { role: 'lan', nic_model: 'Intel E810-C' })])).toBeNull();
    expect(nicModel(undefined)).toBeNull();
  });

  it('words headings and sentences with the model, else generically', () => {
    expect([nicHeading('ConnectX-7'), nicNoun('ConnectX-7')]).toEqual(['ConnectX-7', 'ConnectX-7']);
    expect([nicHeading(null), nicNoun(null)]).toEqual(['Interconnect', 'interconnect']);
    expect(noLinkReason('ConnectX-7')).toBe('No ConnectX-7 rail on this node is cabled to another node.');
    expect(noLinkReason(null)).toBe('No interconnect rail on this node is cabled to another node.');
  });

  it('abbreviates ConnectX models only', () => {
    expect(nicAbbr('ConnectX-7')).toBe('CX7');
    expect(nicAbbr('ConnectX-6 Dx')).toBe('CX6 Dx');
    expect(nicAbbr('Intel E810-C')).toBeNull();
    expect(nicAbbr(null)).toBeNull();
  });
});

describe('rdmaCounting', () => {
  it('says RDMA is included when every interface counts it', () => {
    expect(rdmaCounting([nif('a', { counter_source: 'netdev_rdma', rdma_device: 'roce0' }), nif('b', { counter_source: 'ethtool_phy' })])).toEqual({ kind: 'included' });
  });

  it('names the RDMA-capable interfaces whose counters leave RDMA out', () => {
    const plain = nif('b', { rdma_device: 'irdma1' });
    expect(rdmaCounting([nif('a', { counter_source: 'netdev_rdma', rdma_device: 'roce0' }), plain, nif('c')])).toEqual({ kind: 'missing', ifaces: [plain] });
  });

  it('has nothing to say without RDMA devices or interfaces', () => {
    expect(rdmaCounting([nif('a'), nif('b')])).toEqual({ kind: 'none' });
    expect(rdmaCounting([])).toEqual({ kind: 'none' });
  });
});
