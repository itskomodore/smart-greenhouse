import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export type AddressKind = 'link-local' | 'ula' | 'global' | 'ipv4';

export interface NetAddress {
  address: string;
  kind: AddressKind;
  /** `coap://[addr]:port` (IPv6) or `coap://addr:port` (IPv4): what a sensor node should target. */
  coap_url: string;
}

export interface NetworkInfo {
  coap_port: number;
  /** Name of the Thread (OpenThread border router) interface, e.g. wpan0. */
  thread_iface: string;
  /** False when the interface is absent (development machine, OTBR not running). */
  thread_iface_present: boolean;
  /** Addresses on the Thread interface. Sensors can only reach the Pi on these. */
  thread: NetAddress[];
  /** Non-internal IPv4 addresses on other interfaces (LAN). */
  lan: NetAddress[];
}

type Ifaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function isIpv6(i: NetworkInterfaceInfo): boolean {
  return i.family === 'IPv6' || (i.family as unknown) === 6;
}

function isIpv4(i: NetworkInterfaceInfo): boolean {
  return i.family === 'IPv4' || (i.family as unknown) === 4;
}

export function classify(address: string, v6: boolean): AddressKind {
  if (!v6) return 'ipv4';
  const a = address.toLowerCase();
  if (a.startsWith('fe80:')) return 'link-local';
  // fc00::/7 unique-local: Thread mesh-local (fd..) and OMR prefixes live here.
  if (a.startsWith('fc') || a.startsWith('fd')) return 'ula';
  return 'global';
}

function entry(address: string, v6: boolean, port: number): NetAddress {
  return { address, kind: classify(address, v6), coap_url: v6 ? `coap://[${address}]:${port}` : `coap://${address}:${port}` };
}

// Order shown first: addresses a sensor can actually use beat link-local.
const RANK: Record<AddressKind, number> = { ula: 0, global: 1, ipv4: 2, 'link-local': 3 };

/** Pure for tests: pass os.networkInterfaces()-shaped data. */
export function buildNetworkInfo(ifaces: Ifaces, coapPort: number, threadIface: string): NetworkInfo {
  const thread: NetAddress[] = [];
  const lan: NetAddress[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      if (name === threadIface) {
        if (isIpv6(i)) thread.push(entry(i.address.split('%')[0] ?? i.address, true, coapPort));
      } else if (isIpv4(i)) {
        lan.push(entry(i.address, false, coapPort));
      }
    }
  }
  thread.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return {
    coap_port: coapPort,
    thread_iface: threadIface,
    thread_iface_present: Object.prototype.hasOwnProperty.call(ifaces, threadIface),
    thread,
    lan,
  };
}

export function getNetworkInfo(coapPort: number, threadIface: string): NetworkInfo {
  return buildNetworkInfo(networkInterfaces(), coapPort, threadIface);
}
