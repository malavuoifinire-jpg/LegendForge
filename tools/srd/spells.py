"""Estrae gli incantesimi dallo SRD 5.2 in markdown."""
import json, re
from pathlib import Path
from srdpath import SRC as SRC_DIR

SRC = SRC_DIR / '07_Spells.md'

# 5 piedi = 1,5 metri: la conversione del gioco, non quella del sistema metrico.
FEET_TO_METERS = 0.3

def clean(text):
    text = text.replace('’', "'").replace('—', '—').replace('–', '–')
    return re.sub(r'\s+', ' ', text).strip()

def strip_marks(text):
    """Toglie asterischi e underscore usati come grassetto o corsivo."""
    return clean(re.sub(r'[*_]+', '', text))

def parse_range(value):
    v = value.lower()
    if 'self' in v: return 0.0
    if 'touch' in v: return 1.5
    m = re.search(r'([\d,]+)\s*(feet|foot|mile)', v)
    if not m: return None
    n = float(m.group(1).replace(',', ''))
    return round(n * (1609.34 if 'mile' in m.group(2) else FEET_TO_METERS), 2)

def parse_area(text):
    m = re.search(r'(\d+)-foot(?:-radius)?\s*(sphere|cube|cone|line|cylinder|square|radius|emanation)',
                  text, re.I)
    if not m: return None, None
    shape = {'sphere': 'cerchio', 'cylinder': 'cerchio', 'radius': 'cerchio', 'emanation': 'cerchio',
             'cube': 'quadrato', 'square': 'quadrato', 'cone': 'cono', 'line': 'linea'}[m.group(2).lower()]
    return shape, round(float(m.group(1)) * FEET_TO_METERS, 2)

def parse_components(value):
    v = value.strip()
    mat = re.search(r'M\s*\(([^)]*)\)', v)
    desc = clean(mat.group(1)) if mat else None
    head = v[:mat.start()] if mat else v
    return {
        'verbal': bool(re.search(r'\bV\b', head)),
        'somatic': bool(re.search(r'\bS\b', head)),
        'material': bool(mat) or bool(re.search(r'\bM\b', head)),
        **({'materialDescription': desc} if desc else {}),
        'consumed': bool(desc and 'consume' in desc.lower()),
    }

SCHOOLS = {'abjuration': 'Abiurazione', 'conjuration': 'Evocazione', 'divination': 'Divinazione',
           'enchantment': 'Ammaliamento', 'evocation': 'Invocazione', 'illusion': 'Illusione',
           'necromancy': 'Necromanzia', 'transmutation': 'Trasmutazione'}

def parse_headline(line):
    """*Level 3 Evocation (Sorcerer, Wizard)* oppure *Evocation Cantrip (...)*"""
    t = strip_marks(line)
    classes = []
    m = re.search(r'\(([^)]*)\)\s*$', t)
    if m:
        classes = [c.strip().lower() for c in m.group(1).split(',') if c.strip()]
        t = t[:m.start()].strip()
    ritual = 'ritual' in classes
    classes = [c for c in classes if c != 'ritual']
    lm = re.match(r'level\s+(\d)\s+(\w+)', t, re.I)
    if lm:
        return int(lm.group(1)), SCHOOLS.get(lm.group(2).lower(), lm.group(2)), classes, ritual
    cm = re.match(r'(\w+)\s+cantrip', t, re.I)
    if cm:
        return 0, SCHOOLS.get(cm.group(1).lower(), cm.group(1)), classes, ritual
    return None, None, classes, ritual

# Nella conversione dal PDF qualche riga vuota si e persa, e il primo
# paragrafo della descrizione e finito attaccato al campo che lo precede.
# Durata e tempo di lancio vengono da un insieme chiuso di forme: si riconosce
# la forma e tutto quello che avanza torna nella descrizione, da dove viene.

DURATION_FORM = re.compile(
    r'^(Concentration,?\s*up to\s+\d+\s+\w+'
    r'|Instantaneous'
    r'|Until dispelled(?:\s+or triggered)?'
    r'|Permanent|Special'
    r'|\d+\s+\w+)\b', re.I)

