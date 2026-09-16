/**
 * Superficie di lavoro per una scena senza mappa.
 *
 * Una scena può esistere prima della sua mappa — o non averne affatto, quando
 * serve solo una griglia su cui muovere pedine. In quel caso il canvas disegna
 * una superficie neutra delle dimensioni dichiarate, e tutto il resto funziona
 * allo stesso modo: griglia, calibrazione, pedine.
 */

export const BLANK_SURFACE_WIDTH = 2000;
export const BLANK_SURFACE_HEIGHT = 1400;

export function createBlankSurface(
  width = BLANK_SURFACE_WIDTH,
  height = BLANK_SURFACE_HEIGHT,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#1b1f26';
  ctx.fillRect(0, 0, width, height);

  // Una trama molto tenue evita che la superficie sembri un errore di
  // caricamento e dà un riferimento visivo durante lo zoom.
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 200) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += 200) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();
  return canvas;
}
