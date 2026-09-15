import { useCallback, useEffect, useState } from 'react';
import type { Campaign } from '@legendforge/contracts';
import { ApiError, api, fieldMessages } from '../api/client';

interface CampaignsScreenProps {
  onOpen: (campaign: Campaign) => void;
}

export function CampaignsScreen({ onOpen }: CampaignsScreenProps) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCampaigns(await api.listCampaigns());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Impossibile caricare le campagne');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="screen">
      <div className="screen__head">
        <div>
          <h1>Campagne</h1>
          <p className="screen__lead">
            Chi crea una campagna ne diventa Game Master. I posti giocatore si decidono adesso e
            valgono per gli inviti.
          </p>
        </div>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          Nuova campagna
        </button>
      </div>

      {error && <p className="gate__error">{error}</p>}

      {campaigns === null && <p className="panel__hint">Caricamento…</p>}

      {campaigns?.length === 0 && (
        <div className="empty">
          <p>Nessuna campagna. Creane una per cominciare.</p>
        </div>
      )}

      {campaigns && campaigns.length > 0 && (
        <ul className="campaign-list">
          {campaigns.map((campaign) => (
            <li key={campaign.id}>
              <button type="button" className="campaign" onClick={() => onOpen(campaign)}>
                <span className="campaign__name">{campaign.name}</span>
                {campaign.description && (
                  <span className="campaign__description">{campaign.description}</span>
                )}
                <span className="campaign__meta">
                  {campaign.viewerRole === 'game_master' ? 'Game Master' : 'Giocatore'} ·{' '}
                  {campaign.playerSlots} posti · {campaign.sceneCount} scene ·{' '}
                  {campaign.ruleSet.grid.defaultMetersPerCell} m per casella
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateCampaignDialog
          onCancel={() => setCreating(false)}
          onCreated={(campaign) => {
            setCreating(false);
            setCampaigns((current) => [campaign, ...(current ?? [])]);
          }}
        />
      )}
    </div>
  );
}

function CreateCampaignDialog({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [playerSlots, setPlayerSlots] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Nuova campagna">
      <form
        className="modal__card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          api
            .createCampaign({ name: name.trim(), description: description.trim(), playerSlots })
            .then(onCreated)
            .catch((caught: unknown) => {
              const extra = fieldMessages(caught);
              setError(
                caught instanceof ApiError
                  ? [caught.message, ...extra].join(' · ')
                  : 'Creazione fallita',
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        <h2>Nuova campagna</h2>

        <label className="field">
          <span className="field__label">Nome</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={120} />
        </label>

        <label className="field">
          <span className="field__label">Descrizione (facoltativa)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={3}
          />
        </label>

        <label className="field">
          <span className="field__label">
            Posti giocatore <output>{playerSlots}</output>
          </span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={playerSlots}
            onChange={(e) => setPlayerSlots(Number(e.target.value))}
          />
        </label>

        {error && <p className="gate__error">{error}</p>}

        <div className="modal__actions">
          <button type="button" onClick={onCancel}>
            Annulla
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creazione…' : 'Crea'}
          </button>
        </div>
      </form>
    </div>
  );
}
