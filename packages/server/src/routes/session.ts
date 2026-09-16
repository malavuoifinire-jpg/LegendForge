import {
  loginInputSchema,
  recoverInputSchema,
  registerInputSchema,
  setupInputSchema,
  type SessionState,
  type SetupResult,
  type Viewer,
} from '@legendforge/contracts';
import type { ServerContext } from '../context.js';
import { resolveViewer } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { clearedSessionCookie, parseCookies, SESSION_COOKIE, serializeSessionCookie } from '../identity/cookies.js';
import {
  claimInstance,
  createSession,
  resetCredentials,
  revokeSession,
  SESSION_DURATION_SECONDS,
  verifyPin,
  verifyRecoveryCode,
} from '../identity/store.js';
import { parseBody } from '../validate.js';
import { clientKey, consumeRateLimit } from '../rate-limit.js';
import { hashSecret } from '../identity/password.js';

function cookieFor(context: ServerContext, token: string): string {
  return serializeSessionCookie(token, {
    maxAgeSeconds: SESSION_DURATION_SECONDS,
    secure: context.env.nodeEnv === 'production',
  });
}

function viewerOf(id: string, displayName: string, isOwner: boolean): Viewer {
  return { id, displayName, isOwner };
}

export function sessionRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/session',
      async handle({ request }) {
        const [state, viewer] = await Promise.all([
          context.pool.query<{ claimed: boolean; open_registration: boolean }>(
            `SELECT (owner_user_id IS NOT NULL) AS claimed, open_registration
               FROM instance_state WHERE id = true`,
          ),
          resolveViewer(context, request),
        ]);
        const body: SessionState = {
          instanceClaimed: state.rows[0]?.claimed ?? false,
          openRegistration: state.rows[0]?.open_registration ?? true,
          viewer,
        };
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },

    {
      method: 'POST',
      pattern: '/api/setup',
      async handle({ request }) {
        const input = parseBody(setupInputSchema, request.body);
        const claim = await claimInstance(context.pool, input.displayName, input.pin);
        if (!claim) {
          throw new HttpError(
            409,
            'already_claimed',
            'Questa istanza ha già un proprietario: usa il PIN per entrare',
          );
        }
        const token = await createSession(context.pool, claim.userId, request.headers['user-agent']);
        const body: SetupResult = {
          viewer: viewerOf(claim.userId, claim.displayName, true),
          recoveryCode: claim.recoveryCode,
        };
        return {
          status: 201,
          headers: { 'Set-Cookie': cookieFor(context, token), 'Cache-Control': 'no-store' },
          body,
        };
      },
    },

    {
      /**
       * Creazione di un account.
       *
       * Un account da solo non dà accesso a niente: serve il codice di una
       * campagna, o un invito, per vedere qualcosa. Il limite sui tentativi
       * evita che qualcuno riempia la tabella di nomi.
       */
      method: 'POST',
      pattern: '/api/register',
      async handle({ request }) {
        const input = parseBody(registerInputSchema, request.body);

        const open = await context.pool.query<{ open_registration: boolean }>(
          'SELECT open_registration FROM instance_state WHERE id = true',
        );
        if (!open.rows[0]?.open_registration) {
          throw new HttpError(
            403,
            'registration_closed',
            'Su questa istanza i nuovi account sono chiusi: serve un invito',
          );
        }

        const limit = await consumeRateLimit(
          context.pool,
          'register',
          clientKey(request.headers),
          5,
          3600,
        );
        if (!limit.allowed) {
          throw new HttpError(
            429,
            'too_many_attempts',
            `Troppi account creati da qui. Riprova fra ${Math.ceil(limit.retryAfterSeconds / 60)} minuti.`,
          );
        }

        const pinHash = await hashSecret(input.pin);
        let userId: string;
        try {
          const inserted = await context.pool.query<{ id: string }>(
            'INSERT INTO users (display_name, pin_hash) VALUES ($1, $2) RETURNING id',
            [input.displayName, pinHash],
          );
          userId = inserted.rows[0]?.id ?? '';
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new HttpError(409, 'name_taken', 'Questo nome è già in uso: scegline un altro');
          }
          throw error;
        }
        if (!userId) throw new Error('creazione account fallita');

        const token = await createSession(context.pool, userId, request.headers['user-agent']);
        return {
          status: 201,
          headers: { 'Set-Cookie': cookieFor(context, token), 'Cache-Control': 'no-store' },
          body: { viewer: viewerOf(userId, input.displayName, false) },
        };
      },
    },

    {
      method: 'POST',
      pattern: '/api/session',
      async handle({ request }) {
        const input = parseBody(loginInputSchema, request.body);
        const attempt = await verifyPin(context.pool, input.pin, input.displayName);

        if (!attempt.ok) {
          if (attempt.lockedForSeconds) {
            throw new HttpError(
              429,
              'too_many_attempts',
              `Troppi tentativi. Riprova fra ${attempt.lockedForSeconds} secondi.`,
            );
          }
          // Stesso messaggio per nome inesistente, PIN sbagliato e istanza non
          // rivendicata: chi prova non deve poter dedurre quale dei tre è.
          throw new HttpError(401, 'invalid_credentials', 'Nome o PIN non validi');
        }

        const userId = attempt.userId;
        if (!userId) throw new HttpError(401, 'invalid_credentials', 'Nome o PIN non validi');
        const token = await createSession(context.pool, userId, request.headers['user-agent']);
        const viewer = await resolveViewer(context, {
          ...request,
          headers: { ...request.headers, cookie: `${SESSION_COOKIE}=${token}` },
        });
        return {
          status: 200,
          headers: { 'Set-Cookie': cookieFor(context, token), 'Cache-Control': 'no-store' },
          body: { viewer },
        };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/session',
      async handle({ request }) {
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (token) await revokeSession(context.pool, token);
        return {
          status: 200,
          headers: {
            'Set-Cookie': clearedSessionCookie(context.env.nodeEnv === 'production'),
            'Cache-Control': 'no-store',
          },
          body: { ok: true },
        };
      },
    },

    {
      method: 'POST',
      pattern: '/api/session/recover',
      async handle({ request }) {
        const input = parseBody(recoverInputSchema, request.body);
        const attempt = await verifyRecoveryCode(context.pool, input.recoveryCode);
        if (!attempt.ok || !attempt.userId) {
          throw new HttpError(401, 'invalid_recovery_code', 'Codice di recupero non valido');
        }
        const recoveryCode = await resetCredentials(context.pool, attempt.userId, input.newPin);
        const token = await createSession(context.pool, attempt.userId, request.headers['user-agent']);
        return {
          status: 200,
          headers: { 'Set-Cookie': cookieFor(context, token), 'Cache-Control': 'no-store' },
          body: { recoveryCode },
        };
      },
    },
  ];
}
