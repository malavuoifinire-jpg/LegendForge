import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISION_PROFILE,
  lightBand,
  sightRadius,
  sightRadiusWithLights,
  type VisionProfile,
} from './senses.js';
import { DEFAULT_RULE_SET } from '../rules/ruleset.js';
import { metersToCells, metersToPixels, type GridConfiguration } from '../coordinates/grid.js';

/** Griglia di riferimento: casella da 50 px che vale 1,5 m, il default di prodotto. */
const griglia: GridConfiguration = {
  cellSizePx: 50,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
  metersPerCell: 1.5,
  snapEnabled: true,
};

function profilo(patch: Partial<VisionProfile> = {}): VisionProfile {
  return { ...DEFAULT_VISION_PROFILE, ...patch };
}

describe('scurovisione a 18 e 36 metri', () => {
  it('18 metri sono 12 caselle da 1,5 m', () => {
    expect(griglia.metersPerCell).toBe(DEFAULT_RULE_SET.grid.defaultMetersPerCell);
    expect(DEFAULT_RULE_SET.vision.defaultDarkvisionMeters).toBe(18);
    expect(metersToCells(18, griglia)).toBeCloseTo(12, 9);
    expect(metersToPixels(18, griglia)).toBeCloseTo(600, 9);
  });

  it('36 metri sono 24 caselle da 1,5 m', () => {
    expect(DEFAULT_RULE_SET.vision.extendedDarkvisionMeters).toBe(36);
    expect(metersToCells(36, griglia)).toBeCloseTo(24, 9);
    expect(metersToPixels(36, griglia)).toBeCloseTo(1200, 9);
  });

  it('al buio pesto la portata è esattamente quella della scurovisione', () => {
    const opzioni = { darkness: 1, sceneReachMeters: 200 };

    const corta = sightRadius(profilo({ darkvisionMeters: 18 }), opzioni);
    expect(corta).toEqual({ meters: 18, source: 'scurovisione' });
    expect(metersToCells(corta.meters, griglia)).toBeCloseTo(12, 9);

    const lunga = sightRadius(profilo({ darkvisionMeters: 36 }), opzioni);
    expect(lunga).toEqual({ meters: 36, source: 'scurovisione' });
    expect(metersToCells(lunga.meters, griglia)).toBeCloseTo(24, 9);
  });

  it('senza scurovisione al buio non si vede niente', () => {
    const buio = sightRadius(profilo({ darkvisionMeters: 0 }), {
      darkness: 1,
      sceneReachMeters: 200,
    });
    expect(buio).toEqual({ meters: 0, source: 'nessuna' });
  });
});

describe('bande di luce', () => {
  it('divide la scala in luce piena, penombra e buio', () => {
    expect(lightBand(0)).toBe('bright');
    expect(lightBand(0.33)).toBe('bright');
    expect(lightBand(0.34)).toBe('dim');
    expect(lightBand(0.66)).toBe('dim');
    expect(lightBand(0.67)).toBe('dark');
    expect(lightBand(1)).toBe('dark');
  });
});

describe('portata dello sguardo', () => {
  it('con luce la vista normale arriva fin dove arriva la scena', () => {
    const risultato = sightRadius(profilo({ darkvisionMeters: 18 }), {
      darkness: 0,
      sceneReachMeters: 200,
    });
    expect(risultato).toEqual({ meters: 200, source: 'normale' });
  });

  it('con luce vince comunque la portata maggiore', () => {
    const risultato = sightRadius(profilo({ normalRangeMeters: 9, darkvisionMeters: 18 }), {
      darkness: 0,
      sceneReachMeters: 200,
    });
    expect(risultato).toEqual({ meters: 18, source: 'scurovisione' });
  });

  it('in penombra la vista normale conta ancora', () => {
    const risultato = sightRadius(profilo({ normalRangeMeters: 30, darkvisionMeters: 18 }), {
      darkness: 0.5,
      sceneReachMeters: 200,
    });
    expect(risultato).toEqual({ meters: 30, source: 'normale' });
  });

  it('al buio un senso speciale può superare la scurovisione', () => {
    const risultato = sightRadius(
      profilo({
        darkvisionMeters: 18,
        specialSenses: [{ name: 'percezione tellurica', rangeMeters: 27 }],
      }),
      { darkness: 1, sceneReachMeters: 200 },
    );
    expect(risultato).toEqual({ meters: 27, source: 'senso speciale' });
  });

  it('fra più sensi speciali vale il più lungo', () => {
    const risultato = sightRadius(
      profilo({
        specialSenses: [
          { name: 'udito acuto', rangeMeters: 6 },
          { name: 'olfatto', rangeMeters: 12 },
        ],
      }),
      { darkness: 1, sceneReachMeters: 200 },
    );
    expect(risultato).toEqual({ meters: 12, source: 'senso speciale' });
  });
});

describe('portata con le luci', () => {
  const pixelsPerMeter = griglia.cellSizePx / griglia.metersPerCell;
  const opzioni = { darkness: 1, sceneReachMeters: 200, pixelsPerMeter };
  const torcia = {
    x: 0,
    y: 0,
    brightRadiusMeters: DEFAULT_RULE_SET.vision.torchBrightRadiusMeters,
    dimRadiusMeters: DEFAULT_RULE_SET.vision.torchDimRadiusMeters,
  };

  it('senza luci resta la portata dei propri sensi', () => {
    const risultato = sightRadiusWithLights(
      profilo({ darkvisionMeters: 18 }),
      { x: 0, y: 0 },
      [],
      opzioni,
    );
    expect(risultato).toEqual({ meters: 18, source: 'scurovisione' });
  });

  it('chi sta sulla torcia vede fino al bordo della sua luce', () => {
    const risultato = sightRadiusWithLights(profilo(), { x: 0, y: 0 }, [torcia], opzioni);
    expect(risultato).toEqual({ meters: 12, source: 'luce' });
  });

  it('a metà del cerchio di luce il punto illuminato più lontano è oltre', () => {
    const meta = { x: metersToPixels(6, griglia), y: 0 };
    const risultato = sightRadiusWithLights(profilo(), meta, [torcia], opzioni);
    expect(risultato).toEqual({ meters: 18, source: 'luce' });
  });

  it('una torcia fuori portata non aggiunge niente', () => {
    const lontano = { x: metersToPixels(30, griglia), y: 0 };
    const risultato = sightRadiusWithLights(
      profilo({ darkvisionMeters: 18 }),
      lontano,
      [torcia],
      opzioni,
    );
    expect(risultato).toEqual({ meters: 18, source: 'scurovisione' });
  });

  it('la scurovisione lunga batte una torcia vicina', () => {
    const risultato = sightRadiusWithLights(
      profilo({ darkvisionMeters: 36 }),
      { x: 0, y: 0 },
      [torcia],
      opzioni,
    );
    expect(risultato).toEqual({ meters: 36, source: 'scurovisione' });
  });

  it('fra più luci vale quella che porta più lontano', () => {
    const falò = {
      x: metersToPixels(9, griglia),
      y: 0,
      brightRadiusMeters: 15,
      dimRadiusMeters: 30,
    };
    const risultato = sightRadiusWithLights(profilo(), { x: 0, y: 0 }, [torcia, falò], opzioni);
    expect(risultato).toEqual({ meters: 39, source: 'luce' });
  });
});
