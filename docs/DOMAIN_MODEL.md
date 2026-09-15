# Modello di dominio

Entità, sistema di coordinate e schema del database. Descrive il modello
completo; la colonna "milestone" indica quando ogni tabella viene effettivamente
creata da una migrazione.

## 1. Sistema di coordinate

Quattro spazi, con una sola regola: **soltanto il primo viene salvato**.

### 1.1 Spazio immagine (persistito)

Pixel dell'immagine originale della mappa, origine in alto a sinistra, asse Y
verso il basso. È l'unico spazio che finisce nel database. Una pedina, un muro,
una sorgente di luce hanno coordinate in pixel immagine.

Il motivo è in ADR-009: la mappa è il riferimento fisico, la griglia è una
sovrapposizione. Ricalibrare la griglia non deve spostare nulla.

### 1.2 Spazio griglia (derivato)

Indici interi di casella `(col, row)`. La griglia è una trasformazione affine
descritta da:

| Campo | Significato |
|---|---|
| `cellSizePx` | lato della casella in pixel immagine |
| `offsetX`, `offsetY` | posizione in pixel dell'angolo della casella (0,0) |
| `rotationDeg` | lieve rotazione rispetto agli assi immagine |
| `metersPerCell` | metri rappresentati dal lato di una casella, default 1,5 |
| `snapEnabled` | aggancio attivo |

Da punto a casella, con `O` l'origine e `θ` la rotazione:

```
locale = R(-θ) · (p − O)
col    = locale.x / cellSizePx
row    = locale.y / cellSizePx
```

e la trasformazione inversa:

```
p = O + R(θ) · (col · cellSizePx, row · cellSizePx)
```

Le due funzioni sono l'una l'inversa dell'altra: il test lo verifica anche con
griglie ruotate, perché è il punto in cui un errore di segno passerebbe
inosservato fino a produrre pedine spostate di una casella.

### 1.3 Metri (derivato)

```
metri = caselle × metersPerCell
```

Con il default di 1,5 m: 12 caselle sono 18 m, 24 caselle sono 36 m — i due
raggi di scurovisione previsti. Il budget di movimento è espresso internamente
in metri e mostrato all'utente in entrambe le unità.

### 1.4 Spazio schermo (mai persistito)

Pixel del canvas. Dipende da `panX`, `panY`, `zoom`:

```
schermo  = punto_immagine × zoom + pan
immagine = (schermo − pan) / zoom
```

Lo zoom avviene attorno al puntatore: il punto immagine sotto il cursore resta
fermo. Nessuna navigazione della vista modifica un dato salvato, ed esiste un
test che lo verifica facendo una sequenza di zoom e pan e ricontrollando che la
casella di un punto non sia cambiata.

### 1.5 Impronta delle pedine

Una pedina ha un lato in caselle. Il centro di una pedina di lato dispari cade
sul centro di una casella; di lato pari, su un incrocio. Le pedine più piccole
di una casella restano centrate nella casella che le contiene. L'aggancio è
idempotente: agganciare due volte non sposta.

## 2. Convenzioni comuni

Ogni entità persistente ha:

| Colonna | Tipo | Nota |
|---|---|---|
| `id` | `uuid` | generato dal database |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | aggiornato a ogni scrittura |
| `version` | `integer` | parte da 1, incrementato a ogni modifica |

`version` serve alla concorrenza ottimistica (ADR-011). Gli aggiornamenti hanno
sempre la forma:

```sql
UPDATE tokens
   SET x = $1, y = $2, version = version + 1, updated_at = now()
 WHERE id = $3 AND version = $4
RETURNING *;
```

Zero righe modificate significa conflitto: il server risponde 409 con lo stato
attuale e il client riconcilia.

Le cancellazioni sono logiche dove il dato ha valore storico (`deleted_at`) e
fisiche dove non ne ha. Ogni azione distruttiva nella UI chiede conferma o è
annullabile.

## 3. Catalogo delle entità

### Identità e accesso

