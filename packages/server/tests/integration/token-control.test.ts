import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import { createSession } from '../../src/identity/store.js';
import { SESSION_COOKIE } from '../../src/identity/cookies.js';
import type { Campaign, SceneDetail, Token } from '@legendforge/contracts';

/**
 * Chi muove che cosa.
 *
 * Due regole che si incastrano: una della campagna, che dice se il Game Master
 * mette le mani sulle pedine dei giocatori, e una della singola pedina, per
 * quando il controllo passa davvero di mano — un dominio, una possessione.
 * La seconda vince sulla prima, perché è il caso per cui esiste.
 */

let harness: TestHarness;
let gmCookie = '';
let campaignId = '';
let sceneId = '';

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
  gmCookie = sessionCookieFrom(setup);
  const campaign = await harness.app.handle(
    request('POST', '/api/campaigns', { cookie: gmCookie, body: { name: 'Prova', playerSlots: 4 } }),
  );
  campaignId = (campaign.body as Campaign).id;
  const scene = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/scenes`, {
      cookie: gmCookie,
      body: { name: 'Sala' },
    }),
  );
  sceneId = (scene.body as { id: string }).id;
});

async function addPlayer(name = 'Marco'): Promise<{ cookie: string; userId: string }> {
  const user = await harness.pool.query<{ id: string }>(
    `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
    [name],
  );
  const userId = user.rows[0]!.id;
  await harness.pool.query(
    `INSERT INTO campaign_memberships (campaign_id, user_id, role) VALUES ($1, $2, 'player')`,
    [campaignId, userId],
  );
  return { cookie: `${SESSION_COOKIE}=${await createSession(harness.pool, userId, 'vitest')}`, userId };
}

