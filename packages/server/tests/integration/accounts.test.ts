import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import type { Campaign, CreatedInvite } from '@legendforge/contracts';

let harness: TestHarness;
let gm = '';
let campaign: Campaign;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  await harness.pool.query('TRUNCATE rate_limits');
  const setup = await harness.app.handle(
    request('POST', '/api/setup', { body: { displayName: 'Simone', pin: 'forgia-2026' } }),
  );
  gm = sessionCookieFrom(setup);
  campaign = (
    await harness.app.handle(
      request('POST', '/api/campaigns', { cookie: gm, body: { name: 'Prova', playerSlots: 2 } }),
    )
  ).body as Campaign;
});

async function register(displayName: string, pin = 'giocatore-2026') {
  return harness.app.handle(request('POST', '/api/register', { body: { displayName, pin } }));
}

describe('creazione di un account', () => {
  it('chiunque può crearsi un account, che da solo non apre niente', async () => {
    const response = await register('Aria');
    expect(response.status).toBe(201);
    const cookie = sessionCookieFrom(response);

    const campaigns = await harness.app.handle(request('GET', '/api/campaigns', { cookie }));
    expect(campaigns.body).toEqual([]);
  });

  it('il nome deve essere libero', async () => {
    await register('Aria');
    const second = await register('aria');
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'name_taken' } });
  });

  it('rifiuta PIN banali', async () => {
    expect((await register('Debole', '123456')).status).toBe(400);
  });

  it('si rientra con nome e PIN', async () => {
    await register('Aria', 'aria-segreta');
    const login = await harness.app.handle(
      request('POST', '/api/session', { body: { displayName: 'Aria', pin: 'aria-segreta' } }),
    );
    expect(login.status).toBe(200);
  });

  it('limita quanti account si creano dalla stessa provenienza', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 7; i += 1) {
      const response = await harness.app.handle({
        ...request('POST', '/api/register', { body: { displayName: `Utente${i}`, pin: 'un-pin-lungo' } }),
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('si può chiudere la creazione di nuovi account', async () => {
    await harness.pool.query('UPDATE instance_state SET open_registration = false');
    const response = await register('Tardivo');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'registration_closed' } });

    const state = await harness.app.handle(request('GET', '/api/session'));
    expect(state.body).toMatchObject({ openRegistration: false });
  });
});

describe('codice della campagna', () => {
  it('viene assegnato alla creazione e lo vede solo il Game Master', async () => {
    expect(campaign.joinCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);

    const cookie = sessionCookieFrom(await register('Aria'));
    await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
    );
    const list = await harness.app.handle(request('GET', '/api/campaigns', { cookie }));
    const seen = (list.body as Campaign[])[0];
    expect(seen?.viewerRole).toBe('player');
    expect(seen?.joinCode).toBeNull();
  });

  it('fa entrare chi ha un account', async () => {
    const cookie = sessionCookieFrom(await register('Aria'));
    const joined = await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
    );
    expect(joined.status).toBe(201);
    expect((joined.body as Campaign).viewerRole).toBe('player');
  });

  it('accetta il codice scritto male: minuscole, spazi, senza trattino', async () => {
    const cookie = sessionCookieFrom(await register('Aria'));
    const sloppy = campaign.joinCode!.replace('-', '').toLowerCase();
    const joined = await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: ` ${sloppy} ` } }),
    );
    expect(joined.status).toBe(201);
  });

  it('entrare due volte non è un errore né consuma un posto', async () => {
    const cookie = sessionCookieFrom(await register('Aria'));
    await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
    );
    const again = await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
    );
    expect(again.status).toBe(200);
    const { rows } = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM campaign_memberships WHERE campaign_id = $1`,
      [campaign.id],
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('un codice sbagliato non dice nulla di utile', async () => {
    const cookie = sessionCookieFrom(await register('Aria'));
    const response = await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: 'AAAA-BBBB' } }),
    );
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('Prova');
  });

  it('limita i tentativi a indovinare', async () => {
    const cookie = sessionCookieFrom(await register('Aria'));
    let lastStatus = 0;
    for (let i = 0; i < 12; i += 1) {
      const response = await harness.app.handle(
        request('POST', '/api/campaigns/join', { cookie, body: { code: `AAAA-BB${i}X` } }),
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('rispetta i posti della campagna', async () => {
    for (const name of ['Aria', 'Bork']) {
      const cookie = sessionCookieFrom(await register(name));
      const joined = await harness.app.handle(
        request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
      );
      expect(joined.status).toBe(201);
    }
    const cookie = sessionCookieFrom(await register('Cleo'));
    const third = await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
    );
    expect(third.status).toBe(409);
  });

  it('rigenerandolo il precedente smette di funzionare', async () => {
    const rotated = await harness.app.handle(
      request('POST', `/api/campaigns/${campaign.id}/join-code`, { cookie: gm }),
    );
    const next = (rotated.body as { joinCode: string }).joinCode;
    expect(next).not.toBe(campaign.joinCode);

    const cookie = sessionCookieFrom(await register('Aria'));
    expect(
      (
        await harness.app.handle(
          request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await harness.app.handle(
          request('POST', '/api/campaigns/join', { cookie, body: { code: next } }),
        )
      ).status,
    ).toBe(201);
  });

  it('solo il Game Master può rigenerarlo', async () => {
    const cookie = sessionCookieFrom(await register('Aria'));
    await harness.app.handle(
      request('POST', '/api/campaigns/join', { cookie, body: { code: campaign.joinCode } }),
    );
    const response = await harness.app.handle(
      request('POST', `/api/campaigns/${campaign.id}/join-code`, { cookie }),
    );
    expect(response.status).toBe(403);
  });
});

describe('invito per chi ha già un account', () => {
  it('lo fa entrare senza creare un secondo account', async () => {
    const invite = (
      await harness.app.handle(
        request('POST', `/api/campaigns/${campaign.id}/invites`, { cookie: gm, body: {} }),
      )
    ).body as CreatedInvite;
    const cookie = sessionCookieFrom(await register('Aria'));

    const joined = await harness.app.handle(
      request('POST', `/api/invites/${invite.token}/join`, { cookie }),
    );
    expect(joined.status).toBe(200);

    const { rows } = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM users`,
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('non fa entrare due volte', async () => {
    const invite = (
      await harness.app.handle(
        request('POST', `/api/campaigns/${campaign.id}/invites`, { cookie: gm, body: { maxUses: 4 } }),
      )
    ).body as CreatedInvite;
    const cookie = sessionCookieFrom(await register('Aria'));
    await harness.app.handle(request('POST', `/api/invites/${invite.token}/join`, { cookie }));
    const again = await harness.app.handle(
      request('POST', `/api/invites/${invite.token}/join`, { cookie }),
    );
    expect(again.status).toBe(409);
  });
});
