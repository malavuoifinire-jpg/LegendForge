"""Assembla il pacchetto SRD 5.2.1 nel formato di LegendForge."""
import json
from pathlib import Path

import spells as spells_mod
import monsters as monsters_mod
import rest as rest_mod
import classes as classes_mod

TOOL = Path(__file__).parent
OUT = TOOL.parent.parent / 'packs' / 'srd-5.2.1.json'
NAMES = TOOL / 'nomi-italiani.json'

ATTRIBUTION = (
    'This work includes material from the System Reference Document 5.2 ("SRD 5.2") '
    'by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. '
    'The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International '
    'License, available at https://creativecommons.org/licenses/by/4.0/legalcode. '
    'Changes were made: the original PDF was converted to Markdown by springbov '
    '(https://github.com/springbov/dndsrd5.2_markdown), then extracted into structured '
    'data and partially translated into Italian for LegendForge.'
)

# Refusi della conversione in markdown, corretti sul nome originale.
# Non e una modifica del contenuto: e la stessa parola scritta giusta.
REFUSI = {'spell': {'thunderwavea': 'Thunderwave'}}

def monster_band(cr):
    if cr is None: return 'Senza grado'
    if cr < 1: return 'Grado di sfida 0–1/2'
    if cr <= 4: return 'Grado di sfida 1–4'
    if cr <= 10: return 'Grado di sfida 5–10'
    if cr <= 16: return 'Grado di sfida 11–16'
    return 'Grado di sfida 17+'

FOLDERS = {
    'spell': lambda e: ('Incantesimi/Trucchetti' if e['data']['level'] == 0
                        else f"Incantesimi/Livello {e['data']['level']}"),
    'monster': lambda e: f"Mostri/{monster_band(e['data'].get('challengeRating'))}",
}

def main():
    names = json.loads(NAMES.read_text(encoding='utf-8')) if NAMES.exists() else {}

    entries = []
    entries += spells_mod.parse()[0]
    entries += monsters_mod.parse()[0]
    entries += (rest_mod.magic_items() + rest_mod.feats() + rest_mod.species()
                + rest_mod.backgrounds() + rest_mod.weapons() + rest_mod.armor())
    cls, subs = classes_mod.parse()
    entries += cls + subs

    translated = 0
    for entry in entries:
        fixed = REFUSI.get(entry['kind'], {}).get(entry['slug'])
        if fixed: entry['name'] = fixed
        english = entry['name']
        italian = names.get(entry['kind'], {}).get(entry['slug'])
        if italian:
            entry['name'] = italian
            entry['originalName'] = english
            translated += 1
        folder = FOLDERS.get(entry['kind'])
        if folder and 'folder' not in entry:
            entry['folder'] = folder(entry)

    pack = {'format': 'legendforge-pack', 'schemaVersion': 1, 'slug': 'srd-5-2-1',
            'name': 'SRD 5.2.1 — regole 2024', 'packVersion': '1.0.0',
            'license': 'CC-BY-4.0', 'attribution': ATTRIBUTION,
            'sourceUrl': 'https://www.dndbeyond.com/srd', 'entries': entries}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding='utf-8')

    counts = {}
    for e in entries:
        counts[e['kind']] = counts.get(e['kind'], 0) + 1
    print(f'{len(entries)} voci, {OUT.stat().st_size // 1024} KB → {OUT}')
    for kind, n in sorted(counts.items(), key=lambda x: -x[1]):
        done = sum(1 for e in entries if e['kind'] == kind and e.get('originalName'))
        print(f'  {kind:<12} {n:>4}   tradotte {done:>4}/{n}')
    print(f'nomi italiani: {translated}/{len(entries)}')
    seen = {}
    for e in entries:
        seen[(e['kind'], e['slug'])] = seen.get((e['kind'], e['slug']), 0) + 1
    print('slug duplicati:', sum(1 for v in seen.values() if v > 1))

if __name__ == '__main__':
    main()
