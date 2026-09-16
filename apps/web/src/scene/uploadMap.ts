import type { MapAsset, SupportedMapMimeType } from '@legendforge/contracts';
import { SUPPORTED_MAP_MIME_TYPES } from '@legendforge/contracts';
import { api } from '../api/client';
import { detectGridInImage, loadImageFromFile } from './imageAnalysis';

export interface UploadProgress {
  step: 'analisi' | 'permesso' | 'invio' | 'registrazione';
  message: string;
}

export function isSupportedMapFile(file: File): file is File & { type: SupportedMapMimeType } {
  return (SUPPORTED_MAP_MIME_TYPES as readonly string[]).includes(file.type);
}

/**
 * Carica una mappa in tre passi.
 *
 * Il file non passa dalla nostra API: il server autorizza, il browser invia
 * direttamente allo storage, il server conclude rileggendo i metadati reali.
 */
export async function uploadMap(
  campaignId: string,
  file: File,
  name: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<MapAsset> {
  if (!isSupportedMapFile(file)) {
    throw new Error('Sono ammessi solo file PNG o JPEG');
  }

  onProgress?.({ step: 'analisi', message: "Lettura dell'immagine e ricerca della griglia…" });
  const image = await loadImageFromFile(file);
  let detection = null;
  try {
    detection = detectGridInImage(image.element);
  } finally {
    URL.revokeObjectURL(image.objectUrl);
  }

  onProgress?.({ step: 'permesso', message: 'Richiesta del permesso di caricamento…' });
  const ticket = await api.requestUpload(campaignId, {
    fileName: file.name,
    mimeType: file.type,
    byteSize: file.size,
  });

  onProgress?.({ step: 'invio', message: 'Invio del file allo storage…' });
  const response = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
    body: file,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Lo storage ha rifiutato il file (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`,
    );
  }

  onProgress?.({ step: 'registrazione', message: 'Registrazione della mappa…' });
  return api.finalizeMap(campaignId, {
    assetId: ticket.assetId,
    name,
    widthPx: image.width,
    heightPx: image.height,
    detection,
  });
}
