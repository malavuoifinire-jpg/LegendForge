/**
 * Mappa dimostrativa generata a runtime.
 *
 * Serve soltanto a mostrare il renderer finché il caricamento delle mappe non è
 * pronto: non è un contenuto di terze parti e non viene salvata da nessuna
 * parte. Il passo del reticolo disegnato è noto, così si può verificare che il
 * rilevamento e la calibrazione producano lo stesso valore.
 */

export const DEMO_MAP_WIDTH = 1600;
export const DEMO_MAP_HEIGHT = 1100;
export const DEMO_MAP_CELL_PX = 64;
export const DEMO_MAP_OFFSET = { x: 32, y: 18 };

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOMS = [
  { x: 2, y: 2, w: 8, h: 6 },
  { x: 13, y: 3, w: 6, h: 5 },
  { x: 4, y: 10, w: 7, h: 5 },
  { x: 15, y: 10, w: 8, h: 6 },
  { x: 11, y: 6, w: 2, h: 5 },
];

export function createDemoMap(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = DEMO_MAP_WIDTH;
  canvas.height = DEMO_MAP_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const random = pseudoRandom(20260915);

  ctx.fillStyle = '#1b1f26';
  ctx.fillRect(0, 0, DEMO_MAP_WIDTH, DEMO_MAP_HEIGHT);

  const cell = DEMO_MAP_CELL_PX;
  const ox = DEMO_MAP_OFFSET.x;
  const oy = DEMO_MAP_OFFSET.y;

  // Pavimento delle stanze
  for (const room of ROOMS) {
    const x = ox + room.x * cell;
    const y = oy + room.y * cell;
    const w = room.w * cell;
    const h = room.h * cell;
    ctx.fillStyle = '#3c434f';
    ctx.fillRect(x, y, w, h);

    // Variazione delle lastre, per dare superficie all'immagine
    for (let cy = 0; cy < room.h; cy += 1) {
      for (let cx = 0; cx < room.w; cx += 1) {
        const shade = 0.085 * random();
        ctx.fillStyle = `rgba(255,255,255,${shade.toFixed(3)})`;
        ctx.fillRect(x + cx * cell, y + cy * cell, cell, cell);
      }
    }

    ctx.strokeStyle = '#0a0c0f';
    ctx.lineWidth = 6;
    ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
  }

  // Reticolo inciso sul pavimento, con passo noto
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let x = ox; x <= DEMO_MAP_WIDTH; x += cell) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, DEMO_MAP_HEIGHT);
  }
  for (let y = oy; y <= DEMO_MAP_HEIGHT; y += cell) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(DEMO_MAP_WIDTH, y + 0.5);
  }
  ctx.stroke();

  // Vignettatura
  const gradient = ctx.createRadialGradient(
    DEMO_MAP_WIDTH / 2,
    DEMO_MAP_HEIGHT / 2,
    DEMO_MAP_HEIGHT / 3,
    DEMO_MAP_WIDTH / 2,
    DEMO_MAP_HEIGHT / 2,
    DEMO_MAP_WIDTH * 0.75,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, DEMO_MAP_WIDTH, DEMO_MAP_HEIGHT);

  return canvas;
}
