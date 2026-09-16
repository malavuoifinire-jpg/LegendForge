# Roadmap

Una milestone è completa quando i suoi criteri di accettazione sono verificabili
da qualcuno che non ha scritto il codice. Un pulsante che non chiama il server,
un dato che vive solo in memoria o una schermata scollegata dal backend non
contano come funzionalità.

Ordine non negoziabile: ogni milestone si appoggia alla precedente.

---

## Milestone 0 — Progettazione

**Contenuto**: analisi, decisioni architetturali, schema del database, sistema
di coordinate, modello delle minacce, roadmap, criteri di accettazione.

**Accettazione**
- [x] `docs/ARCHITECTURE.md` con le decisioni motivate
- [x] `docs/DOMAIN_MODEL.md` con entità, coordinate e schema
- [x] `docs/SECURITY.md` con modello delle minacce e controlli
- [x] `docs/ROADMAP.md` con criteri verificabili
- [x] Repository privato, con `.gitignore` che esclude chiavi e ambienti

---

## Milestone 1 — Vertical slice della scena

Una sola scena, un solo operatore, ma end-to-end vero: dal file sul disco al
database e ritorno.

**Contenuto**: struttura del progetto, caricamento mappa, canvas con zoom e pan,
rilevamento preliminare della griglia, calibrazione manuale, overlay, creazione
e movimento di una pedina, persistenza dopo il ricaricamento.

**Accettazione**
- [x] Zoom e pan sono fluidi e il punto sotto il cursore resta fermo durante lo zoom
- [x] Il rilevamento propone passo, offset, rotazione e confidenza, e mostra sempre l'anteprima sovrapposta
- [x] Una proposta con confidenza bassa non è mai accettata da sola: serve la conferma
- [x] Il wizard di calibrazione accetta due incroci e il numero di caselle, e aggiorna l'overlay in tempo reale
- [x] Passo, offset, rotazione e snap sono regolabili a mano con effetto immediato
- [x] La conferma "una casella vale 1,5 metri" porta la scena allo stato confermato
- [x] L'immagine della mappa non viene mai modificata: la griglia è solo sovrapposta
- [x] Una pedina si crea, si trascina e si aggancia alla griglia — l'aggancio lo calcola il server
- [x] Ricaricando la pagina mappa, griglia e pedine sono dove erano
- [x] `lint`, `typecheck`, test unitari, test di integrazione e build passano
- [ ] Caricando un PNG o un JPEG la mappa appare sul canvas alle sue dimensioni reali — *da confermare sull'ambiente pubblicato: lo storage non è raggiungibile dall'ambiente di sviluppo*
- [ ] Un file che non è PNG o JPEG viene rifiutato con un messaggio comprensibile — *idem*

