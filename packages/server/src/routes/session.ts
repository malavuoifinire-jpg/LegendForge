import {
  loginInputSchema,
  recoverInputSchema,
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
  isInstanceClaimed,
  resetCredentials,
  revokeSession,
  SESSION_DURATION_SECONDS,
  verifyPin,
  verifyRecoveryCode,
} from '../identity/store.js';
import { parseBody } from '../validate.js';

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
        const [claimed, viewer] = await Promise.all([
          isInstanceClaimed(context.pool),
          resolveViewer(context, request),
        ]);
        const body: SessionState = { instanceClaimed: claimed, viewer };
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
