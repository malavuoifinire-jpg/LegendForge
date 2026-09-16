import { useCallback, useEffect, useState } from 'react';
import type { Campaign, Scene, SessionState, Viewer } from '@legendforge/contracts';
import { ApiError, api } from './api/client';
import { AuthScreen } from './auth/AuthScreen';
import { JoinScreen } from './auth/JoinScreen';
import { CampaignsScreen } from './campaigns/CampaignsScreen';
import { CampaignScreen } from './campaigns/CampaignScreen';
import { SceneView } from './scene/SceneView';
import { StatusPanel } from './panels/StatusPanel';

type Boot =
  | { phase: 'loading' }
  | { phase: 'ready'; state: SessionState }
  | { phase: 'error'; message: string };

function InviteForExistingAccount({
  token,
  viewer,
  onDone,
  onSwitchAccount,
}: {
  token: string;
  viewer: Viewer;
  onDone: () => void;
  onSwitchAccount: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="gate">
      <div className="gate__card">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">LegendForge</span>
        </div>
        <h1>Invito a una campagna</h1>
        <p className="gate__lead">
          In questo browser sei già entrato come <strong>{viewer.displayName}</strong>. Vuoi unirti
          alla campagna con questo account?
        </p>
        {error && <p className="gate__error">{error}</p>}
        <button
          type="button"
          className="gate__submit"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            api
              .joinWithInvite(token)
              .then(onDone)
              .catch((caught: unknown) => {
                setError(caught instanceof ApiError ? caught.message : 'Ingresso non riuscito');
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Un momento…' : `Entra come ${viewer.displayName}`}
        </button>
        <button type="button" className="gate__link" onClick={onSwitchAccount}>
          Esci e usa un altro account
        </button>
      </div>
    </div>
  );
}

/** Estrae il token da un indirizzo del tipo /entra/&lt;token&gt;. */
function readInviteToken(): string | null {
  const match = /^\/entra\/([^/]+)\/?$/u.exec(window.location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const load = useCallback(async () => {
    setBoot({ phase: 'loading' });
    try {
      const state = await api.sessionState();
      setViewer(state.viewer);
      setBoot({ phase: 'ready', state });
    } catch (caught) {
      setBoot({
        phase: 'error',
        message:
          caught instanceof ApiError ? caught.message : 'Impossibile contattare il server',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setViewer(null);
    setCampaign(null);
    setScene(null);
    await load();
  }, [load]);

  if (boot.phase === 'loading') {
    return <div className="gate"><p className="panel__hint">Avvio…</p></div>;
  }

  if (boot.phase === 'error') {
    return (
      <div className="gate">
        <div className="gate__card">
          <h1>Servizio non raggiungibile</h1>
          <p className="gate__lead">{boot.message}</p>
          <StatusPanel />
          <button type="button" className="gate__submit" onClick={() => void load()}>
            Riprova
          </button>
        </div>
      </div>
    );
  }

  const inviteToken = readInviteToken();
  if (inviteToken && !viewer) {
    return <JoinScreen token={inviteToken} onJoined={(next) => setViewer(next)} />;
  }
  // Chi ha già un account non deve crearne un altro per accettare un invito.
  if (inviteToken && viewer) {
    return (
      <InviteForExistingAccount
        token={inviteToken}
        viewer={viewer}
        onDone={() => {
          window.history.replaceState(null, '', '/');
          void load();
        }}
        onSwitchAccount={() => void logout()}
      />
    );
  }

  if (!viewer) {
    return <AuthScreen state={boot.state} onAuthenticated={(next) => setViewer(next)} />;
  }

  return (
    <div className="app">
      <header className="app__bar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">LegendForge</span>
        </div>
        <span className="badge">Milestone 3 · in costruzione</span>
        <div className="app__bar-spacer" />
        <button
          type="button"
          className="panel__action"
          onClick={() => setDiagnosticsOpen((open) => !open)}
        >
          {diagnosticsOpen ? 'Nascondi stato' : 'Stato del servizio'}
        </button>
        <span className="readout">{viewer.displayName}</span>
        <button type="button" className="panel__action" onClick={() => void logout()}>
          Esci
        </button>
      </header>

      {diagnosticsOpen && (
        <div className="app__diagnostics">
          <StatusPanel />
        </div>
      )}

      <main className="app__main">
        {scene && campaign ? (
          <SceneView sceneId={scene.id} campaignId={campaign.id} onBack={() => setScene(null)} />
        ) : campaign ? (
          <CampaignScreen
            campaign={campaign}
            onBack={() => setCampaign(null)}
            onOpenScene={setScene}
          />
        ) : (
          <CampaignsScreen onOpen={setCampaign} />
        )}
      </main>
    </div>
  );
}
