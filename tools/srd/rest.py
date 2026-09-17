"""Estrae oggetti magici, talenti, specie, background, armi e armature."""
import json, re
from pathlib import Path
from srdpath import SRC

FEET_TO_METERS = 0.3
LB_TO_KG = 0.45

def clean(t):
    t = t.replace('’', "'").replace('–', '–').replace('—', '—').replace('−', '-')
    return re.sub(r'[ \t]+', ' ', t).strip()

def unmark(t):
    return clean(re.sub(r'[*_]+', '', t))

def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:200]

def body_text(chunk):
    out = []
    for raw in chunk.split('\n'):
        line = raw.rstrip()
        if not line.strip():
            if out and out[-1] != '': out.append('')
            continue
        out.append(clean(line))
    while out and out[-1] == '': out.pop()
    return '\n'.join(out)

RARITIES = {'common': 'comune', 'uncommon': 'non comune', 'rare': 'raro',
            'very rare': 'molto raro', 'legendary': 'leggendario', 'artifact': 'artefatto'}
CATEGORIES = {'armor': 'Armatura', 'potion': 'Pozione', 'ring': 'Anello', 'rod': 'Bacchetta',
              'scroll': 'Pergamena', 'staff': 'Bastone', 'wand': 'Bacchetta magica',
              'weapon': 'Arma', 'wondrous item': 'Oggetto meraviglioso'}

def magic_items():
    text = (SRC / '10_MagicItems.md').read_text(encoding='utf-8')
    body = text.split('## Magic Items A–Z', 1)[1]
    out = []
    for m in re.finditer(r'^#### ([^\n]+)\n(.*?)(?=\n#### |\Z)', body, re.S | re.M):
        name, chunk = unmark(m.group(1)), m.group(2)
        lines = [l for l in chunk.split('\n') if l.strip()]
        head = unmark(lines[0]) if lines and lines[0].strip().startswith('*') else ''
        # La riga di intestazione diventa categoria e rarita: lasciarla anche
        # nella descrizione vorrebbe dire dire due volte la stessa cosa.
        rest = chunk.replace(lines[0], '', 1) if head else chunk
        data = {'magical': True, 'description': body_text(rest)}
        if head:
            data['category'] = next((v for k, v in CATEGORIES.items() if k in head.lower()), None)
            data['rarity'] = next((v for k, v in RARITIES.items() if k in head.lower()), None)
            data['requiresAttunement'] = 'attunement' in head.lower()
        cm = re.search(r'(\d+)\s*charges', chunk, re.I)
        if cm: data['charges'] = int(cm.group(1))
        out.append({'kind': 'item', 'name': name, 'slug': slugify(name), 'folder': 'Oggetti magici',
                    'data': {k: v for k, v in data.items() if v not in (None, '')}})
    return out

def feats():
    text = (SRC / '05_Feats.md').read_text(encoding='utf-8')
    out, category = [], None
    for m in re.finditer(r'^(###|####) ([^\n]+)\n(.*?)(?=\n#{3,4} |\Z)', text, re.S | re.M):
        level, name, chunk = m.group(1), unmark(m.group(2)), m.group(3)
        if level == '###':
            category = name.replace(' Feats', '')
            continue
        if not category or name.startswith('Parts of'): continue
        lines = [l for l in chunk.split('\n') if l.strip()]
        head = unmark(lines[0]) if lines and lines[0].strip().startswith('*') else ''
        data = {'category': category, 'description': body_text(chunk),
                'repeatable': 'repeatable' in chunk.lower()}
        pm = re.search(r'Prerequisite:?\s*(.+)', head or chunk, re.I)
        if pm: data['prerequisite'] = clean(re.sub(r'[*_]', '', pm.group(1)))[:200]
        out.append({'kind': 'feat', 'name': name, 'slug': slugify(name),
                    'folder': f'Talenti/{category}', 'data': data})
    return out

