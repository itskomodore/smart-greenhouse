import { useState } from 'react';
import type { NetAddress } from '../types.js';
import { useLive } from '../lib/live.js';

const KIND_LABEL: Record<NetAddress['kind'], string> = {
  ula: 'Thread / OMR',
  global: 'global',
  'link-local': 'link-local (not routable)',
  ipv4: 'LAN',
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API needs a secure context; plain http on a LAN IP lacks it. Fall back.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function Row({ a }: { a: NetAddress }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const onCopy = async () => {
    setCopied((await copyText(a.address)) ? 'ok' : 'fail');
    window.setTimeout(() => setCopied('idle'), 1500);
  };
  return (
    <li className="net-row">
      <span className="net-kind">{KIND_LABEL[a.kind]}</span>
      <code className="net-addr" title={a.coap_url}>
        {a.address}
      </code>
      <button type="button" className="net-copy" onClick={onCopy} aria-label={`Copy ${a.address}`}>
        {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Select & copy' : 'Copy'}
      </button>
    </li>
  );
}

export function NetworkCard() {
  const { status } = useLive();
  const net = status?.network;
  if (!net) return null;
  return (
    <section className="card network-card" aria-label="Network addresses">
      <h2>Sensor target</h2>
      <p className="muted">
        Point the sensor node at one of these on UDP port <strong>{net.coap_port}</strong> (<code>POST /sensor</code>).
      </p>
      {net.error ? (
        <p className="muted">Could not read network interfaces: {net.error}</p>
      ) : net.thread_iface_present ? (
        <ul className="net-list">
          {net.thread.map((a) => (
            <Row key={a.address} a={a} />
          ))}
        </ul>
      ) : (
        <p className="muted">
          Thread interface <code>{net.thread_iface}</code> not found on this machine. Is the OpenThread border router
          running?
        </p>
      )}
      {net.lan.length > 0 && (
        <>
          <h3>LAN</h3>
          <ul className="net-list">
            {net.lan.map((a) => (
              <Row key={a.address} a={a} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
