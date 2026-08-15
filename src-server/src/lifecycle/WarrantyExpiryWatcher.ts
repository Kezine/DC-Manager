import { Logger } from "../logger.js";
import { Lifecycle } from "../../../src-shared/Lifecycle.js";

/* =============================================================================
   VEILLEUR DE GARANTIES — producteurs `warranty-expiring`/`warranty-expired` du
   service de notifications (cadrage garantie-alerte 2026-08-15, arbitré « reco
   + anti-bruit 1er boot » ; pattern CertExpiryWatcher). Balaye les équipements
   et sous-équipements porteurs d'une `warranty_end` — TOUS documents confondus
   (le PREMIER veilleur à lire les documents via DocumentStore : la source est
   un contrat de LECTURE réduit, rempli par le pont d'index.ts) — et signale les
   garanties proches de l'échéance ou dépassées.

   PALIERS — la frontière n'est JAMAIS re-dérivée ici : `Lifecycle.warrantyStatus`
   (src-shared/) est LA règle partagée avec l'affichage client (principe n°3) :
   - `warn` (J-0 à J-90 inclus, le jour de l'échéance couvre encore la journée)
     → `warranty-expiring`, gravité warning ;
   - `err` (dépassement STRICT)          → `warranty-expired`, gravité error ;
   - `ok` / null (vide, illisible)       → resolve (garantie prolongée/retirée :
     l'alerte éventuelle se clôt — le moteur notify n'envoie le « rétabli » que
     si l'alerte était réellement partie).

   🚨 UNE CLÉ PAR ÉQUIPEMENT (amendement au cadrage, décidé après mesure du
   moteur notify — remplace la clé à palier du § 4.4) :
   `warranty:<docId>:<collection>:<id>` — la gravité ET le type d'événement
   ESCALADENT sur la MÊME alerte (warn → err : le message est rafraîchi, jamais
   de resolve intermédiaire). Une clé PAR PALIER enverrait un « rétabli » du
   préavis au moment même où l'alerte d'expiration part (le resolve différentiel
   clôturerait la clé préavis disparue du balayage). Conséquence ASSUMÉE (parité
   exacte cert-expiry, une clé/sévérité croissante) : l'escalade ne déclenche PAS
   d'envoi immédiat — l'alerte est déjà active, seuls les RAPPELS portent le
   nouveau type/gravité (délai borné par l'intervalle de rappel).

   ANTI-BRUIT DU PREMIER BALAYAGE (décision § 4.6, alternative retenue) : la
   PREMIÈRE passe d'un document JAMAIS balayé lève ses alertes en SILENCIEUX
   (`raise(…, { silent: true })` — créées, actives, jamais remises ni rappelées,
   cf. NotifyEngine) : un parc ancien branché sur un serveur neuf n'inonde pas
   les abonnés de 200 expirations historiques. L'état « déjà balayé » est
   PERSISTANT (SweptState → lifecycle.db) : un redémarrage ne re-silence pas.
   Le drapeau est figé AU DÉBUT de la passe — les `markSwept` tombent en FIN de
   passe, donc toutes les alertes d'une même première passe sont silencieuses.

   ANTI-SPAM : AUCUN comptage ici (pattern cert-expiry) — `raise` est idempotent
   par passe, les rappels vivent ENTIÈREMENT dans le moteur notify. La gravité/le
   message sont rafraîchis à chaque passe (le prochain rappel porte le bon J-n).

   DISPARITIONS : un équipement supprimé (ou dont la garantie est vidée) sort du
   balayage — le veilleur mémorise les clés qu'il a levées et RESOLVE celles qui
   ont disparu de la passe courante. ⚠ Contrairement à cert-expiry, ce jeu est
   PERSISTANT (`RaisedState` → lifecycle.db, semé au constructeur, écrit aux
   seules transitions) : une suppression survenue SERVEUR ÉTEINT doit être
   résolue au premier scan post-boot — avec un jeu mémoire seul (reparti vide),
   l'alerte deviendrait un ZOMBIE rappelé toutes les 12 h à vie. Cert-expiry vit
   avec ce trou parce que ses routes DELETE/PUT résolvent au moment de l'action ;
   lifecycle n'a AUCUNE route, la persistance est son seul colmatage. (Une
   garantie PROLONGÉE pendant l'extinction n'a pas ce problème : l'item reste au
   balayage avec statut `ok` → resolve explicite.) Un DOCUMENT supprimé disparaît
   de `documentIds()` : ses clés levées se résolvent par le même différentiel, et
   son marqueur « balayé » est PURGÉ (`prune`) pour ne pas s'accumuler.

   Dépendance INVERSÉE (pattern CertExpiryWatcher/VmSyncService) : les interfaces
   du rapporteur, de la source et de l'état de balayage sont déclarées ICI, côté
   CONSOMMATEUR — lifecycle/ n'importe RIEN de notify/ ni de documents.ts,
   index.ts ponte par typage structurel. Les features restent amovibles
   indépendamment.
   ============================================================================= */

