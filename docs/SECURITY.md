# Sicurezza

Modello delle minacce e controlli. Il principio che guida tutto il documento è
uno solo: **il server decide, il client mostra**. Ogni volta che una scelta
poteva essere fatta nel browser per comodità, è stata spostata sul server.

## 1. Cosa stiamo proteggendo

| Bene | Perché conta | Chi lo minaccia |
|---|---|---|
| Informazioni nascoste della scena | Sono il contenuto del gioco. Un giocatore che legge le statistiche di un mostro nascosto o la sua posizione ha rovinato la sessione, e non è recuperabile. | Un partecipante legittimo, con gli strumenti per sviluppatori del browser |
| Controllo delle pedine | Muovere il personaggio di un altro giocatore, o un mostro | Un partecipante legittimo |
| Accesso alla campagna | Le campagne sono private | Chi trova o indovina un link d'invito |
| Mappe e immagini caricate | Materiale del Game Master, talvolta acquistato | Chiunque con l'URL di un file |
| Credenziali di servizio | Chiave di servizio Supabase, stringhe di connessione | Chiunque legga il bundle o il repository |
| Integrità dei dati di gioco | Perdere una campagna significa perdere mesi di gioco | Guasti, cancellazioni accidentali |

## 2. Modello dell'avversario

L'avversario realistico non è un attaccante esterno anonimo: è **un giocatore
invitato**. Ha credenziali valide, una sessione valida, e gli strumenti per
sviluppatori aperti. Sa quali chiamate fa l'applicazione e può ripeterle
cambiando i parametri.

Questo cambia il modo di progettare: nascondere qualcosa nella UI non è una
misura di sicurezza. Se il dato arriva al browser, è arrivato al giocatore.

## 3. Minacce e contromisure

### 3.1 Un giocatore legge dati che non dovrebbe

*Il rischio concreto:* la risposta dell'API contiene tutte le pedine della
scena, e il client nasconde quelle con `hidden: true`.

Controlli:

- Le proiezioni per il client sono costruite per ruolo nel livello dei casi
  d'uso. Un giocatore riceve una lista da cui le pedine nascoste **sono assenti**,
  non marcate.
- Lo stesso vale per statistiche degli attori, note del Game Master, muri e
  sorgenti di luce fuori dal campo visivo.
- Gli eventi in tempo reale sono pubblicati su canali distinti per ruolo, con
  payload già filtrati. Non vengono usate sottoscrizioni dirette alle tabelle.
- Test di integrazione dedicati: per ogni rotta che restituisce entità di scena,
  un test verifica che una sessione di giocatore non ottenga gli elementi
  nascosti, nemmeno chiedendoli per identificatore.

*Limite noto e accettato:* il campo visivo dinamico rivela comunque qualcosa. Se
un giocatore riceve la posizione di una pedina appena entra nel suo cono di
visione, un client modificato può registrare quel momento. È inerente al
meccanismo; la contromisura è non inviare nulla prima di quel momento.

### 3.2 Un giocatore muove pedine che non controlla

- La proprietà è verificata sul server a ogni mutazione, confrontando l'utente
  della sessione con `ActorOwnership` e con il ruolo nella campagna.
- L'identificatore della pedina arriva dal client ed è trattato come non
  affidabile: si risale sempre da pedina a scena a campagna, e si verifica
  l'appartenenza.
- Il Game Master può controllare qualsiasi pedina; è l'unico caso.

### 3.3 Accesso non autorizzato alla campagna

- I link d'invito contengono un token da almeno 256 bit generato con un
  generatore crittografico. Del token si salva solo l'hash.
- Gli inviti hanno scadenza, numero massimo di usi, e possono essere revocati e
  rigenerati. La revoca è immediata e c'è un test che lo verifica.
- Il PIN non è mai il solo segreto di accesso: serve il link d'invito per il
  primo ingresso e una sessione valida dopo. Un PIN da solo non apre nulla.
- I PIN sono salvati con Argon2id. Mai in chiaro, mai con hash veloci.
- Limitazione dei tentativi: per indirizzo IP e per account. Dopo una soglia,
  blocco temporaneo con ritardo crescente. Il blocco è per account, così non si
  può aggirare cambiando rete.
- I confronti dei segreti sono a tempo costante.

