import { useCallback, useEffect, useState } from 'react';
import type { Actor, CampaignMember, CreatedInvite, Invite } from '@legendforge/contracts';
import { ApiError, api } from '../api/client';

interface PartyPanelProps {
  campaignId: string;
  playerSlots: number;
}

/**
 * Gestione del tavolo: chi partecipa, quali personaggi controlla, quali link
 * d'invito sono in circolazione.
 */
export function PartyPanel({ campaignId, playerSlots }: PartyPanelProps) {
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [fresh, setFresh] = useState<CreatedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newActorName, setNewActorName] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, i, a] = await Promise.all([
        api.listMembers(campaignId),
        api.listInvites(campaignId),
        api.listActors(campaignId),
      ]);
      setMembers(m);
      setInvites(i);
      setActors(a);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Caricamento non riuscito');
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Operazione non riuscita');
    } finally {
      setBusy(false);
    }
  };

  const players = members.filter((member) => member.role === 'player');
  const activeInvites = invites.filter((invite) => invite.status === 'active');

  return (
    <div className="party">
      <section className="panel">
        <header className="panel__header">
          <h2>Inviti</h2>
          <button
            type="button"
            className="panel__action"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setFresh(await api.createInvite(campaignId, { maxUses: 1, expiresInHours: 72 }));
              })
            }
          >
            Crea link
          </button>
        </header>

        {fresh && (
          <div className="invite-fresh">
            <p className="panel__hint">
              Questo link compare una volta sola: copialo adesso e mandalo alla persona giusta.
              Chi lo apre entra nella campagna.
            </p>
            <code className="invite-link">{inviteUrl(fresh)}</code>
            <div className="wizard__actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteUrl(fresh)).catch(() => undefined);
                }}
              >
                Copia
              </button>
              <button type="button" className="panel__action" onClick={() => setFresh(null)}>
                Ho copiato
              </button>
            </div>
          </div>
        )}

        {invites.length === 0 && <p className="panel__hint">Nessun invito creato.</p>}

        <ul className="plain-list">
          {invites.map((invite) => (
            <li key={invite.id} className="row">
              <span className={`chip chip--${invite.status === 'active' ? 'confirmed' : 'suggested'}`}>
                {inviteLabel(invite)}
              </span>
              <span className="row__main">
                {invite.usedCount} su {invite.maxUses} usi
                {invite.expiresAt
                  ? ` · scade il ${new Date(invite.expiresAt).toLocaleDateString('it-IT')}`
                  : ' · senza scadenza'}
              </span>
              {invite.status === 'active' && (
                <button
                  type="button"
                  className="panel__action panel__action--danger"
                  disabled={busy}
                  onClick={() => void act(() => api.revokeInvite(invite.id).then(() => undefined))}
                >
                  Revoca
                </button>
              )}
            </li>
          ))}
        </ul>

        <p className="panel__hint">
          {players.length} giocatori su {playerSlots} posti · {activeInvites.length} inviti attivi
        </p>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>Personaggi</h2>
        </header>

        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newActorName.trim();
            if (!name) return;
            void act(async () => {
              // Colori distinti per distinguere i personaggi sul tavolo a colpo
              // d'occhio, senza doverli scegliere ogni volta.
              const color = ACTOR_COLORS[actors.length % ACTOR_COLORS.length] ?? '#60a5fa';
              await api.createActor(campaignId, { name, color });
              setNewActorName('');
            });
          }}
        >
          <input
            value={newActorName}
            onChange={(event) => setNewActorName(event.target.value)}
            placeholder="Nome del personaggio"
            maxLength={160}
          />
          <button type="submit" className="panel__action" disabled={busy}>
            Aggiungi
          </button>
        </form>

        {actors.length === 0 && (
          <p className="panel__hint">
            Nessun personaggio. Creane uno e assegnalo a un giocatore: solo allora quella persona
            potrà muovere la sua pedina.
          </p>
        )}

        <ul className="plain-list">
          {actors.map((actor) => (
            <li key={actor.id} className="row row--column">
              <span className="row__main">
                <span className="token__dot" style={{ background: actor.color }} /> {actor.name}
                {actor.kind === 'monster' && <span className="token__flag">mostro</span>}
              </span>
              <div className="owner-picker">
                {players.length === 0 && (
                  <span className="panel__hint">Nessun giocatore ancora nella campagna.</span>
                )}
                {players.map((player) => {
                  const owns = actor.ownerUserIds.includes(player.userId);
                  return (
                    <button
                      key={player.userId}
                      type="button"
                      className={owns ? 'owner owner--on' : 'owner'}
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const next = owns
                            ? actor.ownerUserIds.filter((id) => id !== player.userId)
                            : [...actor.ownerUserIds, player.userId];
                          await api.setActorOwners(actor.id, next);
                        })
                      }
                    >
                      {player.displayName}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>Al tavolo</h2>
        </header>
        <ul className="plain-list">
          {members.map((member) => (
            <li key={member.userId} className="row">
              <span className={`chip chip--${member.role === 'game_master' ? 'confirmed' : ''}`}>
                {member.role === 'game_master' ? 'Game Master' : 'giocatore'}
              </span>
              <span className="row__main">{member.displayName}</span>
              <span className="token__size">
                {member.actorIds.length} {member.actorIds.length === 1 ? 'personaggio' : 'personaggi'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {error && <p className="gate__error">{error}</p>}
    </div>
  );
}

const ACTOR_COLORS = ['#60a5fa', '#4ade80', '#c084fc', '#fbbf24', '#f472b6', '#22d3ee'];

/**
 * Indirizzo dell'invito.
 *
 * Si preferisce sempre quello calcolato dal server, che conosce il dominio
 * stabile: la pagina da cui si genera l'invito può essere l'anteprima di una
 * pubblicazione, e un ospite che apre quel link finisce su una schermata di
 * accesso che non lo riguarda.
 */
function inviteUrl(invite: CreatedInvite): string {
  return invite.joinUrl ?? `${window.location.origin}${invite.joinPath}`;
}

function inviteLabel(invite: Invite): string {
  switch (invite.status) {
    case 'active':
      return 'attivo';
    case 'revoked':
      return 'revocato';
    case 'expired':
      return 'scaduto';
    default:
      return 'esaurito';
  }
}
