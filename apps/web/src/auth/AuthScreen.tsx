import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SessionState, Viewer } from '@legendforge/contracts';
import { ApiError, api, fieldMessages } from '../api/client';

interface AuthScreenProps {
  state: SessionState;
  onAuthenticated: (viewer: Viewer) => void;
}

type Mode = 'setup' | 'login' | 'recover' | 'register';

export function AuthScreen({ state, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>(state.instanceClaimed ? 'login' : 'setup');

  return (
    <div className="gate">
      <div className="gate__card">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">LegendForge</span>
        </div>

        {mode === 'setup' && <SetupForm onDone={onAuthenticated} />}
        {mode === 'login' && (
          <LoginForm
            onDone={onAuthenticated}
            onRecover={() => setMode('recover')}
            onRegister={state.openRegistration ? () => setMode('register') : null}
          />
        )}
        {mode === 'register' && (
          <RegisterForm onDone={onAuthenticated} onCancel={() => setMode('login')} />
        )}
        {mode === 'recover' && (
          <RecoverForm onDone={onAuthenticated} onCancel={() => setMode('login')} />
        )}
      </div>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const extra = fieldMessages(caught);
      setError(
        caught instanceof ApiError
          ? [caught.message, ...extra].join(' · ')
          : 'Impossibile contattare il server',
      );
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run, setError };
}

function SetupForm({ onDone }: { onDone: (viewer: Viewer) => void }) {
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<{ viewer: Viewer; recoveryCode: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const { busy, error, run, setError } = useSubmit();

  if (result) {
    return (
      <>
        <h1>Conserva il codice di recupero</h1>
        <p className="gate__lead">
          È l&apos;unico modo per rientrare se dimentichi il PIN. Viene mostrato adesso e mai più:
          copialo da qualche parte prima di continuare.
        </p>
        <output className="recovery-code">{result.recoveryCode}</output>
        <label className="toggle">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>L&apos;ho copiato in un posto sicuro</span>
        </label>
        <button
          type="button"
          className="gate__submit"
          disabled={!acknowledged}
          onClick={() => onDone(result.viewer)}
        >
          Entra
        </button>
      </>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pin !== confirm) {
          setError('I due PIN non coincidono');
          return;
        }
        void run(async () => {
          const created = await api.setup({ displayName: displayName.trim(), pin });
          setResult(created);
        });
      }}
    >
      <h1>Prima configurazione</h1>
      <p className="gate__lead">
        Questa istanza non ha ancora un proprietario. Chi la configura adesso diventa Game Master e
        l&apos;unico a potervi accedere.
      </p>

      <Field label="Come ti chiami al tavolo">
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={80}
          required
          autoComplete="nickname"
        />
      </Field>

      <Field label="PIN (almeno 6 caratteri)">
        <input
          type="password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          minLength={6}
          required
          autoComplete="new-password"
        />
      </Field>

      <Field label="Ripeti il PIN">
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
          autoComplete="new-password"
        />
      </Field>

      {error && <p className="gate__error">{error}</p>}

      <button type="submit" className="gate__submit" disabled={busy}>
        {busy ? 'Creazione…' : 'Crea il proprietario'}
      </button>
    </form>
  );
}

function LoginForm({
  onDone,
  onRecover,
  onRegister,
}: {
  onDone: (viewer: Viewer) => void;
  onRecover: () => void;
  onRegister: (() => void) | null;
}) {
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const { busy, error, run } = useSubmit();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const { viewer } = await api.login(pin, displayName.trim() || undefined);
          if (viewer) onDone(viewer);
        });
      }}
    >
      <h1>Accesso</h1>
      <p className="gate__lead">Il nome e il PIN che hai scelto al primo ingresso.</p>

      <Field label="Nome">
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          autoFocus
          autoComplete="nickname"
        />
      </Field>

      <Field label="PIN">
        <input
          type="password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          required
          autoComplete="current-password"
        />
      </Field>

      {error && <p className="gate__error">{error}</p>}

      <button type="submit" className="gate__submit" disabled={busy}>
        {busy ? 'Verifica…' : 'Entra'}
      </button>
      {onRegister && (
        <button type="button" className="gate__link" onClick={onRegister}>
          Non hai un account? Creane uno
        </button>
      )}
      <button type="button" className="gate__link" onClick={onRecover}>
        Ho perso il PIN
      </button>
    </form>
  );
}

function RegisterForm({
  onDone,
  onCancel,
}: {
  onDone: (viewer: Viewer) => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, run, setError } = useSubmit();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pin !== confirm) {
          setError('I due PIN non coincidono');
          return;
        }
        void run(async () => {
          const { viewer } = await api.register({ displayName: displayName.trim(), pin });
          onDone(viewer);
        });
      }}
    >
      <h1>Nuovo account</h1>
      <p className="gate__lead">
        Nome e PIN sono le tue credenziali: non c&apos;è una email per recuperarle, quindi
        segnatele. L&apos;account da solo non apre nessuna campagna — per entrare servirà il codice
        che ti dà il Game Master.
      </p>

      <Field label="Il tuo nome al tavolo">
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          autoFocus
          maxLength={80}
          autoComplete="nickname"
        />
      </Field>

      <Field label="PIN (almeno 6 caratteri)">
        <input
          type="password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          minLength={6}
          required
          autoComplete="new-password"
        />
      </Field>

      <Field label="Ripeti il PIN">
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
          autoComplete="new-password"
        />
      </Field>

      {error && <p className="gate__error">{error}</p>}

      <button type="submit" className="gate__submit" disabled={busy}>
        {busy ? 'Creazione…' : 'Crea account'}
      </button>
      <button type="button" className="gate__link" onClick={onCancel}>
        Ho già un account
      </button>
    </form>
  );
}

function RecoverForm({ onDone, onCancel }: { onDone: (viewer: Viewer) => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();

  if (issued) {
    return (
      <>
        <h1>Nuovo codice di recupero</h1>
        <p className="gate__lead">
          Il codice precedente non è più valido e tutte le sessioni aperte sono state chiuse.
          Conserva questo.
        </p>
        <output className="recovery-code">{issued}</output>
        <button
          type="button"
          className="gate__submit"
          onClick={() => void api.sessionState().then((s) => s.viewer && onDone(s.viewer))}
        >
          Continua
        </button>
      </>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const { recoveryCode } = await api.recover(code, newPin);
          setIssued(recoveryCode);
        });
      }}
    >
      <h1>Recupero dell&apos;accesso</h1>
      <p className="gate__lead">
        Inserisci il codice di recupero ricevuto alla prima configurazione e scegli un nuovo PIN.
      </p>

      <Field label="Codice di recupero">
        <input value={code} onChange={(event) => setCode(event.target.value)} required autoFocus />
      </Field>

      <Field label="Nuovo PIN">
        <input
          type="password"
          value={newPin}
          onChange={(event) => setNewPin(event.target.value)}
          minLength={6}
          required
          autoComplete="new-password"
        />
      </Field>

      {error && <p className="gate__error">{error}</p>}

      <button type="submit" className="gate__submit" disabled={busy}>
        {busy ? 'Verifica…' : 'Reimposta il PIN'}
      </button>
      <button type="button" className="gate__link" onClick={onCancel}>
        Torna all&apos;accesso
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}
