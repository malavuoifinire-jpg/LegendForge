"""Estrae le classi e le sottoclassi dallo SRD 5.2."""
import json, re
from pathlib import Path
from srdpath import SRC as SRC_DIR

SRC = SRC_DIR / '03_Classes'

def clean(t):
    t = t.replace('’', "'").replace('–', '–').replace('—', '—')
    return re.sub(r'[ \t]+', ' ', t).strip()

def unmark(t):
    return clean(re.sub(r'[*_]+', '', t))

def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:200]

def normalize_headings(text):
    """Toglie il grassetto dai titoli.

    Nel documento alcuni titoli sono in grassetto e altri no — «### **Bard
    Subclass: College of Lore**» accanto a «### Cleric Subclass: Life Domain».
    Uniformarli qui evita di ripetere la stessa tolleranza in ogni ricerca.
    """
    return re.sub(r'^(#{1,6} )\s*\**\s*(.+?)\s*\**\s*$', r'\1\2', text, flags=re.M)

def split_list(value):
    value = re.sub(r'^Choose \d+:\s*', '', value, flags=re.I)
    return [clean(x) for x in re.split(r',|\bor\b|\band\b', value) if clean(x) and clean(x) != '—']

def core_traits(text):
    m = re.search(r'Table:\s*Core [^\n]*Traits[^\n]*\n(.*?)(?=\n#|\nTable:|\Z)', text, re.S | re.I)
    traits = {}
    if not m: return traits
    for line in m.group(1).split('\n'):
        if not line.strip().startswith('|'): continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 2 or set(''.join(cells)) <= set('-: '): continue
        key, value = unmark(cells[0]), unmark(cells[1])
        if key: traits[key] = value
    return traits

def body_of(chunk):
    out = []
    for raw in chunk.split('\n'):
        line = raw.rstrip()
        if not line.strip():
            if out and out[-1] != '': out.append('')
            continue
        if line.strip().startswith('|'): continue   # le tabelle restano fuori dal testo
        out.append(clean(line))
    while out and out[-1] == '': out.pop()
    return '\n'.join(out)

def features_from(text, stop_at=None):
    body = text.split(stop_at, 1)[0] if stop_at and stop_at in text else text
    return [{'level': int(m.group(1)), 'name': unmark(m.group(2)),
             'description': body_of(m.group(3))}
            for m in re.finditer(r'^#### Level (\d+):\s*([^\n]+)\n(.*?)(?=\n#{2,4} |\Z)', body, re.S | re.M)]

def parse():
    classes, subclasses = [], []
    for path in sorted(SRC.glob('*.md')):
        text = normalize_headings(path.read_text(encoding='utf-8'))
        head = re.match(r'^## ([^\n]+)', text)
        if not head: continue
        name = unmark(head.group(1))
        if name.lower() == 'classes': continue

        traits = core_traits(text)
        data = {'features': [], 'primaryAbilities': [], 'savingThrowProficiencies': [],
                'armorProficiencies': [], 'weaponProficiencies': [], 'toolProficiencies': [],
                'skillOptions': [], 'description': ''}
        hd = re.search(r'D(\d+)', traits.get('Hit Point Die', ''))
        if hd: data['hitDie'] = int(hd.group(1))
        for key, field in (('Primary Ability', 'primaryAbilities'),
                           ('Saving Throw Proficiencies', 'savingThrowProficiencies'),
                           ('Weapon Proficiencies', 'weaponProficiencies'),
                           ('Armor Training', 'armorProficiencies'),
                           ('Tool Proficiencies', 'toolProficiencies')):
            if traits.get(key): data[field] = split_list(traits[key])
        skills = traits.get('Skill Proficiencies', '')
        cm = re.search(r'Choose (\d+)', skills, re.I)
        if cm: data['skillChoices'] = int(cm.group(1))
        if skills: data['skillOptions'] = split_list(skills)

        data['features'] = features_from(text, stop_at=f'### {name} Spell List') or \
                           features_from(text, stop_at=f'### {name} Subclass')
        sub = next((f['level'] for f in data['features'] if 'subclass' in f['name'].lower()), None)
        if sub: data['subclassLevel'] = sub
        intro = text.split('Table:', 1)[0].split('\n', 1)[1] if '\n' in text else ''
        data['description'] = body_of(intro)
        classes.append({'kind': 'class', 'name': name, 'slug': slugify(name),
                        'folder': 'Classi', 'data': data})

        for m in re.finditer(rf'^### {re.escape(name)} Subclass:\s*([^\n]+)\n(.*?)(?=\n## |\Z)',
                             text, re.S | re.M):
            sub_name = unmark(m.group(1))
            subclasses.append({'kind': 'subclass', 'name': sub_name, 'slug': slugify(sub_name),
                               'folder': f'Sottoclassi/{name}',
                               'data': {'parentClass': slugify(name),
                                        'features': features_from(m.group(2)),
                                        'description': body_of(m.group(2).split('####', 1)[0])}})
    return classes, subclasses

if __name__ == '__main__':
    c, s = parse()
    print(f'{len(c)} classi, {len(s)} sottoclassi')