/** Ce que le veilleur exige du service de notifications (satisfait par NotifyModule via le
    pont du bootstrap — fire-and-forget, no-op si le module est inactif). L'option `silent`
    est l'extension générique du moteur (création silencieuse — cf. NotifyEngine.raise). */
export interface LifecycleProblemReporter {
  raise(key: string, event: { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id?: string | null }, opts?: { silent?: boolean }): void;
  resolve(key: string): void;
}

/** Ce que le veilleur lit des DOCUMENTS (rempli par le pont d'index.ts sur DocumentStore) :
    - `documentIds()` — TOUS les documents existants (pattern ContactSource) : nécessaire au-delà de
      `sweep()` car un document SANS garantie doit quand même être marqué « balayé » (si une garantie
      déjà expirée y apparaît plus tard, elle doit alerter NORMALEMENT — pas en silencieux) et la
      purge des marqueurs distingue « document supprimé » de « document sans échéance » ;
    - `sweep()` — les porteurs d'une `warranty_end` NON VIDE (equipments + subEquipments, tous
      documents), avec leur libellé d'affichage. */
export interface WarrantySource {
  documentIds(): string[];
  sweep(): Array<{ doc_id: string; collection: "equipments" | "subEquipments"; id: string; label: string; warranty_end: string }>;
}

/** État PERSISTANT « document déjà balayé » (satisfait par LifecycleDb — lifecycle.db) :
    c'est lui qui décide du SILENCIEUX de la première passe, d'où sa persistance (un
    redémarrage ne doit ni re-silencer un document déjà balayé, ni rater une expiration
    survenue serveur éteint — cf. LifecycleDb). */
export interface SweptState {
  isSwept(docId: string): boolean;
  markSwept(docId: string): void;
  /** Purge les marqueurs des documents qui n'existent plus (`docId ∉ knownDocIds`). */
  prune(knownDocIds: string[]): void;
}

/** Jeu PERSISTANT des clés LEVÉES par le veilleur (satisfait par LifecycleDb — lifecycle.db) :
    la mémoire du resolve DIFFÉRENTIEL. Persistant pour couvrir les disparitions survenues
    SERVEUR ÉTEINT (cf. en-tête § DISPARITIONS — sans lui, alerte zombie) : `all()` sème le
    jeu mémoire au constructeur, `add`/`remove` ne sont appelés qu'aux TRANSITIONS. */
export interface RaisedState {
  all(): string[];
  add(key: string): void;
  remove(key: string): void;
}

/** Bilan d'une passe (logs + tests) : `silent` = raises émis en silencieux (1er balayage). */
export interface WarrantyScanResult {
  raised: number;
  resolved: number;
  silent: number;
}

export class WarrantyExpiryWatcher {
  /** Clés levées — chemin CHAUD du resolve différentiel (équipement supprimé, garantie vidée,
      document supprimé entre deux passes). SEMÉ depuis l'état persistant au constructeur et
      MIROITÉ vers lui à chaque transition (cf. noteRaised/noteResolved) : le différentiel
      survit ainsi aux redémarrages — la base n'est jamais interrogée pendant un scan. */
  private readonly raisedKeys = new Set<string>();

  constructor(
    private readonly source: WarrantySource,
    private readonly reporter: LifecycleProblemReporter,
    private readonly swept: SweptState,
    /** Jeu persistant des clés levées (lifecycle.db) — semence + miroir du Set mémoire. */
    private readonly raised: RaisedState,
    /** Horloge injectée (tests : contrôlée). */
    private readonly clock: () => Date = () => new Date(),
    private readonly log: Logger = new Logger("error"),
  ) {
    // SEMENCE : les clés levées par le processus PRÉCÉDENT (avant redémarrage) redeviennent
    // candidates au différentiel — un item disparu pendant l'extinction sera résolu au 1er scan.
    for (const key of raised.all()) this.raisedKeys.add(key);
  }

  /** Clé STABLE de l'alerte de garantie d'UN équipement — UNE clé, PAS une par palier
      (amendement au § 4.4 du cadrage : l'escalade warn → err vit sur la même alerte). */
  static keyFor(docId: string, collection: "equipments" | "subEquipments", id: string): string {
    return "warranty:" + docId + ":" + collection + ":" + id;
  }