**Oltre il piano**: la milestone include anche la fetta minima di identità
(proprietario dell'istanza, PIN, codice di recupero, sessione con cookie) e le
campagne, perché pubblicare significa esporre l'API: un servizio aperto non è
una base su cui costruire. Vedi ADR-016.

**Test obbligatori coperti**: conversione pixel/caselle/metri; algoritmi
diagonali; costo del percorso; persistenza di mappe, pedine e attori;
proprietà delle pedine; impossibilità di ottenere dall'API dati nascosti;
tentativi ripetuti sul PIN.

**Fuori scope**: inviti, giocatori multipli, sincronizzazione in tempo reale,
muri, luci.

---

## Milestone 2 — Campagne e multiplayer

**Contenuto**: creazione campagna, Game Master, link d'invito, PIN, codice di
recupero, assegnazione dei personaggi, sincronizzazione in tempo reale,
permessi applicati sul server.

**Accettazione**
- [ ] Chi crea la campagna ne diventa Game Master, con da 1 a 8 posti giocatore
- [ ] Il Game Master imposta un PIN e riceve un codice di recupero mostrato una sola volta
- [ ] I link d'invito si creano, revocano e rigenerano; un link revocato non funziona più
- [ ] Un giocatore entra dal link, sceglie nome e PIN, e ottiene una sessione persistente
- [ ] Il Game Master assegna uno o più personaggi a ogni giocatore
- [ ] Un giocatore controlla solo i personaggi assegnati; il Game Master controlla tutto
- [ ] Muovendo una pedina, gli altri client la vedono muoversi senza ricaricare
- [ ] Tentativi ripetuti sul PIN portano a rallentamento e blocco temporaneo
- [ ] Chiamando l'API con la sessione di un giocatore non si ottengono dati nascosti

**Test obbligatori coperti**: proprietà delle pedine; impossibilità di modificare
pedine altrui; impossibilità di ottenere dall'API dati nascosti; sincronizzazione
di due client; revoca degli inviti; tentativi ripetuti sul PIN.

---

## Milestone 3 — Muri, luci e visibilità

**Contenuto**: editor dei muri, porte, collisioni, linea di vista, scurovisione,
sorgenti di luce, oscurità ambientale, fog of war.

**Accettazione**
- [ ] Si disegnano segmenti e polilinee, si modificano i vertici, si cancella, con snap opzionale
- [ ] Sono disponibili muro opaco, porta, finestra, ostacolo attraversabile ma opaco, ostacolo visibile ma non attraversabile
- [ ] Le porte si aprono, chiudono e bloccano, e la visibilità cambia di conseguenza
- [ ] Il poligono di visione di una pedina rispetta i muri: dietro un angolo non si vede
- [ ] La scurovisione funziona a 18 m (12 caselle) e a 36 m (24 caselle)
- [ ] Luce intensa e fioca, sorgenti fisse e torce collegate a pedine, con raggio e durata configurabili
- [ ] Il fog of war distingue inesplorato, esplorato ma non visibile, e attualmente visibile
- [ ] Il Game Master vede tutto e può passare all'anteprima dal punto di vista di un personaggio
- [ ] Su una mappa grande con molti muri l'interazione resta fluida

**Test obbligatori coperti**: intersezione dei raggi con i muri; visibilità
dietro gli angoli; porte aperte e chiuse; scurovisione a 18 e 36 metri.

---

## Milestone 4 — Attori e librerie

**Contenuto**: personaggi, mostri, cartelle, pedine, inventario, classi, armi,
incantesimi, campi personalizzati, import ed export JSON.

**Accettazione**
- [ ] Librerie separate per personaggi, mostri, oggetti, armi, incantesimi, effetti e scene
- [ ] Ogni elemento si organizza in cartelle
- [ ] Il Game Master crea un mostro da form, carica il token e lo salva nella cartella dei mostri
- [ ] Classi, capacità, armi, incantesimi e oggetti sono entità modificabili, non un elenco fisso
- [ ] Ogni attore ha i campi minimi previsti, più campi personalizzati
- [ ] Export e import JSON con schema versionato; una versione sconosciuta viene rifiutata

---

## Milestone 5 — Combattimento e movimento

**Contenuto**: iniziativa, round, turni, budget di movimento, diagonali, terreno
difficile, tipi di movimento, cronologia e autorizzazioni.

**Accettazione**
- [ ] Il tracker mostra iniziativa, round e turno corrente
- [ ] Trascinando una pedina si vedono anteprima del percorso, waypoint e distanza
- [ ] Le tre regole diagonali danno i costi attesi e sono configurabili
- [ ] Il movimento usato si azzera all'inizio del turno
- [ ] Superare il budget è impedito, a meno che il Game Master non autorizzi
- [ ] Terreno normale e difficile hanno costi distinti
- [ ] Prima di confermare si vedono costo previsto e residuo
- [ ] Camminare, volare, nuotare, scalare, scavare, saltare e movimenti personalizzati
- [ ] Il movimento si annulla e la cronologia del turno è consultabile
- [ ] Le collisioni con i muri sono rispettate

**Test obbligatori coperti**: percorso e costo del movimento.

---

## Milestone 6 — Azioni, aree ed effetti

**Contenuto**: risoluzione delle azioni, dadi, aree d'effetto, condizioni,
preset grafici, esplosioni, proiettili, effetti persistenti.

**Accettazione**
- [ ] Incantesimi, armi e capacità definiscono gittata, bersaglio, tiro per colpire, tiro salvezza, danno, tipo di danno, durata, risorse, condizioni, concentrazione, area ed effetto grafico
- [ ] Forme supportate: cerchio, cono, linea, quadrato, area personalizzata
- [ ] Il giocatore vede l'anteprima dell'area, la ruota o ridimensiona quando consentito, e conferma
- [ ] Il Game Master può modificare o annullare il risultato
- [ ] Gli effetti grafici usano preset parametrici: palla di fuoco e granata condividono "esplosione" con parametri diversi
- [ ] I tiri di dado sono verificabili e mostrati nel registro

---

## Milestone 7 — Consolidamento

**Contenuto**: sicurezza, prestazioni, accessibilità, backup, registro delle
azioni, test multiplayer, gestione errori, documentazione operativa.

**Accettazione**
- [ ] Revisione completa rispetto a `docs/SECURITY.md`, con le questioni aperte chiuse
- [ ] Obiettivi di prestazione della sezione 7 di `ARCHITECTURE.md` misurati e raggiunti
- [ ] Navigazione da tastiera e contrasto verificati sulle schermate principali
- [ ] Backup automatici con ripristino provato
- [ ] Registro delle azioni consultabile dal Game Master
- [ ] Sessione di prova con nove partecipanti collegati
- [ ] Gli errori mostrano messaggi utili, non stack trace
- [ ] Documentazione operativa: avvio, migrazioni, ripristino, rotazione delle chiavi

---

## Come si verifica una milestone

1. `pnpm lint` — nessun errore
2. `pnpm typecheck` — nessun errore
3. `pnpm test` — unitari e di integrazione verdi
4. `pnpm test:e2e` — flussi end-to-end verdi
5. `pnpm build` — build pulita
6. Percorso manuale sui criteri di accettazione della milestone
7. Aggiornamento di `README.md` con lo stato reale

Se un criterio non è verificabile, la milestone non è chiusa. Non si apre la
milestone successiva con una precedente parziale.