def species():
    text = (SRC / '04_CharacterOrigins.md').read_text(encoding='utf-8')
    body = text.split('### Species Descriptions', 1)[1]
    out = []
    for m in re.finditer(r'^#### ([^\n]+)\n(.*?)(?=\n#### |\n## |\Z)', body, re.S | re.M):
        name, chunk = unmark(m.group(1)), m.group(2)
        data = {'traits': [], 'description': body_text(chunk), 'sizeInCells': 1, 'darkvisionMeters': 0}
        sm = re.search(r'\*\*Size:?\*?\*?:?\s*([^\n]+)', chunk, re.I)
        if sm: data['size'] = unmark(sm.group(1))
        vm = re.search(r'\*\*Speed:?\*?\*?:?\s*([\d,]+)\s*(?:ft|feet)', chunk, re.I)
        if vm: data['speedMeters'] = round(float(vm.group(1).replace(',', '')) * FEET_TO_METERS, 2)
        dm = re.search(r'Darkvision[^.\n]*?([\d,]+)\s*(?:ft|feet)', chunk, re.I)
        if dm: data['darkvisionMeters'] = round(float(dm.group(1).replace(',', '')) * FEET_TO_METERS, 2)
        for tm in re.finditer(r'\*\*\*?([A-Z][^*\n]{2,60}?)\.?\*\*\*?\s*([^\n]+)', chunk):
            tname = clean(tm.group(1)).rstrip(':').strip()
            if tname.lower() in ('size', 'speed', 'creature type'): continue
            data['traits'].append({'name': tname, 'description': clean(tm.group(2))})
        out.append({'kind': 'species', 'name': name, 'slug': slugify(name),
                    'folder': 'Specie', 'data': data})
    return out

def backgrounds():
    text = (SRC / '04_CharacterOrigins.md').read_text(encoding='utf-8')
    body = text.split('### Background Descriptions', 1)[1].split('## Character Species', 1)[0]
    out = []
    for m in re.finditer(r'^#{2,4} ([^\n]+)\n(.*?)(?=\n#{2,4} |\Z)', body, re.S | re.M):
        name, chunk = unmark(m.group(1)), m.group(2)
        data = {'description': body_text(chunk), 'abilityScores': [],
                'skillProficiencies': [], 'equipment': []}
        am = re.search(r'\*\*Ability Scores:?\*?\*?:?\s*([^\n]+)', chunk, re.I)
        if am: data['abilityScores'] = [clean(x) for x in re.split(r'[,;]|\band\b', unmark(am.group(1))) if clean(x)]
        fm = re.search(r'\*\*Feat:?\*?\*?:?\s*([^\n]+)', chunk, re.I)
        if fm: data['feat'] = unmark(fm.group(1))
        sm = re.search(r'\*\*Skill Proficiencies:?\*?\*?:?\s*([^\n]+)', chunk, re.I)
        if sm: data['skillProficiencies'] = [clean(x) for x in re.split(r'[,;]|\band\b', unmark(sm.group(1))) if clean(x)]
        tm = re.search(r'\*\*Tool Proficiency:?\*?\*?:?\s*([^\n]+)', chunk, re.I)
        if tm: data['toolProficiency'] = unmark(tm.group(1))
        em = re.search(r'\*\*Equipment:?\*?\*?:?\s*([^\n]+)', chunk, re.I)
        if em:
            raw = unmark(em.group(1))
            gm = re.search(r'([\d,]+)\s*GP', raw, re.I)
            if gm: data['startingGold'] = float(gm.group(1).replace(',', ''))
            data['equipment'] = [clean(x) for x in re.split(r'[,;]', raw) if clean(x)][:40]
        out.append({'kind': 'background', 'name': name, 'slug': slugify(name),
                    'folder': 'Background', 'data': data})
    return out

def money(text):
    m = re.search(r'([\d,]+)\s*(CP|SP|EP|GP|PP)', text, re.I)
    if not m: return None
    factor = {'cp': 0.01, 'sp': 0.1, 'ep': 0.5, 'gp': 1.0, 'pp': 10.0}[m.group(2).lower()]
    return round(float(m.group(1).replace(',', '')) * factor, 2)

def weight_kg(text):
    m = re.search(r'([\d/.]+)\s*lb', text, re.I)
    if not m: return None
    raw = m.group(1)
    value = eval(raw) if '/' in raw else float(raw)
    return round(value * LB_TO_KG, 2)

def rows_of(table_text):
    rows = []
    for line in table_text.split('\n'):
        if not line.strip().startswith('|'): continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if not cells or set(''.join(cells)) <= set('-: '): continue
        rows.append(cells)
    return rows[1:] if rows else []

