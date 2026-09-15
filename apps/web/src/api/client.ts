import type {
  Campaign,
  CreateCampaignInput,
  ErrorBody,
  Health,
  SessionState,
  SetupInput,
  SetupResult,
  Viewer,
} from '@legendforge/contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    credentials: 'same-origin',
  });

  const text = await response.text();
  let payload: unknown;
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'invalid_response', 'Risposta del server non leggibile');
    }
  }

  if (!response.ok) {
    const body = payload as ErrorBody | undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'unknown_error',
      body?.error?.message ?? `Richiesta fallita (${response.status})`,
      body?.error?.details,
    );
  }

  return payload as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export const api = {
  health: () => request<Health>('/api/health'),
  sessionState: () => request<SessionState>('/api/session'),
  setup: (input: SetupInput) => post<SetupResult>('/api/setup', input),
  login: (pin: string) => post<{ viewer: Viewer }>('/api/session', { pin }),
  logout: () => request<{ ok: boolean }>('/api/session', { method: 'DELETE' }),
  recover: (recoveryCode: string, newPin: string) =>
    post<{ recoveryCode: string }>('/api/session/recover', { recoveryCode, newPin }),
  listCampaigns: () => request<Campaign[]>('/api/campaigns'),
  createCampaign: (input: CreateCampaignInput) => post<Campaign>('/api/campaigns', input),
};

/** Elenco leggibile dei campi rifiutati da una convalida. */
export function fieldMessages(error: unknown): string[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
  return (error.details as { field?: string; message?: string }[])
    .map((detail) => detail.message)
    .filter((message): message is string => typeof message === 'string');
}
