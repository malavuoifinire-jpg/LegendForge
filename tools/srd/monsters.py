"""Estrae i blocchi statistiche dallo SRD 5.2 in markdown."""
import json, re
from pathlib import Path
from srdpath import SRC as SRC_DIR

SRC = [SRC_DIR / '12_MonstersA-Z.md', SRC_DIR / '13_Animals.md']
FEET_TO_METERS = 0.3

SIZES = {'tiny': ('Minuscola', 0.5), 'small': ('Piccola', 1), 'medium': ('Media', 1),
         'large': ('Grande', 2), 'huge': ('Enorme', 3), 'gargantuan': ('Mastodontica', 4)}
TYPES = {'aberration': 'Aberrazione', 'beast': 'Bestia', 'celestial': 'Celestiale',
         'construct': 'Costrutto', 'dragon': 'Drago', 'elemental': 'Elementale',
         'fey': 'Fatato', 'fiend': 'Immondo', 'giant': 'Gigante', 'humanoid': 'Umanoide',
         'monstrosity': 'Mostruosita', 'ooze': 'Melma', 'plant': 'Pianta', 'undead': 'Non morto'}
MOVES = {'': 'camminare', 'fly': 'volare', 'swim': 'nuotare', 'climb': 'scalare', 'burrow': 'scavare'}
SENSES = {'darkvision': 'scurovisione', 'blindsight': 'vista cieca',
          'tremorsense': 'percezione tellurica', 'truesight': 'vista pura'}

def clean(t):
    t = t.replace('’', "'").replace('–', '–').replace('—', '—')
    return re.sub(r'\s+', ' ', t).strip()

def unmark(t):
    return clean(re.sub(r'[*_]+', '', t))

def parse_speeds(value):
    out = {}
    for part in value.split(','):
        m = re.match(r'(?:([A-Za-z]+)\s+)?([\d,]+)\s*(?:ft|feet)', part.strip(), re.I)
        if not m: continue
        key = MOVES.get((m.group(1) or '').lower(), (m.group(1) or '').lower() or 'camminare')
        out[key] = round(float(m.group(2).replace(',', '')) * FEET_TO_METERS, 2)
    return out

def parse_senses(value):
    out, passive = {}, None
    pm = re.search(r'Passive Perception\s+(\d+)', value, re.I)
    if pm: passive = int(pm.group(1))
    for m in re.finditer(r'(darkvision|blindsight|tremorsense|truesight)\s+([\d,]+)\s*(?:ft|feet)', value, re.I):
        out[SENSES[m.group(1).lower()]] = round(float(m.group(2).replace(',', '')) * FEET_TO_METERS, 2)
    return out, passive

def parse_cr(value):
    m = re.search(r'(\d+/\d+|\d+)', value)
    cr = None
    if m:
        cr = eval(m.group(1)) if '/' in m.group(1) else float(m.group(1))
    xm = re.search(r'XP\s+([\d,]+)', value, re.I)
    return cr, int(xm.group(1).replace(',', '')) if xm else None

def parse_headline(line):
    t = unmark(line)
    m = re.match(r'(\w+)\s+([\w ]+?)(?:\s*\(([^)]*)\))?\s*,\s*(.+)$', t)
    if not m: return {}
    size, cells = SIZES.get(m.group(1).lower(), (m.group(1), 1))
    ctype = TYPES.get(m.group(2).strip().lower(), m.group(2).strip())
    return {'size': size, 'sizeInCells': cells, 'creatureType': ctype, 'alignment': clean(m.group(4))}

def parse_entries(block):
    """***Nome.*** testo, anche su piu paragrafi, fino al prossimo titoletto."""
    out, current = [], None
    for raw in block.split('\n'):
        line = raw.rstrip()
        m = re.match(r'^\s*\*\*\*(.+?)\.?\*\*\*\s*(.*)$', line)
        if m:
            if current: out.append(current)
            current = {'name': clean(m.group(1)), 'description': clean(m.group(2))}
            continue
        if current and line.strip():
            current['description'] = (current['description'] + ' ' + clean(line)).strip()
    if current: out.append(current)
    for e in out:
        am = re.search(r'Attack Roll:?\*?\*?\s*\+(\d+)', e['description'], re.I)
        if am: e['attackBonus'] = int(am.group(1))
        dm = re.search(r'\((\d{1,2}d\d{1,2}(?:\s*[+-]\s*\d+)?)\)\s+(\w+)\s+damage', e['description'], re.I)
        if dm: e['damage'] = {'dice': re.sub(r'\s+', '', dm.group(1)), 'type': dm.group(2).lower()}
        rm = re.search(r'reach\s+([\d,]+)\s*(?:ft|feet)|range\s+([\d,]+)', e['description'], re.I)
        if rm:
            n = (rm.group(1) or rm.group(2)).replace(',', '')
            e['rangeMeters'] = round(float(n) * FEET_TO_METERS, 2)
    return out

