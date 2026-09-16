import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import type {
  Actor,
  CampaignMember,
  CreatedInvite,
  Invite,
  InvitePreview,
  Scene,
  SceneDetail,
  Token,
} from '@legendforge/contracts';

let harness: TestHarness;
let gm = '';
let campaignId = '';

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const setup = await harness.app.handle(
    request('POST', '/api/setup', { body: { displayName: 'Simone', pin: 'forgia-2026' } }),
  );
  gm = sessionCookieFrom(setup);
  const campaign = await harness.app.handle(
    request('POST', '/api/campaigns', { cookie: gm, body: { name: 'Prova', playerSlots: 2 } }),
  );
  campaignId = (campaign.body as { id: string }).id;
});

async function newInvite(body: Record<string, unknown> = {}): Promise<CreatedInvite> {
  const response = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/invites`, { cookie: gm, body }),
  );
  expect(response.status).toBe(201);
  return response.body as CreatedInvite;
}

async function join(token: string, displayName: string, pin = 'giocatore-2026') {
  return harness.app.handle(
    request('POST', `/api/invites/${token}/accept`, { body: { displayName, pin } }),
  );
}

describe('inviti', () => {
  it('restituiscono il segreto una sola volta', async () => {
    const invite = await newInvite({ label: 'Tavolo del venerdì' });
    expect(invite.token.length).toBeGreaterThan(30);
    expect(invite.joinPath).toBe(`/entra/${invite.token}`);
    // Senza un dominio configurato resta il percorso relativo; con PUBLIC_APP_ORIGIN
    // il server compone l'indirizzo completo (verificato sotto).
    expect(invite.joinUrl).toBeNull();

    const list = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/invites`, { cookie: gm }),
    );
    const listed = list.body as Invite[];
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(invite.token);
  });

  it('nel database non c è il token in chiaro', async () => {
    const invite = await newInvite();
    const { rows } = await harness.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM invites',
    );
    expect(rows[0]?.token_hash).toBeTruthy();
    expect(rows[0]?.token_hash).not.toBe(invite.token);
  });

  it('l anteprima dice dove si sta entrando senza rivelare i partecipanti', async () => {
    const invite = await newInvite();
    const preview = await harness.app.handle(
      request('GET', `/api/invites/${invite.token}/preview`),
    );
    const body = preview.body as InvitePreview;
    expect(body).toMatchObject({ valid: true, reason: 'ok', campaignName: 'Prova', seatsLeft: 2 });
    expect(JSON.stringify(body)).not.toContain('Simone');
  });

  it('un token inventato non rivela nulla', async () => {
    const preview = await harness.app.handle(request('GET', '/api/invites/inventato/preview'));
    expect(preview.body).toMatchObject({ valid: false, reason: 'not_found', campaignName: null });
  });

  it('fanno entrare il giocatore con nome e PIN scelti da lui', async () => {
    const invite = await newInvite();
    const response = await join(invite.token, 'Aria');
    expect(response.status).toBe(201);

    const cookie = sessionCookieFrom(response);
    const campaigns = await harness.app.handle(request('GET', '/api/campaigns', { cookie }));
    const list = campaigns.body as { viewerRole: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.viewerRole).toBe('player');
  });

  it('il giocatore rientra con nome e PIN', async () => {
    const invite = await newInvite();
    await join(invite.token, 'Aria', 'aria-segreta');
    const login = await harness.app.handle(
      request('POST', '/api/session', { body: { displayName: 'Aria', pin: 'aria-segreta' } }),
    );
    expect(login.status).toBe(200);
  });

  it('un nome già preso viene rifiutato con un messaggio chiaro', async () => {
    const invite = await newInvite({ maxUses: 2 });
    await join(invite.token, 'Aria');
    const second = await join(invite.token, 'aria');
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'name_taken' } });
  });

  it('un invito revocato smette di funzionare immediatamente', async () => {
    const invite = await newInvite({ maxUses: 5 });
    await harness.app.handle(request('DELETE', `/api/invites/${invite.id}`, { cookie: gm }));

    const preview = await harness.app.handle(
      request('GET', `/api/invites/${invite.token}/preview`),
    );
    expect(preview.body).toMatchObject({ valid: false, reason: 'revoked' });
    expect((await join(invite.token, 'Tardivo')).status).toBe(404);
  });

  it('si esaurisce dopo il numero di usi previsto', async () => {
    const invite = await newInvite({ maxUses: 1 });
    expect((await join(invite.token, 'Aria')).status).toBe(201);
    expect((await join(invite.token, 'Bork')).status).toBe(404);
  });

  it('non fa entrare oltre i posti della campagna', async () => {
    const invite = await newInvite({ maxUses: 8 });
    expect((await join(invite.token, 'Aria')).status).toBe(201);
    expect((await join(invite.token, 'Bork')).status).toBe(201);
    const third = await join(invite.token, 'Cleo');
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ error: { code: 'campaign_full' } });
  });

  it('un invito scaduto non vale', async () => {
    const invite = await newInvite({ maxUses: 3 });
    await harness.pool.query(`UPDATE invites SET expires_at = now() - interval '1 hour'`);
    expect((await join(invite.token, 'Tardivo')).status).toBe(404);
  });

  it('solo il Game Master può crearli o revocarli', async () => {
    const invite = await newInvite({ maxUses: 3 });
    const player = sessionCookieFrom(await join(invite.token, 'Aria'));
    expect(
      (
        await harness.app.handle(
          request('POST', `/api/campaigns/${campaignId}/invites`, { cookie: player, body: {} }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await harness.app.handle(request('DELETE', `/api/invites/${invite.id}`, { cookie: player })))
        .status,
    ).toBe(403);
  });
});