CASTING_FORM = re.compile(
    r'^((?:Bonus Action|Reaction|Action|Ritual|\d+\s+\w+)'
    r'(?:\s+or Ritual)?'
    # Il grilletto di una reazione e tempo di lancio, non descrizione: nella
    # fonte finisce con un punto oppure con la riga.
    r'(?:\s*,\s*which you take (?:when|in response to)[^.]{0,300}(?:\.|$))?)', re.I)

def split_field(value, form):
    """Restituisce (campo, testo avanzato)."""
    m = form.match(value)
    if not m:
        return value, ''
    return clean(m.group(1)), clean(value[m.end():])

def slugify(name):
    return re.sub(r"[^a-z0-9]+", '-', name.lower()).strip('-')[:200]

def parse():
    text = SRC.read_text(encoding='utf-8')
    body = text.split('## Spell Descriptions', 1)[1]
    chunks = re.split(r'^#### ', body, flags=re.M)[1:]
    spells, problems = [], []
    for chunk in chunks:
        lines = chunk.split('\n')
        name = strip_marks(lines[0])
        rest = '\n'.join(lines[1:])
        level = school = None
        classes, ritual = [], False
        fields = {}
        desc_lines, higher = [], []
        seen_fields = False
        target = desc_lines
        for raw in rest.split('\n'):
            line = raw.rstrip()
            fm = re.match(r'\s*\*\*(Casting Time|Range|Components|Duration)[:.]?\*\*:?\s*(.*)', line)
            if fm:
                fields[fm.group(1)] = clean(fm.group(2))
                seen_fields = True
                continue
            if level is None and re.match(r'\s*[*_].*(level\s+\d|cantrip)', line, re.I):
                level, school, classes, ritual = parse_headline(line)
                continue
            # Il titoletto arriva in almeno tre vestiti diversi: **_X._**, **X._**
            # e *X.*. Si toglie qualunque combinazione di asterischi e underscore.
            upgrade = re.match(
                r'^[\s*_]*(?:Using a Higher-Level Spell Slot|Cantrip Upgrade)[.:]?[\s*_]*(.*)$',
                line, re.I)
            if upgrade:
                target = higher
                line = upgrade.group(1).strip()
                if not line:
                    continue
            if seen_fields and line.strip():
                target.append(clean(line))
            elif seen_fields and target is desc_lines and desc_lines and desc_lines[-1] != '':
                desc_lines.append('')
        if level is None:
            problems.append((name, 'livello non riconosciuto'))
            continue
        ct, ct_spill = split_field(fields.get('Casting Time', ''), CASTING_FORM)
        if 'ritual' in ct.lower():
            ritual = True
        duration, dur_spill = split_field(fields.get('Duration', ''), DURATION_FORM)
        rng = fields.get('Range', '')
        spill = [x for x in (ct_spill, dur_spill) if x]
        description = '\n\n'.join(p for p in '\n'.join(spill + desc_lines).split('\n\n') if p.strip())
        shape, area = parse_area(description)
        dmg = re.search(r'\b(\d{1,2}d\d{1,2})\s+(\w+)\s+damage', description, re.I)
        save = re.search(r'\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving throw',
                         description, re.I)
        data = {
            'level': level, 'school': school,
            'castingTime': ct or None, 'range': rng or None,
            'rangeMeters': parse_range(rng) if rng else None,
            'components': parse_components(fields.get('Components', '')),
            'duration': duration or None,
            'concentration': duration.lower().startswith('concentration'),
            'ritual': ritual, 'classes': classes, 'description': description,
            'atHigherLevels': ' '.join(higher).strip() or None,
            'damage': {'dice': dmg.group(1).lower(), 'type': dmg.group(2).lower()} if dmg else None,
            'savingThrow': save.group(1) if save else None,
            'areaShape': shape, 'areaMeters': area,
        }
        spells.append({'kind': 'spell', 'name': name, 'slug': slugify(name),
                       'data': {k: v for k, v in data.items() if v is not None}})
    return spells, problems

if __name__ == '__main__':
    s, p = parse()
    print(f'{len(s)} incantesimi, {len(p)} scartati')
