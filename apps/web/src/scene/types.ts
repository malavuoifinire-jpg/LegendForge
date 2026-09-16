/** Pedina come la disegna il canvas: la posizione è il centro, in pixel immagine. */
export interface CanvasToken {
  id: string;
  name: string;
  x: number;
  y: number;
  sizeInCells: number;
  color: string;
  hidden?: boolean;
}

/** Immagine di fondo della scena, con le sue dimensioni native. */
export interface CanvasMap {
  source: CanvasImageSource;
  width: number;
  height: number;
}
