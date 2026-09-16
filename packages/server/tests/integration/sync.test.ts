import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';
import type { CreatedInvite, Scene, SceneDetail, SceneEvents, Token } from '@legendforge/contracts';

let harness: TestHarness;
let gm = '';
let campaignId = '';
let scene: Scene;

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
  campaignId = (
    (
      await harness.app.handle(
        request('POST', '/api/campaigns', { cookie: gm, body: { name: 'Prova', playerSlots: 3 } }),
      )
    ).body as { id: string }
  ).id;
  scene = (
    await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/scenes`, { cookie: gm, body: { name: 'Sala' } }),
    )
  ).body as Scene;
});

async function playerCookie(name = 'Aria'): Promise<string> {
  const invite = (
    await harness.app.handle(
      request('POST', `/api/campaigns/${campaignId}/invites`, { cookie: gm, body: { maxUses: 3 } }),
    )
  ).body as CreatedInvite;
  const joined = await harness.app.handle(
    request('POST', `/api/invites/${invite.token}/accept`, {
      body: { displayName: name, pin: 'giocatore-2026' },
    }),
  );
  return sessionCookieFrom(joined);
}

/** Legge gli eventi senza attendere. */
async function events(cookie: string, since: number): Promise<SceneEvents> {
  const response = await harness.app.handle({
    ...request('GET', `/api/scenes/${scene.id}/events`, { cookie }),
    query: { since: String(since), wait: '0' },
  });
  expect(response.status).toBe(200);
  return response.body as SceneEvents;
}

async function addToken(body: Record<string, unknown>): Promise<Token> {
  const response = await harness.app.handle(
    request('POST', `/api/scenes/${scene.id}/tokens`, { cookie: gm, body }),
  );
  expect(response.status).toBe(201);
  return response.body as Token;
}

describe('sincronizzazione', () => {
  it('la scena indica da quale punto seguire gli aggiornamenti', async () => {
    const detail = await harness.app.handle(request('GET', `/api/scenes/${scene.id}`, { cookie: gm }));
    expect((detail.body as SceneDetail).eventCursor).toBe(0);
  });

  it('creare una pedina produce un evento per tutti', async () => {
    const player = await playerCookie();
    const token = await addToken({ name: 'Aria', x: 10, y: 10 });
    const seen = await events(player, 0);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.kind).toBe('token.upserted');
    expect((seen.events[0]?.payload as Token).id).toBe(token.id);
    expect(seen.cursor).toBeGreaterThan(0);
  });

  it('spostare una pedina produce un evento con la posizione decisa dal server', async () => {
    const player = await playerCookie();
    const token = await addToken({ name: 'Aria', x: 10, y: 10, snapToGrid: false });
    const before = await events(player, 0);

    const moved = (
      await harness.app.handle(
        request('PATCH', `/api/tokens/${token.id}`, {
          cookie: gm,
          body: { version: token.version, x: 500, y: 500, snapToGrid: false },
        }),
      )
    ).body as Token;

    const after = await events(player, before.cursor);
    expect(after.events).toHaveLength(1);
    expect((after.events[0]?.payload as Token).x).toBe(moved.x);
  });

  it('una pedina nascosta arriva ai giocatori come sparita e al Game Master intera', async () => {
    const player = await playerCookie();
    const token = await addToken({ name: 'Agguato', x: 10, y: 10, hidden: true });

    const playerEvents = await events(player, 0);
    expect(playerEvents.events.map((e) => e.kind)).toEqual(['token.removed']);
    expect(JSON.stringify(playerEvents)).not.toContain('Agguato');

    const gmEvents = await events(gm, 0);
    expect(gmEvents.events.map((e) => e.kind)).toEqual(['token.removed', 'token.upserted']);
    expect((gmEvents.events[1]?.payload as Token).id).toBe(token.id);
  });

  it('svelare una pedina la fa comparire ai giocatori', async () => {
    const player = await playerCookie();
    const token = await addToken({ name: 'Agguato', x: 10, y: 10, hidden: true });
    const afterHidden = await events(player, 0);

    await harness.app.handle(
      request('PATCH', `/api/tokens/${token.id}`, {
        cookie: gm,
        body: { version: token.version, hidden: false },
      }),
    );

    const revealed = await events(player, afterHidden.cursor);
    expect(revealed.events.map((e) => e.kind)).toEqual(['token.upserted']);
    expect((revealed.events[0]?.payload as Token).name).toBe('Agguato');
  });

  it('cancellare una pedina produce un evento di rimozione', async () => {
    const player = await playerCookie();
    const token = await addToken({ name: 'Usa e getta', x: 0, y: 0 });
    const before = await events(player, 0);
    await harness.app.handle(request('DELETE', `/api/tokens/${token.id}`, { cookie: gm }));
    const after = await events(player, before.cursor);
    expect(after.events.map((e) => e.kind)).toEqual(['token.removed']);
  });

  it('calibrare la griglia arriva a tutti', async () => {
    const player = await playerCookie();
    await harness.app.handle(
      request('PATCH', `/api/scenes/${scene.id}/grid`, {
        cookie: gm,
        body: { version: scene.grid.version, cellSizePx: 96 },
      }),
    );
    const seen = await events(player, 0);
    expect(seen.events.map((e) => e.kind)).toEqual(['grid.updated']);
    expect((seen.events[0]?.payload as { cellSizePx: number }).cellSizePx).toBe(96);
  });

  it('chiedere da un punto già superato non restituisce nulla', async () => {
    const player = await playerCookie();
    await addToken({ name: 'Aria', x: 0, y: 0 });
    const first = await events(player, 0);
    const second = await events(player, first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor).toBe(first.cursor);
  });

  it('un estraneo non può seguire la scena', async () => {
    const response = await harness.app.handle({
      ...request('GET', `/api/scenes/${scene.id}/events`),
      query: { since: '0', wait: '0' },
    });
    expect(response.status).toBe(401);
  });

  it('l attesa lunga torna subito se c è già qualcosa da consegnare', async () => {
    const player = await playerCookie();
    await addToken({ name: 'Aria', x: 0, y: 0 });
    const started = Date.now();
    const response = await harness.app.handle({
      ...request('GET', `/api/scenes/${scene.id}/events`, { cookie: player }),
      query: { since: '0' },
    });
    expect((response.body as SceneEvents).events.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
