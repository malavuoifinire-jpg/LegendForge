import type { Campaign } from '@legendforge/contracts';
import { TablePreview } from '../scene/TablePreview';

interface CampaignScreenProps {
  campaign: Campaign;
  onBack: () => void;
}

export function CampaignScreen({ campaign, onBack }: CampaignScreenProps) {
  return (
    <div className="campaign-screen">
      <div className="campaign-screen__head">
        <button type="button" className="gate__link" onClick={onBack}>
          ← Tutte le campagne
        </button>
        <h1>{campaign.name}</h1>
        <span className="badge">
          {campaign.viewerRole === 'game_master' ? 'Game Master' : 'Giocatore'} ·{' '}
          {campaign.playerSlots} posti
        </span>
      </div>

      <section className="panel panel--muted campaign-screen__scenes">
        <h2>Scene</h2>
        <p>
          Nessuna scena: il caricamento delle mappe e la creazione delle scene sono il prossimo
          passo della Milestone 1. Sotto trovi l&apos;anteprima del renderer, che non è collegata a
          questa campagna.
        </p>
      </section>

      <TablePreview />
    </div>
  );
}
