import { useCallback, useEffect, useState } from 'react';
import type { Health } from '@legendforge/contracts';
import { ApiError, api } from '../api/client';

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; health: Health }
  | { phase: 'error'; message: string };

export function StatusPanel() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'ready', health: await api.health() });
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
      {state.phase === 'error' && <p className="panel__hint panel__hint--bad">{state.message}</p>}
      {state.phase === 'ready' && <HealthView health={state.health} />}
    </section>
  );
}

function HealthView({ health }: { health: Health }) {
  const db = health.database;
  const migrations = health.migrations;
  return (
    <dl className="kv">
      <Row
        label="API"
        value={health.status === 'ok' ? 'attiva' : 'degradata'}
        tone={health.status === 'ok' ? 'good' : 'warn'}
      />
      <Row label="Schema API" value={`v${health.apiSchemaVersion}`} />
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
        value={
          migrations.ok
            ? `${db.migrationsApplied ?? 0} su ${migrations.expected} applicate`
            : 'non applicate'
        }
        tone={migrations.ok ? 'good' : 'bad'}
      />
      <Row
        label="Storage"
        value={
          !health.storage.configured
            ? 'non configurato'
            : health.storage.ready
              ? `bucket ${health.storage.bucket}${health.storage.createdNow ? ' · creato ora' : ''}`
              : 'non pronto'
        }
        tone={health.storage.ready ? 'good' : health.storage.configured ? 'bad' : 'warn'}
      />
      {health.storage.publicBucket === true && (
        <Row label="Attenzione" value="il bucket è pubblico: le mappe sono leggibili da chiunque" tone="bad" />
      )}
      {health.storage.error && <Row label="Errore storage" value={health.storage.error} tone="bad" />}
      {migrations.appliedNow.length > 0 && (
        <Row label="Appena applicate" value={migrations.appliedNow.join(', ')} tone="good" />
      )}
      {migrations.error && <Row label="Errore schema" value={migrations.error} tone="bad" />}
      {db.error && <Row label="Errore database" value={db.error} tone="bad" />}
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