/** Personaggio assegnato a una persona, con la sua pedina sulla scena. */
async function addCharacter(ownerId: string, name = 'Kaelith'): Promise<Token> {
  const actor = await harness.app.handle(
    request('POST', `/api/campaigns/${campaignId}/actors`, {
      cookie: gmCookie,
      body: { kind: 'character', name },
    }),
  );
  const actorId = (actor.body as { id: string }).id;
  await harness.app.handle(
    request('PUT', `/api/actors/${actorId}/owners`, {
      cookie: gmCookie,
      body: { userIds: [ownerId] },
    }),
  );
  const token = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/tokens`, {
      cookie: gmCookie,
      body: { name, actorId, x: 100, y: 100, snapToGrid: false },
    }),
  );
  expect(token.status).toBe(201);
  return token.body as Token;
}

async function addMonster(): Promise<Token> {
  const response = await harness.app.handle(
    request('POST', `/api/scenes/${sceneId}/tokens`, {
      cookie: gmCookie,
      body: { name: 'Ghoul', x: 300, y: 300, snapToGrid: false },
    }),
  );
  return response.body as Token;
}

async function setRule(value: boolean): Promise<void> {
  const campaign = await harness.app.handle(
    request('GET', `/api/campaigns/${campaignId}`, { cookie: gmCookie }),
  );
  const response = await harness.app.handle(
    request('PATCH', `/api/campaigns/${campaignId}/rules`, {
      cookie: gmCookie,
      body: {
        version: (campaign.body as Campaign).version,
        ruleSet: { movement: { gameMasterMovesPlayerTokens: value } },
      },
    }),
  );
  expect(response.status).toBe(200);
  expect((response.body as Campaign).ruleSet.movement.gameMasterMovesPlayerTokens).toBe(value);
}

function move(tokenId: string, version: number, cookie: string) {
  return harness.app.handle(
    request('PATCH', `/api/tokens/${tokenId}`, {
      cookie,
      body: { version, x: 250, y: 250, snapToGrid: false },
    }),
  );
}

describe('la regola della campagna', () => {
  it('di base il Game Master muove le pedine dei giocatori', async () => {
    const campaign = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}`, { cookie: gmCookie }),
    );
    expect((campaign.body as Campaign).ruleSet.movement.gameMasterMovesPlayerTokens).toBe(true);

    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    expect((await move(eroe.id, eroe.version, gmCookie)).status).toBe(200);
  });

  it('spenta, quella pedina la muove solo chi la possiede', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    await setRule(false);

    const rifiutato = await move(eroe.id, eroe.version, gmCookie);
    expect(rifiutato.status).toBe(403);
    expect((rifiutato.body as { error: { code: string } }).error.code).toBe(
      'token_movement_reserved',
    );

    // Il proprietario invece la muove come sempre.
    expect((await move(eroe.id, eroe.version, player.cookie)).status).toBe(200);
  });

  it('spenta, al Game Master restano tutte le altre facolta', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    await setRule(false);

    const nascosta = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: eroe.version, hidden: true, name: 'Kaelith il Dannato' },
      }),
    );
    expect(nascosta.status).toBe(200);
    expect((nascosta.body as Token).hidden).toBe(true);
    expect((nascosta.body as Token).name).toBe('Kaelith il Dannato');

    expect(
      (await harness.app.handle(request('DELETE', `/api/tokens/${eroe.id}`, { cookie: gmCookie })))
        .status,
    ).toBe(200);
  });

  it('spenta, i mostri restano comunque suoi', async () => {
    await addPlayer();
    await setRule(false);
    const ghoul = await addMonster();
    expect((await move(ghoul.id, ghoul.version, gmCookie)).status).toBe(200);
  });

  it('spenta, una pedina non assegnata a nessuno resta sua', async () => {
    await setRule(false);
    // Personaggio senza proprietario: nessuno se ne e preso carico.
    const actor = await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/actors`, {
        cookie: gmCookie,
        body: { kind: 'character', name: 'Png di scorta' },
      }),
    );
    const token = await harness.app.handle(
      request('POST', `/api/scenes/${sceneId}/tokens`, {
        cookie: gmCookie,
        body: {
          name: 'Png di scorta',
          actorId: (actor.body as { id: string }).id,
          x: 10,
          y: 10,
          snapToGrid: false,
        },
      }),
    );
    const pedina = token.body as Token;
    expect((await move(pedina.id, pedina.version, gmCookie)).status).toBe(200);
  });

  it('spenta, la pedina non compare fra quelle che il Game Master puo trascinare', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    await setRule(false);
    const scene = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}`, { cookie: gmCookie }),
    );
    const detail = scene.body as SceneDetail;
    expect(detail.controllableTokenIds).not.toContain(eroe.id);
    // Al proprietario si.
    const suo = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}`, { cookie: player.cookie }),
    );
    expect((suo.body as SceneDetail).controllableTokenIds).toContain(eroe.id);
  });

  it('solo il Game Master cambia le regole', async () => {
    const player = await addPlayer();
    const campaign = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}`, { cookie: player.cookie }),
    );
    const response = await harness.app.handle(
      request('PATCH', `/api/campaigns/${campaignId}/rules`, {
        cookie: player.cookie,
        body: {
          version: (campaign.body as Campaign).version,
          ruleSet: { movement: { gameMasterMovesPlayerTokens: false } },
        },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('cambiare una casella non azzera il resto delle regole', async () => {
    await setRule(false);
    const campaign = await harness.app.handle(
      request('GET', `/api/campaigns/${campaignId}`, { cookie: gmCookie }),
    );
    const rules = (campaign.body as Campaign).ruleSet;
    expect(rules.grid.defaultMetersPerCell).toBe(1.5);
    expect(rules.vision.defaultDarkvisionMeters).toBe(18);
    expect(rules.movement.diagonalRule).toBe('alternating');
    expect(rules.movement.gameMasterMovesPlayerTokens).toBe(false);
  });
});

describe('quando il controllo passa di mano', () => {
  it('il Game Master prende la pedina e il proprietario la perde', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    await setRule(false);

    const preso = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: eroe.version, controlledByGameMaster: true },
      }),
    );
    expect(preso.status).toBe(200);
    expect((preso.body as Token).controlledByGameMaster).toBe(true);
    const dominato = preso.body as Token;

    // Adesso lo muove lui, anche con la regola della campagna spenta.
    const suo = await move(dominato.id, dominato.version, gmCookie);
    expect(suo.status).toBe(200);

    // E il proprietario no.
    const rifiutato = await move(dominato.id, (suo.body as Token).version, player.cookie);
    expect(rifiutato.status).toBe(403);
    expect((rifiutato.body as { error: { message: string } }).error.message).toContain(
      'controllo del Game Master',
    );
  });

  it('vale anche con la regola della campagna accesa', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    const preso = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: eroe.version, controlledByGameMaster: true },
      }),
    );
    const dominato = preso.body as Token;
    expect((await move(dominato.id, dominato.version, player.cookie)).status).toBe(403);
  });

  it('un giocatore non puo liberarsi da solo', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: eroe.version, controlledByGameMaster: true },
      }),
    );
    const scene = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}`, { cookie: player.cookie }),
    );
    const dominato = (scene.body as SceneDetail).tokens.find((t) => t.id === eroe.id);
    const response = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: player.cookie,
        body: { version: dominato!.version, controlledByGameMaster: false },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('e nemmeno prendersi il controllo di una pedina altrui', async () => {
    const uno = await addPlayer('Uno');
    const due = await addPlayer('Due');
    const altrui = await addCharacter(uno.userId, 'Eroe di Uno');
    const response = await harness.app.handle(
      request('PATCH', `/api/tokens/${altrui.id}`, {
        cookie: due.cookie,
        body: { version: altrui.version, controlledByGameMaster: true },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('restituito il controllo, il proprietario torna a muoverla', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);
    const preso = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: eroe.version, controlledByGameMaster: true },
      }),
    );
    const reso = await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: (preso.body as Token).version, controlledByGameMaster: false },
      }),
    );
    expect(reso.status).toBe(200);
    const libero = reso.body as Token;
    expect((await move(libero.id, libero.version, player.cookie)).status).toBe(200);
  });

  it('chi e dominato continua a vedere', async () => {
    const player = await addPlayer();
    const eroe = await addCharacter(player.userId);

    // Scena al buio con scurovisione: senza occhi lo schermo resterebbe nero.
    await harness.pool.query('UPDATE actors SET darkvision_meters = 18 WHERE name = $1', [
      'Kaelith',
    ]);
    const detail = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}`, { cookie: gmCookie }),
    );
    await harness.app.handle(
      request('PATCH', `/api/scenes/${sceneId}/vision`, {
        cookie: gmCookie,
        body: {
          version: (detail.body as SceneDetail).version,
          visionEnabled: true,
          ambientDarkness: 1,
        },
      }),
    );

    const prima = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/vision`, { cookie: player.cookie }),
    );
    expect((prima.body as { viewpoints: unknown[] }).viewpoints).toHaveLength(1);

    await harness.app.handle(
      request('PATCH', `/api/tokens/${eroe.id}`, {
        cookie: gmCookie,
        body: { version: eroe.version, controlledByGameMaster: true },
      }),
    );

    // Essere dominati non acceca: il punto di vista resta.
    const dopo = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}/vision`, { cookie: player.cookie }),
    );
    expect((dopo.body as { viewpoints: unknown[] }).viewpoints).toHaveLength(1);
    const scena = await harness.app.handle(
      request('GET', `/api/scenes/${sceneId}`, { cookie: player.cookie }),
    );
    expect((scena.body as SceneDetail).tokens.map((t) => t.id)).toContain(eroe.id);
    // Vede la sua pedina ma non puo piu trascinarla.
    expect((scena.body as SceneDetail).controllableTokenIds).not.toContain(eroe.id);
  });
});
