import { useCallback, useEffect, useState } from 'react';
import type { Campaign, MapAsset, Scene } from '@legendforge/contracts';
import { ApiError, api, fieldMessages } from '../api/client';
import { uploadMap, type UploadProgress } from '../scene/uploadMap';
import { PartyPanel } from './PartyPanel';

interface CampaignScreenProps {
  campaign: Campaign;
  onBack: () => void;
  onOpenScene: (scene: Scene) => void;
}

export function CampaignScreen({ campaign: initial, onBack, onOpenScene }: CampaignScreenProps) {
  // La campagna arriva come proprietà ma le regole si cambiano da qui: la
  // copia locale è quella che comanda finché si sta su questa schermata.
  const [campaign, setCampaign] = useState<Campaign>(initial);
  const [scenes, setScenes] = useState<Scene[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const isGameMaster = campaign.viewerRole === 'game_master';

  const load = useCallback(async () => {
    setError(null);
    try {
      setScenes(await api.listScenes(campaign.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Impossibile caricare le scene');
    }
  }, [campaign.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="screen">
      <div className="screen__head">
        <div>
          <button type="button" className="gate__link screen__back" onClick={onBack}>
            ← Tutte le campagne
          </button>
          <h1>{campaign.name}</h1>
          <p className="screen__lead">
            {isGameMaster ? 'Game Master' : 'Giocatore'} · {campaign.playerSlots} posti giocatore ·
            una casella vale {campaign.ruleSet.grid.defaultMetersPerCell} metri
          </p>
        </div>
        {isGameMaster && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Nuova scena
          </button>
        )}
      </div>

      {error && <p className="gate__error">{error}</p>}
      {scenes === null && <p className="panel__hint">Caricamento…</p>}

      {scenes?.length === 0 && (
        <div className="empty">
          <p>
            Nessuna scena.
            {isGameMaster
              ? ' Creane una caricando una mappa: la griglia viene cercata da sola.'
              : ' Il Game Master non ne ha ancora preparate.'}
          </p>
        </div>
      )}

      {scenes && scenes.length > 0 && (
        <ul className="campaign-list">
          {scenes.map((scene) => (
            <li key={scene.id}>
              <button type="button" className="campaign" onClick={() => onOpenScene(scene)}>
                <span className="campaign__name">{scene.name}</span>
                <span className="campaign__meta">
                  griglia {gridLabel(scene)} · {scene.tokenCount} pedine ·{' '}
                  {scene.grid.cellSizePx.toFixed(0)} px per casella
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {isGameMaster && (
        <section className="panel">
          <header className="panel__header">
            <h2>Regole del tavolo</h2>
            <span className="badge">valgono per tutta la campagna</span>
          </header>
          <label className="switch">
            <input
              type="checkbox"
              checked={campaign.ruleSet.movement.gameMasterMovesPlayerTokens}
              disabled={savingRules}
              onChange={(event) => {
                const value = event.target.checked;
                setSavingRules(true);
                setError(null);
                api
                  .updateRules(campaign.id, {
                    version: campaign.version,
                    ruleSet: { movement: { gameMasterMovesPlayerTokens: value } },
                  })
                  .then(setCampaign)
                  .catch((caught: unknown) =>
                    setError(
                      caught instanceof ApiError ? caught.message : 'Regola non salvata',
                    ),
                  )
                  .finally(() => setSavingRules(false));
              }}
            />
            <span>Posso spostare le pedine dei giocatori</span>
          </label>
          <p className="panel__hint">
            {campaign.ruleSet.movement.gameMasterMovesPlayerTokens
              ? 'Puoi trascinare qualsiasi pedina, anche quelle assegnate ai giocatori.'
              : 'Le pedine assegnate le muovono solo i loro proprietari. A te restano tutte le ' +
                'altre facoltà: nasconderle, rinominarle, eliminarle. Quando serve davvero — un ' +
                'dominio, una possessione — puoi prendere il controllo di una singola pedina ' +
                'dalla scena.'}
          </p>
        </section>
      )}

      {isGameMaster && (
        <PartyPanel
          campaignId={campaign.id}
          playerSlots={campaign.playerSlots}
          joinCode={campaign.joinCode}
        />
      )}

      {creating && (
        <NewSceneDialog
          campaignId={campaign.id}
          onCancel={() => setCreating(false)}
          onCreated={(scene) => {
            setCreating(false);
            setScenes((current) => [scene, ...(current ?? [])]);
            onOpenScene(scene);
          }}
        />
      )}
    </div>
  );
}

function gridLabel(scene: Scene): string {
  switch (scene.grid.status) {
    case 'confirmed':
      return 'confermata';
    case 'suggested':
      return 'proposta';
    default:
      return 'da configurare';
  }
}

interface NewSceneDialogProps {
  campaignId: string;
  onCancel: () => void;
  onCreated: (scene: Scene) => void;
}

function NewSceneDialog({ campaignId, onCancel, onCreated }: NewSceneDialogProps) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [existingMaps, setExistingMaps] = useState<MapAsset[]>([]);
  const [chosenMapId, setChosenMapId] = useState<string>('');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listMaps(campaignId)
      .then(setExistingMaps)
      .catch(() => undefined);
  }, [campaignId]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let mapAssetId = chosenMapId || null;
      if (file) {
        const map = await uploadMap(campaignId, file, name.trim() || file.name, setProgress);
        mapAssetId = map.id;
        if (map.detection) {
          setProgress({
            step: 'registrazione',
            message:
              map.detection.cellSizePx === null
                ? 'Griglia non riconosciuta: la calibrerai a mano.'
                : `Griglia proposta: ${map.detection.cellSizePx.toFixed(1)} px per casella, confidenza ${Math.round(map.detection.confidence * 100)}%.`,
          });
        }
      }
      const scene = await api.createScene(campaignId, {
        name: name.trim() || 'Nuova scena',
        mapAssetId,
        applyDetection: true,
      });
      onCreated(scene);
    } catch (caught) {
      const extra = fieldMessages(caught);
      setError(
        caught instanceof ApiError
          ? [caught.message, ...extra].join(' · ')
          : caught instanceof Error
            ? caught.message
            : 'Creazione non riuscita',
      );
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Nuova scena">
      <form
        className="modal__card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Nuova scena</h2>

        <label className="field">
          <span className="field__label">Nome della scena</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
        </label>

        <label className="field">
          <span className="field__label">Mappa: carica un file PNG o JPEG</span>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              if (picked) setChosenMapId('');
              if (picked && !name) setName(picked.name.replace(/\.[^.]+$/u, ''));
            }}
          />
        </label>

        {existingMaps.length > 0 && !file && (
          <label className="field">
            <span className="field__label">Oppure riusa una mappa già caricata</span>
            <select value={chosenMapId} onChange={(e) => setChosenMapId(e.target.value)}>
              <option value="">Nessuna mappa</option>
              {existingMaps.map((map) => (
                <option key={map.id} value={map.id}>
                  {map.name} · {map.widthPx}×{map.heightPx}
                </option>
              ))}
            </select>
          </label>
        )}

        {progress && <p className="panel__hint">{progress.message}</p>}
        {error && <p className="gate__error">{error}</p>}

        <div className="modal__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Annulla
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Un momento…' : 'Crea la scena'}
          </button>
        </div>
      </form>
    </div>
  );
}
