import { useCallback, useEffect, useState } from 'react';
import type { Health } from '@legendforge/contracts';
import { ApiError, fetchHealth } from '../api/client';

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; health: Health }
  | { phase: 'error'; message: string };

export function StatusPanel() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'ready', health: await fetchHealth() });
    } catch (error) {
      setState({
        phase: 'error',
        message:
          error instanceof ApiError
            ? `${error.message} (${error.code})`
            : 'Impossibile contattare il server',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Stato del servizio</h2>
        <button type="button" className="panel__action" onClick={() => void load()}>
          Ricontrolla
        </button>
      </header>

      {state.phase === 'loading' && <p className="panel__hint">Verifica in corso…</p>}

      {state.phase === 'error' && (
        <p className="panel__hint panel__hint--bad">
          {state.message}
          <br />
          In sviluppo locale le funzioni non girano con <code>vite</code> da solo.
        </p>
      )}

      {state.phase === 'ready' && <HealthView health={state.health} />}
    </section>
  );
}

function HealthView({ health }: { health: Health }) {
  const db = health.database;
  return (
    <dl className="kv">
      <Row label="API" value={health.status === 'ok' ? 'attiva' : 'degradata'} tone={health.status === 'ok' ? 'good' : 'warn'} />
      <Row label="Schema" value={`v${health.apiSchemaVersion}`} />
      <Row label="Build" value={health.build ?? 'locale'} />
      <Row label="Region" value={health.region ?? '—'} />
      <Row
        label="Database"
        value={
          !db.configured
            ? 'non configurato'
            : db.reachable
              ? `raggiungibile · ${db.latencyMs} ms`
              : 'non raggiungibile'
        }
        tone={db.reachable ? 'good' : db.configured ? 'bad' : 'warn'}
      />
      {db.serverVersion && <Row label="Versione" value={db.serverVersion} />}
      <Row
        label="Migrazioni"
        value={db.migrationsApplied === null ? 'nessuna ancora applicata' : String(db.migrationsApplied)}
        tone={db.migrationsApplied === null ? 'warn' : 'good'}
      />
      {db.error && <Row label="Errore" value={db.error} tone="bad" />}
      <Row label="Ora del server" value={new Date(health.serverTime).toLocaleTimeString('it-IT')} />
    </dl>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={tone ? `kv__value kv__value--${tone}` : 'kv__value'}>{value}</dd>
    </>
  );
}