def weapons():
    text = (SRC / '06_Equipment.md').read_text(encoding='utf-8')
    out = []
    for m in re.finditer(r'Table:\s*(Simple|Martial)\s+(Melee|Ranged)\s+Weapons\s*\n(.*?)(?=\nTable:|\n#|\Z)',
                         text, re.S | re.I):
        category = ('Semplice' if m.group(1).lower() == 'simple' else 'Marziale') + \
                   (' da mischia' if m.group(2).lower() == 'melee' else ' da tiro')
        for cells in rows_of(m.group(3)):
            if len(cells) < 6: continue
            name = unmark(cells[0])
            if not name or name.lower() == 'name': continue
            data = {'category': category, 'properties': [], 'description': ''}
            dm = re.match(r'(\d+d\d+)\s+(\w+)', unmark(cells[1]))
            if dm: data['damage'] = {'dice': dm.group(1), 'type': dm.group(2).lower()}
            props = unmark(cells[2])
            if props and props != '—':
                data['properties'] = [clean(p) for p in re.split(r',(?![^()]*\))', props) if clean(p)]
            vm = re.search(r'Versatile \((\d+d\d+)\)', props, re.I)
            if vm and dm: data['versatileDamage'] = {'dice': vm.group(1), 'type': dm.group(2).lower()}
            rm = re.search(r'Range\s+(\d+)/(\d+)', props, re.I)
            if rm:
                data['rangeMeters'] = round(int(rm.group(1)) * FEET_TO_METERS, 2)
                data['longRangeMeters'] = round(int(rm.group(2)) * FEET_TO_METERS, 2)
            mastery = unmark(cells[3])
            if mastery and mastery != '—': data['mastery'] = mastery
            w, c = weight_kg(cells[4]), money(cells[5])
            if w is not None: data['weightKg'] = w
            if c is not None: data['cost'] = c
            out.append({'kind': 'weapon', 'name': name, 'slug': slugify(name),
                        'folder': f'Armi/{category}', 'data': data})
    return out

def armor_rows(table_text, category):
    out = []
    for cells in rows_of(table_text):
        if len(cells) < 4: continue
        name = unmark(cells[0])
        if not name or name.lower() in ('armor', 'name', 'shield'): continue
        joined = ' '.join(cells)
        data = {'category': category, 'description': '',
                'stealthDisadvantage': 'disadvantage' in joined.lower()}
        acm = re.search(r'(\d+)', cells[1])
        if acm: data['baseArmorClass'] = int(acm.group(1))
        if 'dex' in cells[1].lower():
            mx = re.search(r'max\s*(\d+)', cells[1], re.I)
            data['maxDexterityBonus'] = int(mx.group(1)) if mx else None
        else:
            data['maxDexterityBonus'] = 0
        sm = re.search(r'\bStr\s*(\d+)|^\s*(\d{2})\s*$', cells[2] if len(cells) > 2 else '', re.I)
        if sm: data['strengthRequirement'] = int(sm.group(1) or sm.group(2))
        w, c = weight_kg(joined), money(joined)
        if w is not None: data['weightKg'] = w
        if c is not None: data['cost'] = c
        out.append({'kind': 'armor', 'name': name, 'slug': slugify(name),
                    'folder': 'Armature', 'data': data})
    return out

def armor():
    text = (SRC / '06_Equipment.md').read_text(encoding='utf-8')
    labels = {'light': 'Leggera', 'medium': 'Media', 'heavy': 'Pesante'}
    out = []
    for m in re.finditer(r'Table:\s*(Light|Medium|Heavy)\s+Armor[^\n]*\n(.*?)(?=\nTable:|\n#|\Z)',
                         text, re.S | re.I):
        out.extend(armor_rows(m.group(2), labels[m.group(1).lower()]))
    for m in re.finditer(r'Table:\s*Shield[^\n]*\n(.*?)(?=\nTable:|\n#|\Z)', text, re.S | re.I):
        out.extend(armor_rows(m.group(1), 'Scudo'))
    return out

if __name__ == '__main__':
    for label, fn in (('oggetti magici', magic_items), ('talenti', feats), ('specie', species),
                      ('background', backgrounds), ('armi', weapons), ('armature', armor)):
        print(f'{len(fn()):>4}  {label}')
