# Importatore dello SRD 5.2.1

Trasforma lo **System Reference Document 5.2.1** nel formato dei pacchetti di
LegendForge. Gira fuori dall'applicazione: il suo risultato è un file JSON, e
il file si carica come qualsiasi altro pacchetto.

Nel motore non finisce niente di tutto questo. È il senso della separazione fra
motore, dati e contenuti: il codice non sa che cosa sia una palla di fuoco.

## Provenienza

| | |
|---|---|
| Fonte | [SRD 5.2.1](https://www.dndbeyond.com/srd), Wizards of the Coast |
| Licenza | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) — uso commerciale incluso, obbligo di attribuzione |
| Conversione in Markdown | [springbov/dndsrd5.2_markdown](https://github.com/springbov/dndsrd5.2_markdown) |
| Estrazione e traduzione | questo repository |

La CC BY chiede di dichiarare le modifiche. Sono tre:

1. Il PDF originale è stato convertito in Markdown da springbov.
2. Qui il Markdown diventa dati strutturati: livelli, gittate in metri, dadi di
   danno, tiri salvezza, aree.
3. I nomi sono stati tradotti in italiano. **Sono traduzioni nostre**, non
   quelle dell'edizione italiana ufficiale: quella traduzione è a sua volta
   un'opera protetta e non si può copiare. Il nome originale viaggia accanto a
   quello italiano, così chi ha il manuale in inglese si ritrova.

La frase di attribuzione richiesta da Wizards sta dentro il pacchetto, nel
campo `attribution`, e l'interfaccia la mostra a chi lo carica.

Quello che **non** è entrato qui dentro: il Player's Handbook. Non è
licenziato per finire in un software, né in PDF né trascritto su un sito di
fan, e avere una copia del manuale non è una licenza.

## Uso

```bash
git clone --depth 1 https://github.com/springbov/dndsrd5.2_markdown.git ~/srdsrc
cd tools/srd && python3 build.py     # scrive packs/srd-5.2.1.json
```

Il markdown di partenza non sta nel repository: è materiale di origine, non
nostro. Il percorso si cambia con `SRD_MD`.

## Contenuto del pacchetto

| Tipo | Voci | Nomi italiani |
|---|---:|---:|
| Incantesimi | 338 | 338 |
| Mostri | 329 | — |
| Oggetti magici | 243 | — |
| Armi | 38 | 38 |
| Talenti | 17 | 17 |
| Armature | 12 | 12 |
| Classi | 12 | 12 |
| Sottoclassi | 12 | 12 |
| Specie | 9 | 9 |
| Background | 4 | 4 |
| **Totale** | **1014** | **442** |

Mostri e oggetti magici restano con il nome inglese, per ora.

## Difetti della fonte, e che cosa ne facciamo

La conversione dal PDF non è perfetta. Tre cose che i parser correggono:

- **Righe vuote perdute.** In tredici incantesimi il primo paragrafo della
  descrizione è finito attaccato a «Durata» o a «Tempo di lancio». Durata e
  tempo di lancio vengono da un insieme chiuso di forme: si riconosce la forma
  e quello che avanza torna nella descrizione, da dove viene.
- **Titoli disomogenei.** Alcuni sono in grassetto e altri no. Vengono
  uniformati una volta sola, all'inizio.
- **Refusi nei nomi.** Elencati in `REFUSI` dentro `build.py`, uno solo per
  ora: `Thunderwavea` → `Thunderwave`. È ortografia, non contenuto.

Ogni voce prodotta viene convalidata contro gli schemi di
`@legendforge/contracts` prima di essere considerata buona: 1014 su 1014.
