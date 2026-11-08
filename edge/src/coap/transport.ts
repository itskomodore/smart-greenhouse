import { pathToFileURL } from 'node:url';
import type { Server } from 'coap';

/** UDP family for a bind host: IPv6 literal (contains ':') → udp6, else udp4. */
export function udpTypeFor(host: string): 'udp4' | 'udp6' {
  return host.includes(':') ? 'udp6' : 'udp4';
}

/**
 * Strip the IPv4-mapped prefix that a dual-stack `::` socket reports for IPv4 peers
 * (`::ffff:192.0.2.7` → `192.0.2.7`), so node ids stay stable across bind modes.
 */
export function normalizeSourceAddress(addr: string): string {
  return addr.toLowerCase().startsWith('::ffff:') && addr.includes('.') ? addr.slice(7) : addr;
}

/** Bind a coap server; resolves once the socket is listening, rejects on bind errors. */
export function listenCoap(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

export function closeCoap(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // coap's close callback receives an error only if the socket was never bound; ignore it.
    server.close(() => resolve());
  });
}

/** True when this module is the process entry point (lets a file export and run). */
export function isEntryPoint(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && importMetaUrl === pathToFileURL(entry).href;
}
