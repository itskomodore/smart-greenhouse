import { useState } from 'react';
import type { FormEvent } from 'react';

interface Props {
  token: string;
  stored: boolean;
  onSave: (token: string) => void;
}

/** Bearer token for write endpoints. Stored in localStorage only; never sent to read endpoints. */
export function TokenBar({ token, stored, onSave }: Props) {
  const [editing, setEditing] = useState(!token);
  const [draft, setDraft] = useState('');

  if (!editing && token) {
    return (
      <div className="card token-bar compact">
        <span>Write token set{stored ? '' : ' (not persisted: storage unavailable)'}.</span>
        <button type="button" className="btn ghost" onClick={() => setEditing(true)}>
          Change
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            onSave('');
            setDraft('');
            setEditing(true);
          }}
        >
          Forget
        </button>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (t.length < 16) return;
    onSave(t);
    setDraft('');
    setEditing(false);
  };

  return (
    <form className="card token-bar" onSubmit={submit}>
      <label htmlFor="token">API token (needed to change settings or control the pump)</label>
      <div className="row">
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Bearer token, min 16 chars"
        />
        <button type="submit" className="btn" disabled={draft.trim().length < 16}>
          Save token
        </button>
      </div>
      {draft.length > 0 && draft.trim().length < 16 && <p className="hint">Token must be at least 16 characters.</p>}
    </form>
  );
}
