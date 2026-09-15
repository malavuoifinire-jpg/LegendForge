import type { ErrorBody, Health } from '@legendforge/contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });

  const text = await response.text();
  let payload: unknown = undefined;
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
    );
  }

  return payload as T;
}

export function fetchHealth(): Promise<Health> {
  return request<Health>('/api/health');
}
