import { useEffect, useState } from 'react';
import type { InvitePreview, Viewer } from '@legendforge/contracts';
import { ApiError, api, fieldMessages } from '../api/client';

interface JoinScreenProps {
  token: string;
  onJoined: (viewer: Viewer) => void;
}

const REASONS: Record<InvitePreview['reason'], string> = {
  ok: '',
  not_found: 'Questo link non corrisponde a nessun invito.',
  revoked: 'Questo invito è stato revocato dal Game Master.',
  expired: 'Questo invito è scaduto.',
  exhausted: 'Questo invito è già stato usato.',
  full: 'La campagna ha esaurito i posti disponibili.',
};

export function JoinScreen({ token, onJoined }: JoinScreenProps) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .previewInvite(token)
      .then(setPreview)
      .catch(() =>
        setPreview({ valid: false, reason: 'not_found', campaignName: null, seatsLeft: null }),
      );
  }, [token]);

  if (!preview) {
    return (
      <div className="gate">
        <p className="panel__hint">Verifica dell&apos;invito…</p>
      </div>
    );
  }

  if (!preview.valid) {
    return (
      <div className="gate">
        <div className="gate__card">
          <h1>Invito non utilizzabile</h1>
          <p className="gate__lead">{REASONS[preview.reason]}</p>
          <p className="panel__hint">Chiedi al Game Master di generarne uno nuovo.</p>
          <button type="button" className="gate__link" onClick={() => (window.location.href = '/')}>
            Vai alla pagina di accesso
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      <form
        className="gate__card"
        onSubmit={(event) => {
          event.preventDefault();
          if (pin !== confirm) {
            setError('I due PIN non coincidono');
            return;
          }
          setBusy(true);
          setError(null);
          api
            .acceptInvite(token, { displayName: displayName.trim(), pin })
            .then((result) => {
              window.history.replaceState(null, '', '/');
              onJoined(result.viewer);
            })
            .catch((caught: unknown) => {
              const extra = fieldMessages(caught);
              setError(
                caught instanceof ApiError
                  ? [caught.message, ...extra].join(' · ')
                  : 'Ingresso non riuscito',
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">LegendForge</span>
        </div>

        <h1>Entra in «{preview.campaignName}»</h1>
        <p className="gate__lead">
          {preview.seatsLeft === 1
            ? 'Resta un posto.'
            : `Restano ${preview.seatsLeft} posti.`}{' '}
          Scegli il nome con cui ti vedranno gli altri e un PIN per rientrare.
        </p>

        <label className="field">
          <span className="field__label">Il tuo nome al tavolo</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            autoFocus
            maxLength={80}
            autoComplete="nickname"
          />
        </label>

        <label className="field">
          <span className="field__label">PIN (almeno 6 caratteri)</span>
          <input
            type="password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            minLength={6}
            required
            autoComplete="new-password"
          />
        </label>

        <label className="field">
          <span className="field__label">Ripeti il PIN</span>
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
            autoComplete="new-password"
          />
        </label>

        {error && <p className="gate__error">{error}</p>}

        <button type="submit" className="gate__submit" disabled={busy}>
          {busy ? 'Un momento…' : 'Entra nella campagna'}
        </button>
        <p className="panel__hint">
          Il nome e il PIN servono a rientrare: segnateli. Non c&apos;è una email per recuperarli.
        </p>
      </form>
    </div>
  );
}
