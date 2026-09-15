import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import { createSession } from '../../src/identity/store.js';
import { SESSION_COOKIE } from '../../src/identity/cookies.js';

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness.close();
});

async function owner() {
  const response = await harness.app.handle(
    request('POST', '/api/setup', { body: { displayName: 'Simone', pin: 'forgia-2026' } }),
  );
  return sessionCookieFrom(response);
}

/** Crea un secondo utente con sessione valida, senza passare dall'API. */
async function otherUser() {
  const { rows } = await harness.pool.query<{ id: string }>(
    `INSERT INTO users (display_name) VALUES ('Estraneo') RETURNING id`,
  );
  const userId = rows[0]?.id;
  if (!userId) throw new Error('utente non creato');
  const token = await createSession(harness.pool, userId, 'vitest');
  return `${SESSION_COOKIE}=${token}`;
}

describe('campagne', () => {
  it('richiede una sessione', async () => {
    const response = await harness.app.handle(request('GET', '/api/campaigns'));
    expect(response.status).toBe(401);
  });

  it('chi crea la campagna ne diventa Game Master', async () => {
    const cookie = await owner();
    const created = await harness.app.handle(
      request('POST', '/api/campaigns', {
        cookie,
        body: { name: 'La Cripta', description: 'prova', playerSlots: 5 },
      }),
    );
    expect(created.status).toBe(201);
    const campaign = created.body as { id: string; viewerRole: string; playerSlots: number; ruleSet: { grid: { defaultMetersPerCell: number } } };
    expect(campaign.viewerRole).toBe('game_master');
    expect(campaign.playerSlots).toBe(5);
    expect(campaign.ruleSet.grid.defaultMetersPerCell).toBe(1.5);

    const { rows } = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM campaign_memberships
        WHERE campaign_id = $1 AND role = 'game_master'`,
      [campaign.id],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('rifiuta un numero di posti fuori dall intervallo consentito', async () => {
    const cookie = await owner();
    for (const playerSlots of [0, 9, 100]) {
      const response = await harness.app.handle(
        request('POST', '/api/campaigns', { cookie, body: { name: 'X', playerSlots } }),
      );
      expect(response.status).toBe(400);
    }
  });

  it('elenca solo le campagne di cui si è membri', async () => {
    const cookie = await owner();
    await harness.app.handle(
      request('POST', '/api/campaigns', { cookie, body: { name: 'Mia', playerSlots: 3 } }),
    );

    const mine = await harness.app.handle(request('GET', '/api/campaigns', { cookie }));
    expect((mine.body as unknown[]).length).toBe(1);

    const stranger = await otherUser();
    const theirs = await harness.app.handle(request('GET', '/api/campaigns', { cookie: stranger }));
    expect(theirs.body).toEqual([]);
  });

  it('a un estraneo la campagna risulta inesistente, non vietata', async () => {
    const cookie = await owner();
    const created = await harness.app.handle(
      request('POST', '/api/campaigns', { cookie, body: { name: 'Segreta', playerSlots: 2 } }),
    );
    const { id } = created.body as { id: string };

    const stranger = await otherUser();
    const response = await harness.app.handle(
      request('GET', `/api/campaigns/${id}`, { cookie: stranger }),
    );
    // 404 e non 403: chi non è membro non deve poter scoprire che esiste.
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('Segreta');
  });

  it('conta le scene della campagna', async () => {
    const cookie = await owner();
    const created = await harness.app.handle(
      request('POST', '/api/campaigns', { cookie, body: { name: 'Con scene', playerSlots: 4 } }),
    );
    const { id } = created.body as { id: string };
    await harness.pool.query(`INSERT INTO scenes (campaign_id, name) VALUES ($1, 'Ingresso')`, [id]);

    const fetched = await harness.app.handle(request('GET', `/api/campaigns/${id}`, { cookie }));
    expect((fetched.body as { sceneCount: number }).sceneCount).toBe(1);
  });
});

describe('schema del database', () => {
  it('impedisce due Game Master nella stessa campagna', async () => {
    const cookie = await owner();
    const created = await harness.app.handle(
      request('POST', '/api/campaigns', { cookie, body: { name: 'Unica', playerSlots: 4 } }),
    );
    const { id } = created.body as { id: string };
    const stranger = await harness.pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('Secondo') RETURNING id`,
    );

    await expect(
      harness.pool.query(
        `INSERT INTO campaign_memberships (campaign_id, user_id, role)
         VALUES ($1, $2, 'game_master')`,
        [id, stranger.rows[0]?.id],
      ),
    ).rejects.toThrow();
  });

  it('impedisce posti giocatore fuori intervallo anche a livello di tabella', async () => {
    const cookie = await owner();
    const created = await harness.app.handle(
      request('POST', '/api/campaigns', { cookie, body: { name: 'Vincoli', playerSlots: 4 } }),
    );
    const { id } = created.body as { id: string };
    await expect(
      harness.pool.query('UPDATE campaigns SET player_slots = 12 WHERE id = $1', [id]),
    ).rejects.toThrow();
  });
});
