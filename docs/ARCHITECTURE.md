# Architettura

Questo documento descrive la struttura del sistema, i confini fra i domini e le
decisioni prese, con le ragioni. È la milestone 0: nessuna riga di codice qui
descritta va considerata esistente finché non è accompagnata da test verdi.

## 1. Vincoli che determinano il progetto

| Vincolo | Conseguenza |
|---|---|
| Un Game Master e al massimo 8 giocatori per campagna | Nessun bisogno di sharding, code o microservizi. Un solo processo logico basta. |
| Il server è l'autorità su permessi, movimento, turni e visibilità | Ogni risposta è filtrata per ruolo prima di lasciare il server. Il client non è mai una fonte di verità. |
| Il client non deve ricevere dati che il giocatore non può conoscere | Il filtro avviene nella costruzione del DTO, non nella UI. Un giocatore non deve poter leggere un mostro nascosto nemmeno leggendo il traffico di rete. |
| Deploy su Vercel | Nessun processo sempre attivo, quindi nessun server WebSocket nostro. Limite di 4,5 MB sul corpo delle richieste. |
| Database e storage su Supabase | PostgreSQL gestito, storage compatibile S3, canali realtime. |
| Le regole devono essere configurabili | Nessuna costante di regola nel codice: tutto in un profilo per campagna. |
| Una casella = 1,5 m per impostazione predefinita | Le distanze sono calcolate in metri e mostrate anche in caselle. |
| Solo browser desktop nella prima versione | Nessun layout mobile, ma nessuna scelta che lo renda impossibile dopo. |

## 2. Topologia

```
   Browser (React + canvas)
      |                         \
      | HTTPS  /api/*            \  upload diretto con URL firmata
      v                           v
   Funzione Vercel            Supabase Storage
   (una sola, catch-all)        (bucket privato)
      |        ^
      |        |  broadcast filtrato per ruolo
      v        |
   PostgreSQL  +----- Supabase Realtime -----> Browser (sottoscrizione)
   (Supabase)
```

Tre osservazioni sul disegno:

- **Il browser non parla mai direttamente con il database.** Non usa la chiave
  `anon` per leggere tabelle. Tutte le letture e scritture passano dalla nostra
  API, che è l'unico punto in cui i permessi vengono applicati.
- **Le immagini fanno eccezione, ma solo in caricamento.** Il file viaggia dal
  browser a Supabase Storage con un URL firmato a tempo emesso dalla nostra API,
  perché 4,5 MB non bastano per una mappa. L'API autorizza prima, valida dopo.
- **Il realtime trasporta solo ciò che il destinatario può già vedere.** Il
  server pubblica su canali distinti per ruolo, con payload già filtrati.

## 3. Struttura del monorepo

```
legendforge/
  packages/
    core/          logica di dominio pura: coordinate, griglia, regole,
                   movimento, visibilità. Nessuna dipendenza da rete o database.
    contracts/     schemi zod condivisi fra client e server, versionati.
    api/           casi d'uso, accesso ai dati, autorizzazione. Indipendente
                   dal runtime: non conosce Vercel.
    db/            migrazioni SQL versionate e client PostgreSQL.
  apps/
    web/           applicazione React, renderer su canvas.
  api/
    [[...path]].ts unico punto di ingresso serverless: adatta la richiesta
                   Vercel al router di packages/api.
  docs/            questa documentazione.
  .github/workflows/  verifica e migrazioni.
```

La regola di dipendenza è unidirezionale:

```
core  <-  contracts  <-  api  <-  runtime (funzione Vercel)
                          ^
                       db  |
web  ->  contracts    ----+
```

`core` non importa niente. `api` non importa niente che sappia di HTTP. Il
runtime è sottile e sostituibile: se un giorno servisse un processo sempre
attivo per i WebSocket, si scrive un secondo adattatore senza toccare il
dominio.

## 4. Domini funzionali

Ogni dominio possiede le proprie tabelle, i propri casi d'uso e le proprie
regole di autorizzazione. Non esistono moduli installabili dagli utenti in
questa versione, ma i confini sono già quelli che servirebbero.

| Dominio | Responsabilità |
|---|---|
| `identity` | utenti, sessioni, PIN, codici di recupero |
| `campaigns` | campagne, iscrizioni, ruoli, inviti, profilo di regole |
| `assets` | file caricati, bucket, URL firmate, validazione immagini |
| `scenes` | scene, mappe, configurazione della griglia, rilevamento |
| `tokens` | pedine, posizione, proprietà, visibilità |
| `actors` | personaggi, mostri, oggetti, armi, incantesimi, cartelle |
| `vision` | muri, porte, luci, campo visivo, fog of war |
| `combat` | incontri, iniziativa, turni, movimento, cronologia |
| `actions` | risoluzione di azioni, dadi, aree d'effetto, condizioni |
| `effects` | preset grafici parametrici |
| `realtime` | pubblicazione degli eventi, filtrata per ruolo |