### 3.4 Furto o riuso di sessione

- Il token di sessione è opaco e casuale; nel database c'è solo il suo hash.
- Cookie `HttpOnly`, `Secure`, `SameSite=Lax`, ambito limitato al percorso
  dell'applicazione. `HttpOnly` esclude la lettura da JavaScript, quindi una
  eventuale XSS non porta via la sessione.
- Scadenza assoluta e scadenza per inattività. Rotazione del token al cambio di
  privilegi.
- Il Game Master può revocare le sessioni di un giocatore.
- Le mutazioni verificano l'origine della richiesta, oltre a `SameSite`.

### 3.5 Accesso ai file caricati

- Il bucket è privato. Nessun file è servito da un URL pubblico permanente.
- La lettura passa da URL firmati a scadenza breve, emessi solo dopo aver
  verificato l'appartenenza alla campagna.
- Il caricamento usa URL firmati a percorso deciso dal server: il client non
  sceglie dove scrivere.
- In finalizzazione il server rilegge il file e verifica i byte iniziali oltre
  al tipo dichiarato. Un file dichiarato PNG che non lo è viene rifiutato.
- Limiti su dimensione del file e dimensioni in pixel dell'immagine, per evitare
  che una decodifica esaurisca la memoria della funzione.
- I nomi originali non vengono usati come percorsi di storage.

### 3.6 Esposizione di credenziali

- La chiave di servizio Supabase e le stringhe di connessione vivono solo come
  variabili d'ambiente lato server e come segreti di GitHub Actions. Non sono mai
  incluse nel bundle del browser.
- Nel repository c'è `.gitignore` che esclude file di ambiente e chiavi, e la
  pipeline fallisce se un segreto compare in un file versionato.
- Solo la chiave pubblicabile raggiunge il client, e serve esclusivamente a
  sottoscrivere i canali in tempo reale — non a leggere tabelle (ADR-006).
- Rotazione: le chiavi si possono ruotare senza toccare il codice. La password
  del database va ruotata se compare in un canale non sicuro.

### 3.7 Difesa in profondità sul database

Anche se il client non accede direttamente al database, RLS resta attiva su
tutte le tabelle con negazione totale come default. È una rete di sicurezza: se
un giorno una chiave pubblicabile venisse usata per errore contro le tabelle,
non otterrebbe nulla.

### 3.8 Abuso di risorse

- Limitazione di frequenza per sessione e per campagna sulle rotte costose:
  caricamento file, rilevamento griglia, ricalcolo del campo visivo.
- Tetto ai muri e alle sorgenti di luce per scena, così da limitare il costo del
  calcolo di visibilità.
- Limiti di durata e memoria delle funzioni serverless configurati
  esplicitamente.

### 3.9 Contenuti di terze parti

Nel repository non entrano testi, immagini o dati provenienti da manuali
commerciali senza licenza esplicita. Il manuale fornito serve a capire il
comportamento delle regole; motore, dati e contenuti restano separati proprio
perché il contenuto possa essere sostituito senza toccare il motore. I dati
precaricati sono originali o esplicitamente utilizzabili.

## 4. Registro delle azioni

Vengono registrati: accessi riusciti e falliti, creazione e revoca di inviti,
cambi di ruolo, autorizzazioni del Game Master che scavalcano una regola,
cancellazioni. Il registro contiene chi, cosa, quando e su quale campagna. Non
contiene PIN, token o parti di essi.

## 5. Continuità

- Backup automatici del database, con verifica periodica del ripristino: un
  backup mai ripristinato non è un backup.
- Le cancellazioni di contenuti importanti sono logiche, con finestra di
  ripristino.
- Le migrazioni sono transazionali e registrate con checksum; ogni migrazione ha
  una procedura di ritorno documentata.

## 6. Cosa resta aperto

Questioni note, da chiudere nella milestone 7:

- Firma dei commit e verifica delle dipendenze nella pipeline.
- Politica di conservazione dei registri.
- Procedura di risposta in caso di compromissione di una chiave.
- Autorizzazione dei canali in tempo reale: va definita in milestone 2, quando
  il modello di sessione sarà completo. Fino ad allora il tempo reale non è
  attivo, e non ci si appoggia a nessuna soluzione provvisoria.