def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:200]

SECTION_KEYS = {'Traits': 'traits', 'Actions': 'actions', 'Bonus Actions': 'bonusActions',
                'Reactions': 'reactions', 'Legendary Actions': 'legendaryActions'}

def parse_one(body):
    data = {'speeds': {}, 'abilities': {}, 'savingThrows': {}, 'skills': {}, 'senses': {},
            'traits': [], 'actions': [], 'bonusActions': [], 'reactions': [],
            'legendaryActions': [], 'languages': [], 'damageResistances': [],
            'damageImmunities': [], 'damageVulnerabilities': [], 'conditionImmunities': []}
    head, _, tail = body.partition('\n### ')
    sections = ('\n### ' + tail) if tail else ''

    for line in head.split('\n'):
        if re.match(r'^\s*\*[^*]', line) and not data.get('size'):
            data.update(parse_headline(line))
        # Il separatore va preteso: con tutti i pezzi opzionali una ripetizione
        # pigra si ferma alla prima lettera e il nome del campo diventa "A".
        lm = re.match(r'^\s*-\s*\*\*([A-Za-z][A-Za-z ]*?)[:*]+\s*(.*)$', line)
        if not lm: continue
        key, value = lm.group(1).strip(), clean(lm.group(2))
        if key.startswith('Armor Class'):
            am = re.match(r'(\d+)', value)
            if am: data['armorClass'] = int(am.group(1))
            note = value[am.end():].strip(' ()') if am else value
            if note: data['armorNote'] = note
        elif key.startswith('Hit Points'):
            hm = re.match(r'([\d,]+)', value)
            if hm: data['hitPoints'] = int(hm.group(1).replace(',', ''))
            dm = re.search(r'\((\d{1,3}d\d{1,3}(?:\s*[+-]\s*\d+)?)\)', value)
            if dm: data['hitDice'] = re.sub(r'\s+', '', dm.group(1))
        elif key.startswith('Speed'):
            data['speeds'] = parse_speeds(value)
        elif key == 'Senses':
            data['senses'], passive = parse_senses(value)
            if passive is not None: data['passivePerception'] = passive
        elif key == 'Skills':
            for m in re.finditer(r'([A-Za-z ]+?)\s*([+-]\d+)', value):
                data['skills'][clean(m.group(1)).lower()] = int(m.group(2))
        elif key == 'Languages':
            data['languages'] = [clean(x) for x in re.split(r'[;,]', value) if clean(x)]
        elif key in ('Immunities', 'Resistances', 'Vulnerabilities'):
            field = {'Immunities': 'damageImmunities', 'Resistances': 'damageResistances',
                     'Vulnerabilities': 'damageVulnerabilities'}[key]
            data[field] = [clean(x).lower() for x in re.split(r'[;,]', value) if clean(x)]
        elif key == 'CR':
            cr, xp = parse_cr(value)
            if cr is not None: data['challengeRating'] = cr
            if xp is not None: data['experiencePoints'] = xp

    for m in re.finditer(r'\n### ([^\n]+)\n(.*?)(?=\n### |\Z)', sections, re.S):
        key = SECTION_KEYS.get(m.group(1).strip())
        if key: data[key] = parse_entries(m.group(2))

    for m in re.finditer(r'^\|\s*(STR|DEX|CON|INT|WIS|CHA)\s*\|\s*(\d+)\s*\|\s*([+-]?\d+)\s*\|\s*([+-]?\d+)\s*\|',
                         body, re.M | re.I):
        ab = m.group(1).lower()
        data['abilities'][ab] = int(m.group(2))
        if int(m.group(4)) != int(m.group(3)):
            data['savingThrows'][ab] = int(m.group(4))
    return data

def parse():
    monsters, problems = [], []
    for path in SRC:
        text = path.read_text(encoding='utf-8')
        for m in re.finditer(r'^## ([^\n]+)\n(.*?)(?=\n## |\Z)', text, re.S | re.M):
            name = unmark(m.group(1))
            if name.lower().startswith('monsters'): continue
            data = parse_one(m.group(2))
            if 'armorClass' not in data or 'hitPoints' not in data:
                problems.append((name, 'blocco incompleto'))
                continue
            monsters.append({'kind': 'monster', 'name': name, 'slug': slugify(name),
                             'data': {k: v for k, v in data.items() if v not in (None, [], {})}})
    return monsters, problems

if __name__ == '__main__':
    m, p = parse()
    print(f'{len(m)} mostri, {len(p)} scartati')
