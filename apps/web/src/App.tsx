import { useCallback, useEffect, useState } from 'react';
import type { Campaign, Scene, SessionState, Viewer } from '@legendforge/contracts';
import { ApiError, api } from './api/client';
import { AuthScreen } from './auth/AuthScreen';
import { CampaignsScreen } from './campaigns/CampaignsScreen';
import { CampaignScreen } from './campaigns/CampaignScreen';
import { SceneView } from './scene/SceneView';
import { StatusPanel } from './panels/StatusPanel';

type Boot =
  | { phase: 'loading' }
  | { phase: 'ready'; state: SessionState }
  | { phase: 'error'; message: string };

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
        <span className="badge">Milestone 1 · in costruzione</span>
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
          <SceneView
            sceneId={scene.id}
            canEdit={campaign.viewerRole === 'game_master'}
            onBack={() => setScene(null)}
          />
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