  /** Une passe de surveillance : raise/refresh les garanties sous seuil (silencieux si le
      document n'était pas encore balayé), resolve les autres (prolongées, retirées, disparues),
      puis marque les documents balayés et purge les marqueurs orphelins. Synchrone (lectures +
      arithmétique de dates) — le timer de LifecycleModule l'appelle, les tests directement. */
  scan(): WarrantyScanResult {
    const now = this.clock();
    // Photo AU DÉBUT de la passe : documents existants + ceux JAMAIS balayés (leurs alertes
    // partent en silencieux). Les markSwept tombent en FIN de passe — le drapeau ne bouge pas
    // en cours de route, toutes les alertes d'une même première passe sont donc silencieuses.
    const docIds = this.source.documentIds();
    const unsweptDocs = new Set(docIds.filter((id) => !this.swept.isSwept(id)));
    const seen = new Set<string>();
    let raised = 0;
    let resolved = 0;
    let silentCount = 0;

    for (const item of this.source.sweep()) {
      const key = WarrantyExpiryWatcher.keyFor(item.doc_id, item.collection, item.id);
      seen.add(key);
      // LA règle partagée (jamais re-dérivée) : ok/warn/err/null — cf. src-shared/Lifecycle.
      const status = Lifecycle.warrantyStatus(item.warranty_end, now);

      if (status !== "warn" && status !== "err") {
        // ok (échéance au-delà du préavis) ou null (date illisible) → rien à signaler.
        // resolve est no-op côté moteur si aucune alerte n'était ouverte — appel sans garde.
        this.reporter.resolve(key);
        this.noteResolved(key);
        resolved++;
        continue;
      }

      const silent = unsweptDocs.has(item.doc_id);
      this.reporter.raise(key, WarrantyExpiryWatcher.event(item, status, now), silent ? { silent: true } : undefined);
      this.noteRaised(key);
      raised++;
      if (silent) silentCount++;
    }

    // Clés levées qui ont DISPARU du balayage (équipement supprimé, garantie vidée, document
    // supprimé — y compris PENDANT L'EXTINCTION du serveur, grâce à la semence persistante) :
    // on les clôt — sinon le moteur rappellerait un problème sans objet.
    for (const key of [...this.raisedKeys]) {
      if (seen.has(key)) continue;
      this.reporter.resolve(key);
      this.noteResolved(key);
      resolved++;
    }

    // FIN de passe : les documents visités sont désormais BALAYÉS — y compris ceux SANS échéance
    // (une garantie déjà expirée qui y apparaît plus tard doit alerter normalement, le serveur
    // veillait) — et les marqueurs des documents supprimés sont purgés.
    for (const id of unsweptDocs) this.swept.markSwept(id);
    this.swept.prune(docIds);

    if (raised > 0) this.log.info("lifecycle: garanties signalées", raised + " échéance(s) sous seuil" + (silentCount > 0 ? " (dont " + silentCount + " en silencieux — premier balayage)" : ""));
    return { raised, resolved, silent: silentCount };
  }

  /** Transition « clé levée » : Set mémoire + MIROIR persistant — écrit SEULEMENT si la clé
      est nouvelle (un scan qui re-signale le même parc n'écrit rien en base). */
  private noteRaised(key: string): void {
    if (this.raisedKeys.has(key)) return;
    this.raisedKeys.add(key);
    this.raised.add(key);
  }

  /** Transition « clé clôturée » : miroir de noteRaised — n'écrit que si la clé était levée
      (le resolve « sans garde » des items hors seuil ne coûte aucune écriture). */
  private noteResolved(key: string): void {
    if (!this.raisedKeys.delete(key)) return;
    this.raised.remove(key);
  }

  /** Construit l'événement notify d'un palier (messages en français, style cert-expiry :
      date AAAA-MM-JJ lisible + durée en jours, collection lisible dans le corps). */
  private static event(
    item: { doc_id: string; collection: "equipments" | "subEquipments"; id: string; label: string; warranty_end: string },
    status: "warn" | "err",
    now: Date,
  ): { event_type: string; severity: "warning" | "error"; title: string; body: string; doc_id: string } {
    // Jamais null ici : `warrantyStatus` a validé la date et `now` (mêmes gardes internes).
    const days = Lifecycle.daysUntil(item.warranty_end, now) ?? 0;
    const dateLabel = item.warranty_end.slice(0, 10);   // AAAA-MM-JJ lisible (date à granularité jour)
    // Collection LISIBLE (avec l'article contracté correct) — le slug technique n'a rien à faire
    // dans un message destiné à un humain.
    const subject = item.collection === "subEquipments" ? "du sous-équipement" : "de l'équipement";
    if (status === "err") {
      return {
        event_type: "warranty-expired",
        severity: "error",
        title: "Garantie expirée — " + item.label,
        body: "La garantie " + subject + " « " + item.label + " » a expiré le " + dateLabel + " (depuis " + (-days) + " jour(s)).",
        doc_id: item.doc_id,
      };
    }
    return {
      event_type: "warranty-expiring",
      severity: "warning",
      title: "Échéance de garantie — " + item.label + " (J-" + days + ")",
      body: "La garantie " + subject + " « " + item.label + " » expire le " + dateLabel
        + (days === 0 ? " (aujourd'hui)." : " (dans " + days + " jour(s))."),
      doc_id: item.doc_id,
    };
  }
}
