"""Dove sta il markdown dello SRD.

Si cambia con la variabile d'ambiente SRD_MD; altrimenti si cerca la copia
clonata accanto alla propria cartella home. Il markdown non sta nel
repository: e materiale di partenza, non nostro.

    git clone --depth 1 https://github.com/springbov/dndsrd5.2_markdown.git ~/srdsrc
"""
import os
from pathlib import Path

SRC = Path(os.environ.get('SRD_MD') or (Path.home() / 'srdsrc' / 'src'))

if not SRC.exists():
    raise SystemExit(
        f'Markdown dello SRD non trovato in {SRC}.\n'
        'Clona https://github.com/springbov/dndsrd5.2_markdown in ~/srdsrc '
        'oppure indica il percorso con SRD_MD.')
