import { useEffect, useState } from 'react';
import { AlarmBanner } from './components/AlarmBanner.js';
import { Calibration } from './components/Calibration.js';
import { Cards } from './components/Cards.js';
import { Chart } from './components/Chart.js';
import { EventsList } from './components/EventsList.js';
import { NetworkCard } from './components/NetworkCard.js';
import { PumpPanel } from './components/PumpPanel.js';
import { SettingsForm } from './components/SettingsForm.js';
import { TokenBar } from './components/TokenBar.js';
import { loadToken, saveToken } from './lib/api.js';
import { fmtAgo } from './lib/format.js';
import { useLive, useTick } from './lib/live.js';

type Tab = 'dashboard' | 'settings' | 'calibrate';
const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'settings', label: 'Settings' },
  { id: 'calibrate', label: 'Calibrate' },
];

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '');
  return h === 'settings' || h === 'calibrate' ? h : 'dashboard';
}

const LINK_LABEL = {
  connecting: 'Connecting…',
  live: 'Live',
  polling: 'Polling every 10 s',
  offline: 'Offline',
} as const;

export function App() {
  const live = useLive();
  useTick(5000);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [token, setTokenState] = useState<string>(loadToken);
  const [tokenStored, setTokenStored] = useState<boolean>(true);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (t: Tab) => {
    window.location.hash = t === 'dashboard' ? '' : t;
    setTab(t);
  };

  const onSaveToken = (t: string) => {
    setTokenState(t);
    setTokenStored(saveToken(t));
  };

  const lastOk = live.lastOkMs === null ? null : Math.floor((Date.now() - live.lastOkMs) / 1000);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Greenhouse</h1>
          <span className={`link link-${live.mode}`} role="status" aria-live="polite">
            {LINK_LABEL[live.mode]}
            {lastOk !== null && live.mode !== 'live' ? ` · last ok ${fmtAgo(lastOk)}` : ''}
          </span>
        </div>
        <nav aria-label="Sections" className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="tab"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => go(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <AlarmBanner />

      <main className="content">
        <TokenBar token={token} stored={tokenStored} onSave={onSaveToken} />

        {tab === 'dashboard' && (
          <>
            <Cards />
            <Chart />
            <div className="grid-2">
              <PumpPanel token={token} />
              <EventsList />
            </div>
            <NetworkCard />
          </>
        )}
        {tab === 'settings' && <SettingsForm token={token} />}
        {tab === 'calibrate' && <Calibration token={token} />}
      </main>

    </div>
  );
}