Milestone 1 tocca soltanto `assets`, `scenes`, `tokens` e la parte minima di
`identity` e `campaigns` necessaria a possedere una scena.

## 5. Decisioni architetturali

### ADR-001 — Monorepo TypeScript, nessun microservizio

Con al massimo nove partecipanti per campagna, separare i servizi aggiungerebbe
latenza, modi di fallire e lavoro operativo senza risolvere alcun problema
reale. Un monorepo con confini di pacchetto espliciti dà la stessa disciplina
senza il costo distribuito.

### ADR-002 — Un'unica funzione serverless catch-all

Tutte le rotte passano da `api/[[...path]].ts`, che delega a un router in
`packages/api`. Motivi: meno cold start, una sola configurazione di runtime, e
soprattutto il dominio resta un router puro che si può montare su qualsiasi
server. Il costo è che una funzione grande si scalda per tutte le rotte; con
questo volume di traffico è irrilevante.

### ADR-003 — Il dominio non conosce il runtime

`packages/api` espone casi d'uso che ricevono un contesto esplicito (utente,
campagna, ruolo, accesso al database) e restituiscono risultati tipizzati. Non
importa `Request`, `Response`, né alcun simbolo di Vercel. Questo rende i casi
d'uso testabili senza avviare un server e rende sostituibile l'hosting.

### ADR-004 — SQL diretto e migrazioni versionate, nessun ORM

Il modello ha bisogno di controllo fine su indici geometrici, aggiornamenti
condizionati dalla versione e proiezioni diverse per ruolo. Un ORM nasconderebbe
proprio le query che dobbiamo poter leggere e ottimizzare. Le migrazioni sono
file SQL numerati, applicati in transazione e registrati con checksum: modificare
una migrazione già applicata è un errore, non un aggiornamento silenzioso.

### ADR-005 — Autenticazione applicativa, non delegata

Il modello di accesso richiesto — il Game Master sceglie un PIN, riceve un
codice di recupero mostrato una sola volta, genera link d'invito ad alta
entropia, i giocatori scelgono nome e PIN al primo ingresso — non corrisponde a
un flusso email/OAuth. Implementiamo sessioni opache salvate in tabella,
consegnate con cookie `HttpOnly`, `Secure`, `SameSite=Lax`. Il PIN non è mai il
solo segreto: serve sempre anche il link d'invito o una sessione già stabilita.

### ADR-006 — Il client non usa le chiavi Supabase per accedere ai dati

La chiave `anon` finisce nel bundle ed è pubblica per definizione. Se i dati
fossero leggibili con quella chiave, la sicurezza dipenderebbe interamente dalle
policy RLS, cioè da regole scritte in SQL che è facile sbagliare e difficile
testare. Manteniamo invece un solo punto di applicazione dei permessi: la nostra
API, che parla al database con la chiave di servizio dal lato server. RLS resta
attiva come rete di sicurezza in profondità, con negazione totale come default.

### ADR-007 — Caricamento diretto a Storage con URL firmata

Il limite di 4,5 MB sul corpo delle funzioni Vercel esclude il passaggio del
file attraverso l'API. Il flusso è: l'API verifica il permesso e restituisce un
URL di caricamento firmato e a scadenza breve; il browser carica; l'API viene
richiamata per finalizzare, legge i metadati reali del file dallo storage,
verifica formato e dimensioni e solo allora crea la riga della mappa. Un file
caricato ma mai finalizzato resta orfano e viene raccolto.

### ADR-008 — Rilevamento della griglia deterministico e testabile

Il rilevamento lavora su funzioni pure che ricevono un'immagine in scala di
grigi e restituiscono passo, offset, rotazione e confidenza. Sono verificabili
con griglie sintetiche generate nei test, senza dipendere da immagini reali. La
decodifica dell'immagine è un adattatore separato. Il risultato è sempre una
proposta: la conferma è del Game Master, e una confidenza bassa non viene mai
accettata da sola.

### ADR-009 — Le coordinate persistite sono pixel dell'immagine

Una pedina sta su un punto della mappa, non su una casella. Se salvassimo la
casella, ricalibrare la griglia sposterebbe tutte le pedine. Salvando il punto
in pixel dell'immagine originale, la ricalibrazione cambia soltanto come le
caselle vengono disegnate sopra. Le coordinate di casella sono sempre derivate.