describe('indirizzo dell invito', () => {
  it('usa il dominio stabile quando il servizio lo conosce', async () => {
    const { createApp } = await import('../../src/app.js');
    const { TEST_ENV } = await import('./helpers.js');
    const app = createApp(
      { ...TEST_ENV, publicAppOrigin: 'https://legendforge.example' },
      harness.pool,
    );
    const created = await app.handle(
      request('POST', `/api/campaigns/${campaignId}/invites`, { cookie: gm, body: {} }),
    );
    const invite = created.body as CreatedInvite;
    expect(invite.joinUrl).toBe(`https://legendforge.example/entra/${invite.token}`);
  });
});

describe('personaggi assegnati', () => {
  async function setupPlayer() {
    const invite = await newInvite({ maxUses: 2 });
    const joined = await join(invite.token, 'Aria');
    const cookie = sessionCookieFrom(joined);
    const members = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/members`, { cookie: gm }),
    );
    const player = (members.body as CampaignMember[]).find((m) => m.displayName === 'Aria');
    return { cookie, userId: player?.userId ?? '' };
  }

  async function createActor(name: string): Promise<Actor> {
    const response = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/actors`, { cookie: gm, body: { name } }),
    );
    expect(response.status).toBe(201);
    return response.body as Actor;
  }

  async function createScene(): Promise<Scene> {
    const response = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/scenes`, { cookie: gm, body: { name: 'Sala' } }),
    );
    return response.body as Scene;
  }

  it('il Game Master assegna un personaggio a un giocatore', async () => {
    const { userId } = await setupPlayer();
    const actor = await createActor('Aria di Vetro');
    const assigned = await harness.app.handle(
      request('PUT', `/api/actors/${actor.id}/owners`, { cookie: gm, body: { userIds: [userId] } }),
    );
    expect(assigned.status).toBe(200);
    expect((assigned.body as Actor).ownerUserIds).toEqual([userId]);
  });

  it('non si può assegnare a chi non è nella campagna', async () => {
    const actor = await createActor('Senza padrone');
    const outsider = await harness.pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('Estraneo') RETURNING id`,
    );
    const response = await harness.app.handle(
      request('PUT', `/api/actors/${actor.id}/owners`, {
        cookie: gm,
        body: { userIds: [outsider.rows[0]?.id] },
      }),
    );
    expect(response.status).toBe(400);
  });

  it('il giocatore muove la propria pedina e non quelle altrui', async () => {
    const { cookie, userId } = await setupPlayer();
    const mine = await createActor('Aria');
    await harness.app.handle(
      request('PUT', `/api/actors/${mine.id}/owners`, { cookie: gm, body: { userIds: [userId] } }),
    );
    const scene = await createScene();

    const ownToken = (
      await harness.app.handle(
        request('POST', `/api/scenes/${scene.id}/tokens`, {
          cookie: gm,
          body: { name: 'Aria', x: 10, y: 10, actorId: mine.id, snapToGrid: false },
        }),
      )
    ).body as Token;
    const otherToken = (
      await harness.app.handle(
        request('POST', `/api/scenes/${scene.id}/tokens`, {
          cookie: gm,
          body: { name: 'Guardia', x: 200, y: 200, snapToGrid: false },
        }),
      )
    ).body as Token;

    const moved = await harness.app.handle(
      request('PATCH', `/api/tokens/${ownToken.id}`, {
        cookie,
        body: { version: ownToken.version, x: 300, y: 300, snapToGrid: false },
      }),
    );
    expect(moved.status).toBe(200);
    expect((moved.body as Token).x).toBe(300);

    const forbidden = await harness.app.handle(
      request('PATCH', `/api/tokens/${otherToken.id}`, {
        cookie,
        body: { version: otherToken.version, x: 999, y: 999, snapToGrid: false },
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  it('il giocatore può spostare ma non modificare le proprietà', async () => {
    const { cookie, userId } = await setupPlayer();
    const mine = await createActor('Aria');
    await harness.app.handle(
      request('PUT', `/api/actors/${mine.id}/owners`, { cookie: gm, body: { userIds: [userId] } }),
    );
    const scene = await createScene();
    const token = (
      await harness.app.handle(
        request('POST', `/api/scenes/${scene.id}/tokens`, {
          cookie: gm,
          body: { name: 'Aria', x: 10, y: 10, actorId: mine.id },
        }),
      )
    ).body as Token;

    for (const body of [{ name: 'Rinominata' }, { hidden: true }, { sizeInCells: 4 }]) {
      const response = await harness.app.handle(
        request('PATCH', `/api/tokens/${token.id}`, {
          cookie,
          body: { version: token.version, ...body },
        }),
      );
      expect(response.status).toBe(403);
    }
  });

  it('la scena dice al giocatore quali pedine può muovere', async () => {
    const { cookie, userId } = await setupPlayer();
    const mine = await createActor('Aria');
    await harness.app.handle(
      request('PUT', `/api/actors/${mine.id}/owners`, { cookie: gm, body: { userIds: [userId] } }),
    );
    const scene = await createScene();
    const ownToken = (
      await harness.app.handle(
        request('POST', `/api/scenes/${scene.id}/tokens`, {
          cookie: gm,
          body: { name: 'Aria', x: 10, y: 10, actorId: mine.id },
        }),
      )
    ).body as Token;
    await harness.app.handle(
      request('POST', `/api/scenes/${scene.id}/tokens`, {
        cookie: gm,
        body: { name: 'Guardia', x: 200, y: 200 },
      }),
    );

    const detail = await harness.app.handle(request('GET', `/api/scenes/${scene.id}`, { cookie }));
    const body = detail.body as SceneDetail;
    expect(body.viewerRole).toBe('player');
    expect(body.controllableTokenIds).toEqual([ownToken.id]);
  });

  it('un giocatore non vede il bestiario del Game Master', async () => {
    const { cookie } = await setupPlayer();
    await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/actors`, {
        cookie: gm,
        body: { name: 'Drago', kind: 'monster' },
      }),
    );
    await createActor('Aria');
    const list = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}/actors`, { cookie }),
    );
    const names = (list.body as Actor[]).map((a) => a.name);
    expect(names).toEqual(['Aria']);
    expect(JSON.stringify(list.body)).not.toContain('Drago');
  });
});
