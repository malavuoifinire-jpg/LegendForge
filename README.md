# LegendForge

Virtual tabletop web per sessioni di gioco di ruolo online: un Game Master e fino
a otto giocatori attorno alla stessa mappa, con griglia calibrata, campo visivo,
illuminazione, pedine e combattimento a turni.

> **Stato: Milestone 1 completa nel codice, in verifica in produzione.**
> Accesso con PIN e codice di recupero, campagne, caricamento mappe su storage
> privato, rilevamento della griglia, calibrazione manuale da due incroci,
> pedine agganciate dal server e persistenza verificata dopo il ricaricamento.
> 99 test automatici, di cui 41 di integrazione su PostgreSQL reale.

## Principi

- **Il server è l'autorità.** Permessi, proprietà delle pedine, movimento, turni e
  visibilità sono decisi dal server. Il client non riceve dati su mostri o
  elementi nascosti che il giocatore non è autorizzato a conoscere.
- **Il Game Master è l'autorità finale sulle regole** e può modificare o ignorare
  qualsiasi calcolo automatico.
- **Le regole sono dati, non codice.** Nessun valore di regola è scritto nel
  motore: tutto passa da un profilo di regole configurabile per campagna.
- **Motore, dati e contenuti restano separati.** Nel repository non entrano testi,
  immagini o statistiche presi da manuali commerciali. I contenuti precaricati
  sono originali o esplicitamente utilizzabili.

## Unità di misura

Una casella quadrata vale **1,5 metri** per impostazione predefinita, ed è un
valore configurabile per scena. Le distanze sono calcolate internamente in metri
e mostrate anche in caselle: 18 m corrispondono a 12 caselle, 36 m a 24.

## Stack

| Livello | Tecnologia |
|---|---|
| Frontend | React + TypeScript, renderer su canvas |
| API | Funzioni serverless su Vercel |
| Database | PostgreSQL su Supabase, migrazioni versionate |
| Storage | Supabase Storage (mappe e immagini delle pedine) |
| Tempo reale | Supabase Realtime |
| Autenticazione | PIN e link d'invito gestiti dall'applicazione, sessioni con cookie HttpOnly |

Monorepo TypeScript. Il codice di dominio è separato dal runtime, così resta
eseguibile anche fuori da Vercel.

## Milestone

| # | Contenuto | Stato |
|---|---|---|
| 0 | Architettura, modello dati, sistema di coordinate, threat model | completata |
| 1 | Mappa, canvas con zoom e pan, griglia, pedina, persistenza | completata |
| 2 | Campagne, inviti, PIN, permessi, sincronizzazione in tempo reale | da fare |
| 3 | Muri, porte, linea di vista, luci, oscurità, fog of war | da fare |
| 4 | Personaggi, mostri, oggetti, armi, incantesimi, librerie | da fare |
| 5 | Iniziativa, turni, budget di movimento, diagonali, terreno | da fare |
| 6 | Risoluzione delle azioni, dadi, aree d'effetto, effetti grafici | da fare |
| 7 | Sicurezza, prestazioni, accessibilità, backup, audit log | da fare |

## Sviluppo

```bash
npm install          # installa le dipendenze del monorepo
npm run dev          # solo interfaccia, con ricarica a caldo, su :5173
npm run start:local  # interfaccia e API insieme su :3000
npm run verify       # lint, tipi, test e build, come in integrazione continua
```

`npm run dev` avvia solo Vite: le chiamate all'API falliscono perché non c'è
nessuna funzione in ascolto. Per provare il flusso completo si usa
`npm run start:local`, che serve i file costruiti e monta il router sulla stessa
origine, esattamente come fa Vercel in produzione.

Variabili d'ambiente richieste dalle funzioni:

| Variabile | Uso |
|---|---|
| `DATABASE_URL` | stringa di connessione PostgreSQL, quella del pooler in modalità transazione |
| `DATABASE_SSL` | `require` (default), `insecure` per diagnosi temporanee, `disable` per un PostgreSQL locale |
| `SUPABASE_URL` | base del progetto Supabase, per lo storage delle mappe |
| `SUPABASE_SERVICE_ROLE_KEY` | chiave di servizio: resta sul server, non raggiunge mai il browser |
| `SUPABASE_STORAGE_BUCKET` | nome del bucket, default `legendforge-assets` |
| `MAX_UPLOAD_BYTES` | limite per file caricato, default 32 MB |

## Documentazione

La documentazione di progetto vive in `docs/`:

- `ARCHITECTURE.md` — decisioni architetturali e confini fra i domini
- `DOMAIN_MODEL.md` — entità, schema del database, sistema di coordinate
- `ROADMAP.md` — milestone e criteri di accettazione
- `SECURITY.md` — modello delle minacce e controlli

## Licenza

Progetto privato. Tutti i diritti riservati.
