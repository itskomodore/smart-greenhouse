import { describe, expect, it } from 'vitest';
import { buildNetworkInfo, classify } from './network.js';

const v6 = (address: string, internal = false) => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6' as const,
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/64`,
  scopeid: 0,
});
const v4 = (address: string, internal = false) => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

describe('network info', () => {
  it('classifies address kinds', () => {
    expect(classify('fe80::1', true)).toBe('link-local');
    expect(classify('fd12:3456:789a:1::1', true)).toBe('ula');
    expect(classify('2001:db8::1', true)).toBe('global');
    expect(classify('192.168.1.5', false)).toBe('ipv4');
  });

  it('lists thread addresses (usable first) and LAN IPv4, skips loopback', () => {
    const info = buildNetworkInfo(
      {
        lo: [v4('127.0.0.1', true), v6('::1', true)],
        eth0: [v4('192.168.1.50'), v6('fe80::aaaa')],
        wpan0: [v6('fe80::1'), v6('fd11:22:0:0:0:ff:fe00:fc00'), v6('fd11:22::1')],
      },
      5683,
      'wpan0',
    );
    expect(info.thread_iface_present).toBe(true);
    expect(info.thread.map((a) => a.kind)).toEqual(['ula', 'ula', 'link-local']);
    expect(info.thread[0]?.coap_url).toBe('coap://[fd11:22:0:0:0:ff:fe00:fc00]:5683');
    expect(info.lan).toEqual([{ address: '192.168.1.50', kind: 'ipv4', coap_url: 'coap://192.168.1.50:5683' }]);
  });

  it('reports a missing thread interface without throwing', () => {
    const info = buildNetworkInfo({ en0: [v4('10.0.0.2')] }, 5683, 'wpan0');
    expect(info.thread_iface_present).toBe(false);
    expect(info.thread).toEqual([]);
  });

  it('strips a zone id from addresses', () => {
    const info = buildNetworkInfo({ wpan0: [v6('fe80::1%wpan0')] }, 5683, 'wpan0');
    expect(info.thread[0]?.address).toBe('fe80::1');
  });
});
