import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, request, sessionCookieFrom, type TestHarness } from './helpers.js';

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

async function claimInstance(pin = 'forgia-2026') {
  const response = await harness.app.handle(
    request('POST', '/api/setup', { body: { displayName: 'Simone', pin } }),
  );
  return { response, cookie: sessionCookieFrom(response) };
}

describe('prima configurazione', () => {
  it('parte da un istanza non rivendicata', async () => {
    const response = await harness.app.handle(request('GET', '/api/session'));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ instanceClaimed: false, viewer: null });
  });

  it('crea il proprietario e restituisce il codice di recupero una volta sola', async () => {
    const { response, cookie } = await claimInstance();
    expect(response.status).toBe(201);
    const body = response.body as { viewer: { isOwner: boolean }; recoveryCode: string };
    expect(body.viewer.isOwner).toBe(true);
    expect(body.recoveryCode).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/u);

    const state = await harness.app.handle(request('GET', '/api/session', { cookie }));
    expect(state.body).toMatchObject({ instanceClaimed: true });
    expect(state.body).not.toHaveProperty('recoveryCode');
  });

  it('rifiuta una seconda rivendicazione', async () => {
    await claimInstance();
    const second = await harness.app.handle(
      request('POST', '/api/setup', { body: { displayName: 'Altro', pin: 'un-altro-pin' } }),
    );
    expect(second.status).toBe(409);
  });

  it('rifiuta PIN troppo corti o banali', async () => {
    for (const pin of ['123', '111111', '123456']) {
      const response = await harness.app.handle(
        request('POST', '/api/setup', { body: { displayName: 'X', pin } }),
      );
      expect(response.status).toBe(400);
    }
  });

  it('non conserva il PIN in chiaro', async () => {
    await claimInstance('un-pin-robusto');
    const { rows } = await harness.pool.query<{ pin_hash: string }>('SELECT pin_hash FROM users');
    expect(rows[0]?.pin_hash).toBeTruthy();
    expect(rows[0]?.pin_hash).not.toContain('un-pin-robusto');
    expect(rows[0]?.pin_hash?.startsWith('scrypt$')).toBe(true);
  });
});

describe('accesso con PIN', () => {
  it('accetta il PIN corretto e apre una sessione', async () => {
    await claimInstance('forgia-2026');
    const response = await harness.app.handle(
      request('POST', '/api/session', { body: { pin: 'forgia-2026' } }),
    );
    expect(response.status).toBe(200);
    const cookie = sessionCookieFrom(response);
    const state = await harness.app.handle(request('GET', '/api/session', { cookie }));
    expect((state.body as { viewer: unknown }).viewer).not.toBeNull();
  });

  it('rifiuta il PIN sbagliato senza dire perché', async () => {
    await claimInstance('forgia-2026');
    const response = await harness.app.handle(
      request('POST', '/api/session', { body: { pin: 'sbagliato-del-tutto' } }),
    );
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('forgia');
  });

  it('blocca temporaneamente dopo tentativi ripetuti', async () => {
    await claimInstance('forgia-2026');
    let lastStatus = 0;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await harness.app.handle(
        request('POST', '/api/session', { body: { pin: `tentativo-${attempt}` } }),
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);

    // Il blocco vale anche per il PIN corretto: è legato all'account.
    const correct = await harness.app.handle(
      request('POST', '/api/session', { body: { pin: 'forgia-2026' } }),
    );
    expect(correct.status).toBe(429);
  });

  it('chiude la sessione su richiesta', async () => {
    const { cookie } = await claimInstance();
    const logout = await harness.app.handle(request('DELETE', '/api/session', { cookie }));
    expect(logout.status).toBe(200);
    const state = await harness.app.handle(request('GET', '/api/session', { cookie }));
    expect((state.body as { viewer: unknown }).viewer).toBeNull();
  });
});

describe('recupero dell accesso', () => {
  it('reimposta il PIN e invalida le sessioni aperte', async () => {
    const { response, cookie } = await claimInstance('forgia-2026');
    const { recoveryCode } = response.body as { recoveryCode: string };

    const recovered = await harness.app.handle(
      request('POST', '/api/session/recover', {
        body: { recoveryCode, newPin: 'nuovo-pin-lungo' },
      }),
    );
    expect(recovered.status).toBe(200);

    // La vecchia sessione non vale più.
    const oldState = await harness.app.handle(request('GET', '/api/session', { cookie }));
    expect((oldState.body as { viewer: unknown }).viewer).toBeNull();

    // Il vecchio PIN non vale più, il nuovo sì.
    expect(
      (await harness.app.handle(request('POST', '/api/session', { body: { pin: 'forgia-2026' } })))
        .status,
    ).toBe(401);
    expect(
      (
        await harness.app.handle(
          request('POST', '/api/session', { body: { pin: 'nuovo-pin-lungo' } }),
        )
      ).status,
    ).toBe(200);
  });

  it('rifiuta un codice di recupero inventato', async () => {
    await claimInstance();
    const response = await harness.app.handle(
      request('POST', '/api/session/recover', {
        body: { recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', newPin: 'un-pin-qualsiasi' },
      }),
    );
    expect(response.status).toBe(401);
  });
});