| Entità | Contenuto | Milestone |
|---|---|---|
| `User` | nome visualizzato, hash del PIN, parametri dell'hash, tentativi falliti, blocco temporaneo, hash del codice di recupero | 1 (minimo), 2 (completo) |
| `Session` | hash del token di sessione, utente, scadenza, ultimo utilizzo, revoca, user agent troncato | 1 |
| `Campaign` | nome, descrizione, proprietario, posti giocatore (1–8), profilo di regole | 1 |
| `CampaignMembership` | campagna, utente, ruolo (`game_master` \| `player`), stato, data di ingresso | 1 |
| `Invite` | campagna, hash del token ad alta entropia, posti, scadenza, usi consumati, revoca, autore | 2 |

Il PIN non è mai salvato in chiaro né confrontato in tempo variabile. Il codice
di recupero è mostrato una sola volta e salvato solo come hash.

### Contenuti della campagna

| Entità | Contenuto | Milestone |
|---|---|---|
| `Folder` | albero di cartelle per tipo di contenuto, con genitore e ordinamento | 4 |
| `Asset` | file caricato: chiave di storage, tipo MIME, byte, dimensioni in pixel, checksum, stato (`pending` \| `ready`) | 1 |
| `MapAsset` | mappa: nome, asset, esito del rilevamento griglia | 1 |
| `Scene` | nome, mappa, stato della griglia, oscurità ambientale | 1 |
| `GridConfiguration` | uno a uno con la scena: i campi della sezione 1.2, più stato e versione propria | 1 |

Il rilevamento è salvato come oggetto JSON con passo, offset, rotazione,
confidenza, soglia e diagnostica per asse. Serve a mostrare al Game Master
*perché* una proposta è debole, non solo che lo è.

### Attori e pedine

| Entità | Contenuto | Milestone |
|---|---|---|
| `Actor` | modello base condiviso da personaggi e mostri: tipo, nome, immagini, taglia, punti ferita attuali e massimi, difesa, caratteristiche, bonus, competenze, velocità per tipo di movimento, sensi, risorse, condizioni, inventario, azioni, note, campi personalizzati | 1 (scheletro), 4 (completo) |
| `ActorOwnership` | quali utenti controllano quale attore | 2 |
| `Token` | istanza di un attore su una scena: posizione in pixel immagine, lato in caselle, rotazione, colore, disposizione, nascosto, immagine | 1 |
| `Condition` | condizioni applicabili, con effetti dichiarativi | 6 |

Le caratteristiche variabili di un attore stanno in colonne JSONB validate da
schema, non in colonne fisse: classi, capacità, armi e incantesimi devono essere
entità modificabili, non un elenco fisso nel codice.

### Visione e illuminazione

| Entità | Contenuto | Milestone |
|---|---|---|
| `Wall` | segmento o polilinea, tipo (opaco, porta, finestra, attraversabile ma opaco, visibile ma non attraversabile) | 3 |
| `Door` | stato aperto / chiuso / bloccato, collegato al muro | 3 |
| `LightSource` | posizione o pedina collegata, raggio intenso e fioco in metri, colore, intensità, durata | 3 |
| `FogState` | per scena e per giocatore: esplorato, attualmente visibile | 3 |

I muri sono segmenti, non poligoni: il calcolo del campo visivo lancia raggi
contro i segmenti. Le porte sono muri con uno stato che ne cambia l'opacità.

### Oggetti, azioni ed effetti

| Entità | Contenuto | Milestone |
|---|---|---|
| `Item` | oggetto generico: nome, descrizione, peso, valore, proprietà | 4 |
| `Weapon` | specializzazione di oggetto: gittata, danno, tipo di danno, proprietà | 4 |
| `Spell` | livello, scuola, tempo di lancio, gittata, componenti, durata, concentrazione | 4 |
| `Action` | ciò che un attore può fare: bersaglio, tiro per colpire, tiro salvezza, danno, condizioni applicate, consumo di risorse, area, effetto grafico | 6 |
| `AreaTemplate` | forma (cerchio, cono, linea, quadrato, personalizzata), dimensioni, origine, rotazione | 6 |
| `VisualEffectDefinition` | preset parametrico riutilizzabile: forma, colore, durata, particelle, suono | 6 |

