import { randomUUID } from "node:crypto";
import type { DocumentStore } from "../documents.js";
import { Logger } from "../logger.js";
import { DataValidator, type ValidationError } from "../../../src-shared/DataValidation.js";
import { Changeset } from "../../../src-shared/DocumentChangeset.js";
import type { ProviderConfig, ProviderConfigSource, VmProviderAdapter, VmClusterInfo } from "./VmProvider.js";
import { PveHttpError } from "./PveHttp.js";
import { ProxmoxAdapter } from "./ProxmoxAdapter.js";
import { VmReconcile } from "./VmReconcile.js";

/* =============================================================================
   MOTEUR DE SYNCHRO VM — module `vm/` amovible. Exécute une synchronisation
   par couple document × provider : adaptateur (inventaire) → réconciliation
   (VmReconcile, pur) → écriture TRANSACTIONNELLE dans le document + événement
   SSE (les clients rechargent la collection `vms` en granulaire, comme pour
   n'importe quelle écriture HTTP — rien de spécifique côté client).

   AUTORITÉ SERVEUR : tout enregistrement écrit passe par la même validation
   partagée que /transact (DataValidator) — un provider défaillant/malveillant
   ne peut pas injecter de données invalides dans le document.

   Concurrence : le Repository (better-sqlite3) est SYNCHRONE et Node
   mono-thread — la séquence relecture → fusion patch → transact s'exécute
   sans écriture intercalée. La relecture au moment d'écrire (plutôt que le
   snapshot du plan) minimise la fenêtre d'écrasement d'une édition locale
   concurrente : seuls les champs du patch (champs SOURCE) sont posés.

   Pas d'Express ici : les routes vivent dans VmModule.ts. Le bus live est vu
   par une interface minimale (VmLivePublisher) — LiveBus la satisfait, un stub
   de test aussi (ce fichier reste compilable/testable sans les types Express).
   ============================================================================= */

/** Ce que le moteur exige du bus live (publication seule — jamais d'abonnement ici). */
export interface VmLivePublisher {
  publish(docId: string, data: unknown): void;
}

/** CONSOMMATEUR de signalement de problèmes persistants — DÉPENDANCE INVERSÉE (même pattern que
    VmLivePublisher). Le service `vm/` déclare ICI le contrat MINIMAL qu'il attend d'un module de
    notifications, mais n'importe RIEN de `notify/` : les deux features restent amovibles
    indépendamment. C'est index.ts qui PONTE (typage STRUCTUREL) le NotifyModule vers cette interface
    au bootstrap. `raise`/`resolve` sont fire-and-forget : le moteur notify gère TOUT l'anti-spam
    (déduplication par clé, rappels espacés) — le producteur ne fait AUCUN comptage. */
export interface ProblemReporter {
  raise(key: string, event: { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id?: string | null }): void;
  resolve(key: string): void;
}

export interface VmSyncCounts { created: number; updated: number; orphaned: number; unchanged: number }

/** État de synchro d'UN provider d'UN document — matière de GET /documents/:docId/vm/status.
    En mémoire uniquement (reperdu au redémarrage — assumé : c'est un état opérationnel, pas une donnée).
    ⚠ DUPLICATION assumée : le client porte un MIROIR de ce DTO réseau dans
    `src-client/views/forms/VmSyncClient.ts` (module amovible ne partageant pas de source avec le
    serveur pour un simple contrat d'affichage) — toute évolution ici doit y être répercutée. */
export interface VmProviderStatus {
  provider_id: string;
  kind: string;
  /** Période de synchro automatique (0 = manuelle) — reprise de la config (affichage UI). */
  interval_sec: number;
  /** Dernière TENTATIVE (ISO). null = jamais synchronisé depuis le démarrage. */
  last_attempt: string | null;
  /** Dernière synchro RÉUSSIE (ISO) — conservée quand une tentative ultérieure échoue. */
  last_success: string | null;
  ok: boolean;
  /** Résumé lisible (compteurs) ou message d'erreur — JAMAIS le jeton (garanti par PveHttp/ConfigStore). */
  message: string;
  counts: VmSyncCounts | null;
  /** DERNIER état connu du cluster (vue « Clusters », cadrage 2026-07-13) : nœuds + métriques,
      quorum, version — capturé à chaque inventaire réussi, CONSERVÉ à travers les échecs
      ultérieurs (comme last_success). null = jamais synchronisé depuis le démarrage. */
  cluster: VmClusterInfo | null;
}