### ADR-010 — Canvas 2D nella milestone 1, WebGL valutato alla milestone 3

Mappa, griglia e pedine si disegnano bene con il contesto 2D, che costa meno
codice e si controlla meglio. Maschere di visibilità, luci e particelle
chiedono invece operazioni per pixel: la decisione su WebGL si prende alla
milestone 3, con in mano un profilo di prestazioni reale. Il renderer è dietro
un'interfaccia proprio per rendere possibile quel cambio.

### ADR-011 — Concorrenza ottimistica con colonna di versione

Ogni entità mutabile ha `version`. Gli aggiornamenti dichiarano la versione
letta; se non combacia, il server risponde 409 con lo stato corrente invece di
sovrascrivere. Con due client che muovono la stessa pedina questo è ciò che
distingue un conflitto visibile da una perdita silenziosa.

### ADR-012 — Le regole sono dati

Passo della casella, metri per casella, regola delle diagonali, moltiplicatore
del terreno difficile, raggi di scurovisione: tutto vive in un profilo di regole
salvato per campagna e validato da uno schema. Il codice legge il profilo, non
contiene i valori. Il Game Master può modificarli, e può comunque scavalcare
qualunque calcolo caso per caso.

### ADR-013 — Realtime come trasporto, non come fonte di verità

Il server pubblica eventi su canali distinti: uno per il Game Master e uno per
ogni giocatore. Ogni payload contiene solo ciò che quel destinatario è
autorizzato a vedere. Il client applica l'evento in modo ottimistico e, in caso
di dubbio o riconnessione, rilegge lo stato dall'API. Le sottoscrizioni dirette
alle modifiche delle tabelle non vengono usate: esporrebbero righe intere,
comprese quelle nascoste.

### ADR-014 — Le migrazioni le applica la pipeline, non una persona

Ogni modifica allo schema è un file nel repository, applicato da GitHub Actions
con le credenziali salvate come segreti. Nessuno incolla SQL a mano in una
finestra: ogni cambiamento è tracciabile, ripetibile e reversibile.

## 6. Flussi principali

### Caricamento di una mappa

1. Il Game Master sceglie un file PNG o JPEG.
2. Il client chiede all'API un URL di caricamento, dichiarando nome, tipo e
   dimensione.
3. L'API verifica che l'utente sia Game Master della campagna, che il tipo sia
   ammesso e che la dimensione rientri nel limite; emette un URL firmato a
   scadenza breve verso un percorso che decide il server.
4. Il browser carica il file direttamente su Storage.
5. Il client chiama la finalizzazione. L'API rilegge il file dallo storage,
   verifica i byte iniziali e i metadati reali dell'immagine, scrive la riga
   dell'asset e avvia il rilevamento della griglia.
6. Il rilevamento restituisce una proposta con confidenza. Viene salvata, mai
   applicata da sola.

### Calibrazione della griglia

L'immagine non viene toccata. Il Game Master vede la griglia sovrapposta in
tempo reale e può accettare la proposta o aprire il wizard: due incroci noti e
il numero di caselle che li separano, poi regolazioni fini di passo, offset e
rotazione. La conferma esplicita che una casella vale 1,5 m fa passare la scena
allo stato "confermata".

### Movimento di una pedina

Il client mostra un'anteprima immediata e chiede al server. Il server è
l'autorità: verifica la proprietà della pedina, l'eventuale collisione con i
muri, il budget di movimento nel turno, e restituisce la posizione accettata con
la nuova versione. Se il server rifiuta, il client torna alla posizione
precedente. Il Game Master può sempre autorizzare ciò che le regole vietano.

## 7. Prestazioni

I numeri che contano, con i limiti che ci diamo:

| Operazione | Obiettivo |
|---|---|
| Zoom e pan su mappa 8000×8000 | 60 fps |
| Ricalcolo del campo visivo su 2000 segmenti di muro | sotto i 16 ms |
| Rilevamento della griglia | sotto i 3 s su immagine ridimensionata |
| Latenza di propagazione di un movimento | sotto i 150 ms in condizioni normali |

Le tecniche previste: analisi dell'immagine su copia ridotta, riquadro di
ritaglio per disegnare solo ciò che è visibile, indice spaziale sui muri,
riuso delle maschere di visibilità finché la scena non cambia.

## 8. Esplicitamente fuori dalla prima versione

Griglie esagonali e isometriche, mappe con deformazione prospettica, sistema di
moduli installabili, supporto mobile completo, audio e video fra i partecipanti,
automazione completa delle regole di salto, livelli di altezza multipli (il
campo è previsto nel modello ma non usato).
