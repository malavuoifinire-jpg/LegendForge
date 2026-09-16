import { useEffect, useRef } from 'react';
import type { SceneEvent } from '@legendforge/contracts';
import { api } from '../api/client';

/**
 * Segue gli aggiornamenti di una scena con richieste in attesa lunga.
 *
 * La richiesta resta aperta finché il server non ha qualcosa da consegnare,
 * quindi un movimento arriva agli altri partecipanti quasi subito senza
 * interrogare il server di continuo. Quando la scheda è in secondo piano la
 * catena si ferma: nessuno sta guardando.
 */
export function useSceneSync(
  sceneId: string | null,
  initialCursor: number,
  onEvents: (events: SceneEvent[]) => void,
): void {
  const cursorRef = useRef(initialCursor);
  const handlerRef = useRef(onEvents);
  handlerRef.current = onEvents;

  useEffect(() => {
    cursorRef.current = initialCursor;
  }, [initialCursor, sceneId]);

  useEffect(() => {
    if (!sceneId) return;
    let stopped = false;
    let controller = new AbortController();
    let failures = 0;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        if (document.visibilityState === 'hidden') {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        controller = new AbortController();
        try {
          const result = await api.sceneEvents(sceneId, cursorRef.current, controller.signal);
          if (stopped) return;
          failures = 0;
          cursorRef.current = result.cursor;
          if (result.events.length > 0) handlerRef.current(result.events);
        } catch (error) {
          if (stopped || (error instanceof DOMException && error.name === 'AbortError')) return;
          // Attesa crescente sugli errori: una rete assente non deve
          // trasformarsi in una raffica di richieste.
          failures += 1;
          const delay = Math.min(1000 * 2 ** Math.min(failures, 5), 30_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    };

    void loop();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') controller.abort();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sceneId]);
}