export class VmSyncService {
  /** Délai MINIMAL par défaut entre DEUX passes d'un même couple document×provider
      (anti-rafale, exigence 2026-07-13) : Node sérialise les requêtes, mais deux POST
      /vm/sync quasi simultanés déclencheraient deux passes SUCCESSIVES — la seconde,
      lancée après la fin de la première, referait tout l'inventaire pour rien. Sous ce
      délai, l'appelant reçoit le dernier statut (annoté) au lieu d'une nouvelle passe. */
  static readonly DEFAULT_MIN_INTERVAL_SEC = 10;

  /** docId → providerId → dernier état connu. */
  private readonly status = new Map<string, Map<string, VmProviderStatus>>();
  /** Couples document×provider EN COURS (anti-chevauchement timer ↔ synchro manuelle). */
  private readonly running = new Set<string>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly docs: DocumentStore,
    private readonly live: VmLivePublisher,
    // SOURCE de config vue par CONTRAT (ProviderConfigSource) : fichier legacy (ProviderConfigStore)
    // OU base chiffrée (ProviderConfigDb) — le moteur ignore le support de stockage.
    private readonly providers: ProviderConfigSource,
    private readonly log: Logger = new Logger("error"),
    /** Fabrique d'adaptateur INJECTÉE (stub en test). Défaut : par `kind` de la config. */
    private readonly makeAdapter: (config: ProviderConfig) => VmProviderAdapter = VmSyncService.adapterFor,
    /** Délai minimal entre deux passes (secondes) — injectable (0 en test). S'applique aussi
        aux timers : un `interval_sec` inférieur est de fait plafonné par ce délai. */
    private readonly minIntervalSec: number = VmSyncService.DEFAULT_MIN_INTERVAL_SEC,
    /** Rapporteur de problèmes persistants au module notifications (S4) — OPTIONNEL, injecté au
        bootstrap par typage structurel (cf. ProblemReporter). undefined = feature notify absente ou
        inactive → aucun signalement. DERNIER paramètre : les constructions existantes (tests inclus)
        restent valides sans le fournir. */
    private readonly problems?: ProblemReporter,
  ) {}

  /** Fabrique standard : un adaptateur par famille de provider. Un `kind` inconnu échoue à la
      SYNCHRO (statut en erreur pour CE provider), pas au chargement — les autres providers vivent. */
  static adapterFor(config: ProviderConfig): VmProviderAdapter {
    if (config.kind === "proxmox") return ProxmoxAdapter.fromConfig(config);
    throw new Error("type de provider inconnu : « " + config.kind + " » (supportés : proxmox)");
  }

  /** Synchronise TOUS les providers d'un document (bouton « Synchroniser », séquentiel :
      volumes faibles, et un échec n'empêche pas les suivants). */
  async syncDocument(docId: string): Promise<VmProviderStatus[]> {
    const results: VmProviderStatus[] = [];
    for (const config of this.providers.providersFor(docId)) results.push(await this.syncProvider(docId, config));
    return results;
  }

  /** État courant des providers d'un document — les jamais-synchronisés apparaissent aussi
      (fusion config déclarée × état runtime), pour que l'UI liste ce qui est configuré. */
  statusFor(docId: string): VmProviderStatus[] {
    const runtime = this.status.get(docId);
    return this.providers.providersFor(docId).map((config) =>
      (runtime && runtime.get(config.id)) || {
        provider_id: config.id, kind: config.kind, interval_sec: config.interval_sec,
        last_attempt: null, last_success: null, ok: true, message: "jamais synchronisé depuis le démarrage", counts: null, cluster: null,
      });
  }

  /** Arme les synchros PÉRIODIQUES (interval_sec > 0) pour chaque couple document×provider.
      La config est lue à l'appel (pas de snapshot) : `rearmTimers()` la relit après chaque
      écriture CRUD (rechargement à chaud). `unref()` : les timers ne retiennent pas le process
      (l'arrêt propre reste immédiat). */
  startTimers(): void {
    for (const docId of this.providers.configuredDocIds()) {
      for (const config of this.providers.providersFor(docId)) {
        if (config.interval_sec <= 0) continue;
        const timer = setInterval(() => {
          void this.syncProvider(docId, config).catch((e) =>
            this.log.error("synchro périodique : échec inattendu", docId, config.id, e instanceof Error ? e.message : String(e)));
        }, config.interval_sec * 1000);
        // `unref` n'existe que sur le Timeout Node (pas dans le type DOM du build de test mixte) — cast assumé.
        (timer as any).unref?.();
        this.timers.push(timer);
        this.log.info("synchro périodique armée", docId, config.id, config.interval_sec + "s");
      }
    }
  }

  stopTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** RÉ-ARME les timers périodiques : arrête les timers courants puis les redémarre selon la
      config ACTUELLE. POURQUOI : depuis l'UI de configuration (P2), la config des providers change
      À CHAUD (CRUD sur ProviderConfigDb) — ajout/retrait d'un provider, ou modification d'un
      `interval_sec`. Sans ce ré-armement, le changement ne prendrait effet qu'au prochain
      redémarrage. Appelé après CHAQUE écriture CRUD (idempotent : stop puis start relisent la source). */
  rearmTimers(): void {
    this.stopTimers();
    this.startTimers();
  }

  /** Synchronise UN provider d'UN document. Ne JETTE jamais : tout aboutit à un statut
      (ok ou erreur) — le document garde son état précédent en cas d'échec (contrat adaptateur). */
  async syncProvider(docId: string, config: ProviderConfig): Promise<VmProviderStatus> {
    const key = docId + "\u0000" + config.id;
    if (this.running.has(key)) {
      // Chevauchement (timer + manuel, ou cluster lent) : on ne double pas la synchro en cours.
      const current = this.status.get(docId) && this.status.get(docId)!.get(config.id);
      return current || this.record(docId, config, { ok: true, message: "synchronisation déjà en cours", attemptIso: null });
    }
    // ANTI-RAFALE (exigence 2026-07-13) : sous le délai minimal depuis la dernière TENTATIVE,
    // on rend le dernier statut (annoté, SANS le stocker — le statut persistant reste le vrai
    // résultat) au lieu de relancer une passe complète. Node sérialise les requêtes, mais deux
    // POST /vm/sync quasi simultanés seraient sinon exécutés SUCCESSIVEMENT, en double.
    const prior = this.status.get(docId) && this.status.get(docId)!.get(config.id);
    if (prior && prior.last_attempt !== null && this.minIntervalSec > 0) {
      const elapsedMs = Date.now() - Date.parse(prior.last_attempt);
      if (elapsedMs >= 0 && elapsedMs < this.minIntervalSec * 1000) {
        this.log.info("synchro ignorée (anti-rafale)", docId, config.id, Math.round(elapsedMs / 1000) + "s écoulées, minimum " + this.minIntervalSec + "s");
        return { ...prior, message: prior.message + " · relance ignorée (dernière synchro il y a " + Math.round(elapsedMs / 1000) + " s, délai minimal " + this.minIntervalSec + " s)" };
      }
    }
    this.running.add(key);
    try {
      const status = await this.doSync(docId, config);
      // SIGNALEMENT au module notifications (S4) — on est ICI APRÈS les sorties ANTICIPÉES
      // (« déjà en cours », anti-rafale) : celles-ci ne synchronisent RIEN, donc ne signalent rien.
      // Clé STABLE par couple document×provider : le moteur notify déduplique dessus (une seule
      // alerte tant que le problème persiste, rappels espacés selon ses réglages). POURQUOI raise à
      // CHAQUE passe en échec (sans aucun comptage ici) : l'idempotence/anti-spam est ENTIÈREMENT au
      // moteur — le producteur ne fait que refléter l'état COURANT (échec → raise, succès → resolve,
      // ce dernier clôturant une alerte antérieure = retour à la normale notifié).
      const problemKey = "vm-sync:" + docId + ":" + config.id;
      if (status.ok) this.problems?.resolve(problemKey);
      else this.problems?.raise(problemKey, {
        event_type: "vm-sync-failure",
        severity: "error",
        title: "Synchro VM en échec — " + config.id,
        body: status.message,   // résumé lisible SANS jeton (garanti par PveHttp/ConfigStore, cf. VmProviderStatus.message)
        doc_id: docId,
      });
      return status;
    } finally {
      this.running.delete(key);
    }
  }

  /* --------------------------------------------------------------------------
     Cœur d'une passe de synchro
     -------------------------------------------------------------------------- */

  private async doSync(docId: string, config: ProviderConfig): Promise<VmProviderStatus> {
    const nowIso = new Date().toISOString();
    const repo = this.docs.repo(docId);
    if (!repo) return this.record(docId, config, { ok: false, message: "document inconnu", attemptIso: nowIso });

    // TRAÇAGE (demande 2026-07-13) : chaque étape de la passe est journalisée — démarrage,
    // volume d'inventaire, plan d'opérations, écriture — pour suivre une synchro de bout en
    // bout dans les logs serveur même quand elle « réussit » avec un résultat suspect.
    this.log.info("synchro démarrée", docId, config.id, config.endpoints.length + " endpoint(s), timeout " + config.timeout_sec + "s");

    // 1) Inventaire provider. Échec → statut en erreur, document INTACT (état précédent conservé).
    let records;
    let cluster: VmClusterInfo | null = null;
    try {
      const inventory = await this.makeAdapter(config).inventory();
      records = inventory.vms;
      // CAPTURE de l'état du cluster (vue « Clusters », décision 2026-07-13 : MÉMOIRE serveur) :
      // produit dans la même passe, il accompagne le statut. Sur échec d'inventaire, `record`
      // conserve le DERNIER état connu (comme last_success) — la vue affiche du vieux plutôt que rien.
      cluster = inventory.cluster;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("synchro : inventaire en échec", docId, config.id, message);
      // PILE COMPLÈTE au log (jamais dans le statut/toast — elle reste côté serveur) : le
      // `message` seul est inexploitable pour certaines erreurs (ERR_INTERNAL_ASSERTION de
      // Node ne dit QUE « open an issue » — la pile est le seul indice de l'origine réelle).
      this.log.warn("synchro : pile d'erreur\n" + VmSyncService.stackOf(e));
      return this.record(docId, config, { ok: false, message, attemptIso: nowIso });
    }

    // 2) Réconciliation PURE contre les vms de CETTE instance (périmètre multi-clusters).
    //    RAPPROCHEMENT D'HÔTE v3 (décision utilisateur 2026-07-14, cas réel « srv37 » ; cf.
    //    docs/vm-proxmox.md « Champ dérivé ») — hiérarchie à 3 niveaux évaluée dans l'ordre. À
    //    CHAQUE niveau : candidat UNIQUE → résolu ; PLUSIEURS → ambigu → null (on ne devine pas,
    //    on NE DESCEND PAS au niveau suivant) ; ZÉRO → niveau suivant.
    //      1) PRIORITAIRE — hostnames des adresses IP RATTACHÉES à un équipement (l'utilisateur
    //         encode le FQDN dans le hostname des IP) : hostname COMPLET égal OU premier label égal
    //         (insensible à la casse, trimé). TOUTES les IP d'un équipement comptent ; plusieurs IP
    //         du MÊME équipement = UN candidat (dédup par équipement, via Set).
    //      2) nom d'équipement EXACT — désormais INSENSIBLE À LA CASSE et trimé (l'ancien findBy SQL
    //         était sensible à la casse : c'était le bug du cas « srv37 »).
    //      3) premier label du FQDN du nom d'équipement (« srv1.int.exemple.com » → « srv1 »).
    //    Index construit PARESSEUSEMENT (au premier nœud à résoudre) puis mémoïsé pour la passe : un
    //    SEUL balayage des équipements + un des adresses IP, quel que soit le nombre de nœuds.
    let hostIndex: { byIpHost: Map<string, Set<string>>; byNameExact: Map<string, Set<string>>; byNameLabel: Map<string, Set<string>> } | null = null;
    const buildHostIndex = () => {
      if (hostIndex) return hostIndex;
      const byIpHost = new Map<string, Set<string>>();      // niveau 1 : hostname d'IP (COMPLET et 1er label) → equipment_id
      const byNameExact = new Map<string, Set<string>>();   // niveau 2 : nom d'équipement (lower, trim) → id
      const byNameLabel = new Map<string, Set<string>>();   // niveau 3 : 1er label du FQDN du nom → id
      const add = (map: Map<string, Set<string>>, key: string, id: string) => {
        if (!key) return;
        const set = map.get(key); if (set) set.add(id); else map.set(key, new Set([id]));
      };
      for (const equipment of repo.list("equipments", { pageSize: 100000 }).rows) {
        const name = (typeof equipment.name === "string" ? equipment.name : "").trim().toLowerCase();
        if (!name) continue;
        add(byNameExact, name, equipment.id);
        if (name.includes(".")) add(byNameLabel, name.split(".")[0], equipment.id);   // pas un FQDN → seul le niveau 2 le trouve
      }
      for (const ip of repo.list("ipAddresses", { pageSize: 100000 }).rows) {
        if (!ip.equipment_id) continue;   // niveau 1 = IP RATTACHÉE à un équipement (champ equipment_id posé)
        const host = (typeof ip.hostname === "string" ? ip.hostname : "").trim().toLowerCase();
        if (!host) continue;
        add(byIpHost, host, ip.equipment_id);                  // hostname COMPLET
        add(byIpHost, host.split(".")[0], ip.equipment_id);    // + PREMIER LABEL (dédup par équipement : même Set)
      }
      return (hostIndex = { byIpHost, byNameExact, byNameLabel });
    };
    const hostByNode = new Map<string, string | null>();
    const resolveHost = (node: string): string | null => {
      if (hostByNode.has(node)) return hostByNode.get(node)!;
      const key = node.trim().toLowerCase();
      const index = buildHostIndex();
      const levels: Array<[string, Map<string, Set<string>>]> = [
        ["ip-hostname", index.byIpHost],
        ["nom-exact", index.byNameExact],
        ["nom-1er-label", index.byNameLabel],
      ];
      let resolved: string | null = null;
      let decided = false;   // vrai dès qu'un niveau tranche (résolu OU ambigu) — pour ne PAS logger « aucun niveau » à tort.
      for (const [level, map] of levels) {
        const candidates = map.get(key);
        if (!candidates || candidates.size === 0) continue;   // ZÉRO → niveau suivant
        decided = true;
        if (candidates.size === 1) {                          // UNIQUE → résolu
          resolved = [...candidates][0];
          // TRAÇAGE (demande 2026-07-14) : niveau de résolution RETENU par nœud — aide au diagnostic (« pourquoi ce nœud »).
          this.log.info("synchro : hôte résolu (niveau " + level + ")", docId, config.id, node + " → " + resolved);
        } else {
          // PLUSIEURS → ambigu : on NE DESCEND PAS au niveau suivant (on ne devine pas quelle machine).
          this.log.info("synchro : hôte ambigu (niveau " + level + ", non résolu)", docId, config.id, node + " → " + candidates.size + " équipements");
        }
        break;
      }
      if (!decided) this.log.info("synchro : hôte non résolu (aucun niveau ne correspond)", docId, config.id, node);
      hostByNode.set(node, resolved);
      return resolved;
    };
    const existingVms = repo.findBy("vms", "provider_id", config.id);
    this.log.info("synchro : inventaire reçu", docId, config.id, records.length + " VM(s) remontée(s), " + existingVms.length + " dans le document");
    const ops = VmReconcile.plan({
      providerId: config.id,
      records,
      existingVms,
      resolveHostEquipmentId: resolveHost,
      newId: () => randomUUID(),
      nowIso,
    });
    const counts: VmSyncCounts = { created: ops.creates.length, updated: ops.updates.length, orphaned: ops.orphans.length, unchanged: ops.unchanged };
    this.log.info("synchro : plan d'opérations", docId, config.id, VmSyncService.summary(counts));

    // INVENTAIRE VIDE = suspect et EXPLICITE pour l'utilisateur (constat 2026-07-13) : le piège
    // classique est la SÉPARATION DE PRIVILÈGES des jetons Proxmox — l'utilisateur a le rôle,
    // mais le jeton (privsep=1, défaut) n'hérite de RIEN et l'API renvoie une liste vide SANS
    // erreur. On le dit dans le statut (visible dans l'UI) au lieu d'un « 0 créée » sibyllin.
    const emptyHint = records.length === 0
      ? "AUCUNE VM remontée par le provider — si le cluster en contient, vérifiez les permissions du JETON : "
        + "avec la séparation de privilèges Proxmox (défaut), le jeton doit porter LUI-MÊME le rôle PVEAuditor "
        + "(pveum acl modify / --tokens '<user>!<tokenid>' --roles PVEAuditor --propagate 1) · "
      : "";

    // 3) Rien à écrire → AUCUNE révision consommée, aucun événement SSE (idempotence de bout en bout).
    if (!ops.creates.length && !ops.updates.length && !ops.orphans.length) {
      return this.record(docId, config, { ok: true, message: emptyHint + VmSyncService.summary(counts), attemptIso: nowIso, successIso: nowIso, counts, cluster });
    }

    // 4) Patchs → enregistrements COMPLETS (le Repository remplace la ligne entière) : relecture au
    //    moment d'écrire — une vm supprimée entre le plan et l'écriture n'est PAS ressuscitée.
    const updates: { collection: string; record: Record<string, any> }[] = [];
    for (const op of [...ops.updates, ...ops.orphans]) {
      const current = repo.getOne("vms", op.id);
      if (!current) continue;
      updates.push({ collection: "vms", record: { ...current, ...op.patch, updated_date: nowIso } });
    }
    const creates = ops.creates.map((record) => ({ collection: "vms", record }));

    // 5) AUTORITÉ SERVEUR : normalisation + validation partagées (même discipline que /transact).
    const fetch = (collection: string, id: string) => repo.getOne(collection, id);
    const find = (collection: string, field: string, value: any) => repo.findBy(collection, field, String(value));
    const errors: ValidationError[] = [];
    for (const entry of [...creates, ...updates]) {
      const result = DataValidator.normalizeAndValidate("vms", entry.record, fetch, find);
      errors.push(...result.errors);
      entry.record = result.record;
    }
    if (errors.length) {
      // Données de provider irrecevables : on n'écrit RIEN (pas d'écriture partielle) — message
      // détaillé au log, résumé au statut. Jamais le jeton (les messages de validation citent les champs).
      const detail = errors.slice(0, 3).map((e) => e.path + " : " + e.message).join(" · ");
      this.log.warn("synchro : données invalides, écriture refusée", docId, config.id, detail, "(" + errors.length + " erreur(s))");
      return this.record(docId, config, { ok: false, message: "données de synchro invalides — " + detail, attemptIso: nowIso, cluster });
    }

    // 6) Écriture transactionnelle + révision + SSE — le même triptyque que la couche HTTP
    //    (les autres clients rechargent `vms` en granulaire via leur ReloadPlanner).
    try {
      const rev = this.docs.markChanged(docId);
      repo.transact({ creates, updates }, rev);
      this.live.publish(docId, {
        rev,
        origin: "vm-sync",   // aucun client ne porte cet id → tous rechargent (y compris l'initiateur du bouton)
        by: { name: "Synchro VM · " + config.id, ip: "" },
        changeset: { ...Changeset.empty(), collections: ["vms"] },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error("synchro : écriture en échec", docId, config.id, message);
      this.log.error("synchro : pile d'erreur\n" + VmSyncService.stackOf(e));
      return this.record(docId, config, { ok: false, message: "écriture en échec — " + message, attemptIso: nowIso, cluster });
    }

    this.log.info("synchro OK", docId, config.id, VmSyncService.summary(counts));
    return this.record(docId, config, { ok: true, message: emptyHint + VmSyncService.summary(counts), attemptIso: nowIso, successIso: nowIso, counts, cluster });
  }

  /* --------------------------------------------------------------------------
     Helpers privés (statut)
     -------------------------------------------------------------------------- */

  private static summary(counts: VmSyncCounts): string {
    return counts.created + " créée(s), " + counts.updated + " mise(s) à jour, " + counts.orphaned + " orpheline(s), " + counts.unchanged + " inchangée(s)";
  }

  /** Pile COMPLÈTE d'une erreur pour les logs serveur : la sienne + celle de sa `cause`
      (PveHttpError la transporte). Sans elle, une ERR_INTERNAL_ASSERTION de Node se réduit
      à « open an issue » — le message seul ne dit jamais d'où elle vient. */
  private static stackOf(e: unknown): string {
    if (e instanceof PveHttpError) return e.fullStack();
    if (e instanceof Error) {
      const cause = (e as any).cause;
      return (e.stack || e.message) + (cause instanceof Error && cause.stack ? "\n  cause : " + cause.stack : "");
    }
    return String(e);
  }

  /** Enregistre et renvoie le nouvel état d'un provider. `last_success` ET `cluster` SURVIVENT
      aux échecs ultérieurs (l'UI peut afficher « en erreur depuis…, dernière réussite à… » avec
      le dernier état de cluster connu plutôt que rien). */
  private record(docId: string, config: ProviderConfig,
                 s: { ok: boolean; message: string; attemptIso: string | null; successIso?: string; counts?: VmSyncCounts; cluster?: VmClusterInfo | null }): VmProviderStatus {
    let perDoc = this.status.get(docId);
    if (!perDoc) { perDoc = new Map(); this.status.set(docId, perDoc); }
    const prior = perDoc.get(config.id);
    const next: VmProviderStatus = {
      provider_id: config.id, kind: config.kind, interval_sec: config.interval_sec,
      last_attempt: s.attemptIso ?? (prior ? prior.last_attempt : null),
      last_success: s.successIso ?? (prior ? prior.last_success : null),
      ok: s.ok,
      message: s.message,
      counts: s.counts ?? (prior ? prior.counts : null),
      cluster: s.cluster ?? (prior ? prior.cluster : null),
    };
    perDoc.set(config.id, next);
    return next;
  }
}
