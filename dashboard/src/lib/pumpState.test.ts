import { describe, expect, it } from 'vitest';
import { commandResult, pumpGate } from './pumpState.js';

const base = { canWrite: true, maxRunKnown: true, inflight: null, commandType: null, commandState: null } as const;

describe('pumpGate', () => {
  it('disables both without a token', () => {
    expect(pumpGate({ ...base, canWrite: false })).toEqual({ onDisabled: true, offDisabled: true });
  });

  it('keeps OFF enabled while an ON is in flight or pending', () => {
    expect(pumpGate({ ...base, inflight: 'on' }).offDisabled).toBe(false);
    expect(pumpGate({ ...base, commandType: 'pump_on', commandState: 'pending' }).offDisabled).toBe(false);
  });

  it('grays ON while any request is busy or an OFF is pending', () => {
    expect(pumpGate({ ...base, inflight: 'off' }).onDisabled).toBe(true);
    expect(pumpGate({ ...base, inflight: 'on' }).onDisabled).toBe(true);
    expect(pumpGate({ ...base, commandType: 'pump_off', commandState: 'sent' }).onDisabled).toBe(true);
  });

  it('grays OFF only for its own in-flight request', () => {
    expect(pumpGate({ ...base, inflight: 'off' }).offDisabled).toBe(true);
  });

  it('enables ON when idle with a token and known max run', () => {
    expect(pumpGate(base)).toEqual({ onDisabled: false, offDisabled: false });
    expect(pumpGate({ ...base, maxRunKnown: false }).onDisabled).toBe(true);
  });

  it('ignores settled commands', () => {
    expect(pumpGate({ ...base, commandType: 'pump_on', commandState: 'acked' }).onDisabled).toBe(false);
  });
});

describe('commandResult', () => {
  it('maps acked to pump state', () => {
    expect(commandResult('acked', null, 'on')).toEqual({ tone: 'ok', text: 'Pump is ON.' });
  });

  it('shows last_error on failure', () => {
    expect(commandResult('failed', 'refused: sensor stale', 'off').text).toBe('Failed: refused: sensor stale');
  });

  it('reports expired and pending', () => {
    expect(commandResult('expired', null).tone).toBe('error');
    expect(commandResult('pending', null)).toEqual({ tone: 'pending', text: 'Pending…' });
  });
});
