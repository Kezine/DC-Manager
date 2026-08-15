import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import type { SqliteCtor, SqliteDb } from "../db.js";

/* =============================================================================
   BASE DU MODULE lifecycle/ — `lifecycle.db` (à côté de registry.db, même
   dossier data injecté, même driver better-sqlite3 injecté que DocumentStore),
   pattern « module-possède-sa-base » (NotifyDb/CertsDb/InterventionsDb) :
   jamais une table de registry.db — supprimer la feature = supprimer le dossier
   lifecycle/ + ce fichier, le cœur n'en sait rien.

   DEUX tables, matérialisant les DEUX contrats d'état du veilleur :

   1. `swept_docs` — le contrat `SweptState` : « ce document a-t-il DÉJÀ été
   balayé par le veilleur de garanties ? ». C'est le marqueur de l'ANTI-BRUIT du
   premier balayage (cadrage garantie-alerte § 4.6) : la première passe d'un
   document jamais balayé lève ses alertes en SILENCIEUX (créées, jamais remises).
   POURQUOI cet état est PERSISTANT (et pas un simple Set mémoire) :
   - un REDÉMARRAGE ne doit pas RE-SILENCER un document déjà balayé — sinon
     chaque reboot avalerait les expirations survenues depuis la veille (le
     drapeau mémoire repartirait à « jamais vu », la passe au boot les lèverait
     toutes en silencieux : des alertes légitimes seraient perdues) ;
   - symétriquement, une expiration survenue SERVEUR ÉTEINT doit sonner au boot
     suivant comme si le serveur avait veillé : le document EST balayé (marqueur
     en base), la nouvelle expiration part donc en alerte NORMALE.
   `first_swept_at` trace la date du premier balayage (diagnostic — « depuis
   quand ce document est-il surveillé ? ») ; il n'est jamais réécrit.

   2. `raised_keys` — le contrat `RaisedState` : les clés d'alerte LEVÉES par le
   veilleur (le jeu du resolve DIFFÉRENTIEL). POURQUOI cette table existe : un
   équipement SUPPRIMÉ (ou une garantie VIDÉE — l'item sort du sweep) PENDANT QUE
   LE SERVEUR EST ÉTEINT disparaît du balayage AVANT le premier scan post-boot ;
   avec un jeu mémoire seul (reparti vide), le différentiel ne verrait RIEN à
   résoudre → alerte ZOMBIE rappelée toutes les 12 h à vie. Cert-expiry a le même
   trou mémoire mais ses routes DELETE/PUT résolvent au moment de l'action (cf.
   en-tête de CertExpiryWatcher) ; lifecycle n'a AUCUNE route — la persistance
   est son SEUL colmatage. Le Set mémoire du veilleur reste le chemin chaud du
   scan ; cette table n'est écrite qu'aux TRANSITIONS (levée/clôture) et relue à
   la construction (semence du jeu mémoire).
   ============================================================================= */

/** Nom de la base dédiée au module, DANS le dossier injecté (à côté de registry.db). */
export const LIFECYCLE_DB_FILE = "lifecycle.db";

export class LifecycleDb {
  private readonly db: SqliteDb;

  /** @param dir  Dossier de la base (le MÊME que registry.db — injecté, jamais dérivé ici).
      @param Database  Constructeur SQLite INJECTÉ (better-sqlite3 en prod, réel en test).
      @param log  Journalisation. */
  constructor(
    dir: string,
    Database: SqliteCtor,
    private readonly log: Logger = new Logger("error"),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, LIFECYCLE_DB_FILE));
    // Réglages de parité DocumentStore/NotifyDb/CertsDb (WAL + timeout anti-BUSY + synchronous NORMAL).
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swept_docs (
        doc_id         TEXT PRIMARY KEY,
        first_swept_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raised_keys (
        key TEXT PRIMARY KEY
      );
    `);
    this.log.info("lifecycle: base ouverte", path.join(dir, LIFECYCLE_DB_FILE));
  }

  close(): void { this.db.close(); }

  /* --------------------------------------------------------------------------
     SweptState (contrat du veilleur — cf. WarrantyExpiryWatcher)
     -------------------------------------------------------------------------- */

  /** Le document a-t-il déjà été balayé par le veilleur ? */
  isSwept(docId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM swept_docs WHERE doc_id = ?").get(docId) !== undefined;
  }

  /** Marque un document comme balayé. IDEMPOTENT : `first_swept_at` n'est posé qu'à la
      PREMIÈRE fois (OR IGNORE) — c'est la date du premier balayage, jamais réécrite. */
  markSwept(docId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO swept_docs (doc_id, first_swept_at) VALUES (?, ?)")
      .run(docId, new Date().toISOString());
  }

  /** Purge les marqueurs des documents SUPPRIMÉS (absents de `knownDocIds`) — sans elle, les
      marqueurs s'accumuleraient au fil des suppressions de documents (déchet inerte, mais un
      document RECRÉÉ sous le même id hériterait à tort d'un « déjà balayé »). */
  prune(knownDocIds: string[]): void {
    if (knownDocIds.length === 0) {
      // Plus aucun document connu → plus aucun marqueur légitime.
      this.db.prepare("DELETE FROM swept_docs").run();
      return;
    }
    // Placeholders dynamiques (liste courte — un parc de documents se compte en unités).
    const placeholders = knownDocIds.map(() => "?").join(",");
    this.db.prepare("DELETE FROM swept_docs WHERE doc_id NOT IN (" + placeholders + ")").run(...knownDocIds);
  }

  /* --------------------------------------------------------------------------
     RaisedState (contrat du veilleur — jeu PERSISTANT du resolve différentiel,
     cf. en-tête § 2 : sans lui, une suppression pendant l'extinction du serveur
     laisserait une alerte zombie)
     -------------------------------------------------------------------------- */

  /** Toutes les clés levées connues — relues À LA CONSTRUCTION du veilleur (semence du
      jeu mémoire : le différentiel couvre ainsi les disparitions survenues serveur éteint). */
  all(): string[] {
    return (this.db.prepare("SELECT key FROM raised_keys").all() as any[]).map((r) => String(r.key));
  }

  /** Mémorise une clé levée. IDEMPOTENT (OR IGNORE) — appelé aux seules TRANSITIONS
      (le veilleur filtre sur son Set mémoire, la base n'est pas écrite à chaque scan). */
  add(key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO raised_keys (key) VALUES (?)").run(key);
  }

  /** Oublie une clé clôturée (l'alerte est résolue — plus rien à résoudre au prochain boot). */
  remove(key: string): void {
    this.db.prepare("DELETE FROM raised_keys WHERE key = ?").run(key);
  }
}
