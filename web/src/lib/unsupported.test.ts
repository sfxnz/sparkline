import { unsupportedReason } from './unsupported';

describe('unsupportedReason', () => {
  it('finds unsupported reasons by exact key or prefix', () => {
    const info = { unsupported: [{ metric: 'gpu0.power_limit_w', reason: 'NVML: Not Supported' }, { metric: 'fan', reason: 'No fan sensors' }] };
    expect(unsupportedReason(info as never, 'gpu0.power_limit_w')).toBe('NVML: Not Supported');
    expect(unsupportedReason(info as never, 'fan.0.rpm')).toBe('No fan sensors');
    expect(unsupportedReason(info as never, 'fans')).toBeNull();
    expect(unsupportedReason(null, 'x')).toBeNull();
  });
});