La separazione è netta e voluta: **definizione della regola**, **risoluzione
dell'azione**, **rappresentazione grafica** sono tre cose distinte. Una palla di
fuoco e una granata condividono il preset "esplosione" e differiscono per
parametri; non esiste un'animazione scritta a mano per ogni oggetto.

### Combattimento

| Entità | Contenuto | Milestone |
|---|---|---|
| `CombatEncounter` | scena, round, turno corrente, stato | 5 |
| `Combatant` | pedina, iniziativa, ordine, movimento usato nel round, stato | 5 |
| `MovementRecord` | percorso, costo, tipo di movimento, se autorizzato dal Game Master, annullabile | 5 |

Il movimento usato è azzerato all'inizio del turno. Superare il budget è
normalmente impedito; il Game Master può autorizzarlo, e l'autorizzazione resta
registrata.

## 4. Relazioni

```
User ──< CampaignMembership >── Campaign ──< Invite
                                   │
                                   ├──< Folder
                                   ├──< Asset ──< MapAsset
                                   ├──< Actor ──< ActorOwnership >── User
                                   └──< Scene ──1 GridConfiguration
                                            ├──< Token >── Actor
                                            ├──< Wall ──1 Door
                                            ├──< LightSource
                                            ├──< FogState >── User
                                            └──1 CombatEncounter ──< Combatant
                                                                      │
                                                                      └──< MovementRecord
```

## 5. Schema della milestone 1

La prima migrazione crea soltanto ciò che serve a una scena funzionante. Le
tabelle successive arrivano con le rispettive milestone, ognuna con la propria
migrazione numerata.

```
0001_init.sql
  users                 identità minima, hash del PIN già previsto
  sessions              sessioni opache
  campaigns             con profilo di regole JSONB
  campaign_memberships  ruolo e stato
  assets                file caricati, stato pending/ready
  map_assets            mappa + esito del rilevamento
  scenes                scena
  grid_configurations   uno a uno con la scena
  actors                scheletro, per l'integrità referenziale delle pedine
  tokens                pedine
```

Indici previsti: chiavi esterne, `(campaign_id, name)` per le ricerche nelle
librerie, `(scene_id)` sulle pedine, unicità su `sessions.token_hash` e su
`assets.storage_key`.

Vincoli che il database fa rispettare, non solo l'applicazione:

- `campaigns.player_slots` fra 1 e 8;
- `grid_configurations.cell_size_px` maggiore di zero;
- `grid_configurations.meters_per_cell` maggiore di zero;
- un solo `game_master` per campagna, con indice unico parziale;
- `tokens.size_in_cells` maggiore di zero.

## 6. Import ed esport

Attori, oggetti, armi e incantesimi si esportano in JSON con uno schema
versionato:

```json
{
  "schemaVersion": 1,
  "kind": "actor",
  "exportedAt": "2026-09-15T10:00:00Z",
  "data": { }
}
```

L'importazione rifiuta versioni sconosciute invece di indovinare, e non importa
mai riferimenti a file che non sono nel pacchetto. Non vengono precaricati né
importati contenuti provenienti da manuali commerciali: i dati di esempio
inclusi nel repository sono originali.

## 7. Cosa viene testato di questo modello

| Comportamento | Dove |
|---|---|
| pixel ↔ casella ↔ metri, anche con griglia ruotata | test unitari di `core` |
| aggancio e impronta per taglie pari, dispari e minori di una casella | test unitari di `core` |
| zoom e pan non alterano le coordinate logiche | test unitari di `core` |
| regole delle diagonali nelle tre varianti | test unitari di `core` |
| costo del percorso, terreno difficile, caselle impraticabili | test unitari di `core` |
| conflitto di versione su aggiornamento concorrente | test di integrazione |
| un giocatore non può modificare pedine altrui | test di integrazione |
| l'API non restituisce entità nascoste a chi non è autorizzato | test di integrazione |
| persistenza di mappa, scena, griglia e pedine dopo ricarica | test end-to-end |
