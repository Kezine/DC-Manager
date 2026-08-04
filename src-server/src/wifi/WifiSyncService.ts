import { randomUUID } from "node:crypto";
import type { DocumentStore } from "../documents.js";
import { Logger } from "../logger.js";
import { DataValidator, type ValidationError } from "../../../src-shared/DataValidation.js";
import { Changeset } from "../../../src-shared/DocumentChangeset.js";
import type { WifiProviderConfig, WifiProviderConfigSource, WifiProviderAdapter } from "./WifiProvider.js";
import { UnifiHttpError } from "./UnifiHttp.js";
import { UnifiAdapter } from "./UnifiAdapter.js";
import { WifiReconcile } from "./WifiReconcile.js";

/* =============================================================================
   MOTEUR DE SYNCHRO DES CLIENTS WIFI — module `wifi/` amovible. Exécute une
   synchronisation par couple document × provider : adaptateur (inventaire) →
   réconciliation (`WifiReconcile`, pure) → écriture TRANSACTIONNELLE dans le
   document + événement SSE (les clients rechargent la collection `wifiClients`
   en granulaire, comme pour n'importe quelle écriture HTTP — rien de spécifique
   côté client).

   AGNOSTIQUE DE MARQUE (décision D9) : ce fichier ne connaît que le contrat
   `WifiProviderAdapter`. Le SEUL endroit qui nomme une marque est la fabrique
   `adapterFor` ci-dessous — c'est l'« entrée de fabrique » du critère
   d'acceptation (ajouter une marque = 1 adaptateur + 1 ligne ici + 1 branche
   d'options de validation + 1 option du <select> côté UI).

   AUTORITÉ SERVEUR : tout enregistrement écrit passe par la même validation
   partagée que /transact (`DataValidator`) — un contrôleur défaillant (ou un
   décodage inattendu) ne peut pas injecter de données invalides dans le document.

   Concurrence : le dépôt (better-sqlite3) est SYNCHRONE et Node mono-thread — la
   séquence relecture → fusion patch → transact s'exécute sans écriture intercalée.
   La relecture au moment d'écrire (plutôt que le snapshot du plan) minimise la
   fenêtre d'écrasement d'une édition locale concurrente : seuls les champs du
   patch (champs SOURCE) sont posés.

   Pas d'Express ici : les routes vivent dans `WifiModule.ts`. Le bus live est vu
   par une interface minimale — `LiveBus` la satisfait, un stub de test aussi.
   ============================================================================= */

/** Ce que le moteur exige du bus live (publication seule — jamais d'abonnement ici). */
export interface WifiLivePublisher {
  publish(docId: string, data: unknown): void;
}

/** CONSOMMATEUR de signalement de problèmes persistants — DÉPENDANCE INVERSÉE (même patron
    que le module VM). Le service `wifi/` déclare ICI le contrat MINIMAL qu'il attend d'un
    module de notifications, mais n'importe RIEN de `notify/` : les features restent amovibles
    indépendamment. C'est `index.ts` qui PONTE (typage STRUCTUREL) le NotifyModule vers cette
    interface au bootstrap. `raise`/`resolve` sont fire-and-forget : le moteur notify gère TOUT
    l'anti-spam (déduplication par clé, rappels espacés) — le producteur ne compte rien. */
export interface ProblemReporter {
  raise(key: string, event: { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id?: string | null }): void;
  resolve(key: string): void;
}

export interface WifiSyncCounts { created: number; updated: number; disconnected: number; unchanged: number }

/** État de synchro d'UN provider d'UN document — matière de `GET /documents/:docId/wifi/status`.
    En mémoire uniquement (reperdu au redémarrage — assumé : c'est un état opérationnel, pas une
    donnée). ⚠ DUPLICATION assumée : le client porte un MIROIR de ce DTO réseau dans
    `src-client/views/forms/WifiSyncClient.ts` — toute évolution ici doit y être répercutée. */
export interface WifiProviderStatus {
  provider_id: string;
  kind: string;
  /** Période de synchro automatique (0 = manuelle) — reprise de la config (affichage UI). */
  interval_sec: number;
  /** Dernière TENTATIVE (ISO). null = jamais synchronisé depuis le démarrage. */
  last_attempt: string | null;
  /** Dernière synchro RÉUSSIE (ISO) — conservée quand une tentative ultérieure échoue. */
  last_success: string | null;
  ok: boolean;
  /** Résumé lisible (compteurs) ou message d'erreur — JAMAIS la clé d'API. */
  message: string;
  counts: WifiSyncCounts | null;
}

export class WifiSyncService {
  /** Délai MINIMAL par défaut entre DEUX passes d'un même couple document×provider (anti-rafale) :
      Node sérialise les requêtes, mais deux POST /wifi/sync quasi simultanés déclencheraient deux
      passes SUCCESSIVES — la seconde referait tout l'inventaire pour rien. Sous ce délai,
      l'appelant reçoit le dernier statut (annoté) au lieu d'une nouvelle passe. */
  static readonly DEFAULT_MIN_INTERVAL_SEC = 10;

  /** docId → providerId → dernier état connu. */
  private readonly status = new Map<string, Map<string, WifiProviderStatus>>();
  /** Couples document×provider EN COURS (anti-chevauchement timer ↔ synchro manuelle). */
  private readonly running = new Set<string>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly docs: DocumentStore,
    private readonly live: WifiLivePublisher,
    // SOURCE de config vue par CONTRAT : base chiffrée (WifiProviderConfigDb) en production,
    // stub minimal en test — le moteur ignore le support de stockage.
    private readonly providers: WifiProviderConfigSource,
    private readonly log: Logger = new Logger("error"),
    /** Fabrique d'adaptateur INJECTÉE (stub en test). Défaut : par `kind` de la config. */
    private readonly makeAdapter: (config: WifiProviderConfig) => WifiProviderAdapter = WifiSyncService.adapterFor,
    /** Délai minimal entre deux passes (secondes) — injectable (0 en test). S'applique aussi
        aux timers : un `interval_sec` inférieur est de fait plafonné par ce délai. */
    private readonly minIntervalSec: number = WifiSyncService.DEFAULT_MIN_INTERVAL_SEC,
    /** Rapporteur de problèmes persistants au module notifications — OPTIONNEL, injecté au
        bootstrap par typage structurel. undefined = feature notify absente → aucun signalement. */
    private readonly problems?: ProblemReporter,
  ) {}

  /** FABRIQUE PAR MARQUE — LE point d'extension « nouvelle marque » côté runtime (décision D9).
      Ajouter un contrôleur d'une autre marque = écrire son `XxxAdapter` (préfixe de marque) et
      ajouter UNE ligne ici. Un `kind` inconnu échoue à la SYNCHRO (statut en erreur pour CE
      provider), pas au chargement — les autres providers vivent. ⚠ La liste doit rester en phase
      avec `WifiProviderConfigValidate.KIND_OPTION_SPECS` (un kind validable sans adaptateur
      donnerait un provider enregistrable mais mort) : un test de cohérence confronte les deux. */
  static adapterFor(config: WifiProviderConfig): WifiProviderAdapter {
    if (config.kind === "unifi") return UnifiAdapter.fromConfig(config);
    throw new Error("type de provider wifi inconnu : « " + config.kind + " » (supportés : unifi)");
  }

  /** Synchronise TOUS les providers d'un document (bouton « Synchroniser », séquentiel :
      volumes faibles, et un échec n'empêche pas les suivants). */
  async syncDocument(docId: string): Promise<WifiProviderStatus[]> {
    const results: WifiProviderStatus[] = [];
    for (const config of this.providers.providersFor(docId)) results.push(await this.syncProvider(docId, config));
    return results;
  }

  /** État courant des providers d'un document — les jamais-synchronisés apparaissent aussi
      (fusion config déclarée × état runtime), pour que l'UI liste ce qui est configuré.
      Consomme `summariesFor` (résumés SANS jeton) et NON `providersFor` : le chemin STATUT n'a
      besoin que d'id/kind/intervalle — inutile (et malsain) d'y faire circuler les clés d'API. */
  statusFor(docId: string): WifiProviderStatus[] {
    const summaries = this.providers.summariesFor(docId);
    const runtime = this.status.get(docId);
    // PURGE DES STATUTS FANTÔMES : un provider RETIRÉ de la config laisserait indéfiniment son
    // état runtime ici — fuite mémoire lente, et entrée obsolète qui pourrait resurgir.
    // `statusFor` est le point de passage naturel de la purge (il connaît la config DÉCLARÉE).
    if (runtime) {
      const configured = new Set(summaries.map((s) => s.id));
      for (const id of [...runtime.keys()]) if (!configured.has(id)) runtime.delete(id);
    }
    return summaries.map((summary) =>
      (runtime && runtime.get(summary.id)) || {
        provider_id: summary.id, kind: summary.kind, interval_sec: summary.interval_sec,
        last_attempt: null, last_success: null, ok: true, message: "jamais synchronisé depuis le démarrage", counts: null,
      });
  }

  /** Arme les synchros PÉRIODIQUES (interval_sec > 0) pour chaque couple document×provider.
      La config est lue à l'appel (pas de snapshot) : `rearmTimers()` la relit après chaque
      écriture CRUD (rechargement à chaud). `unref()` : les timers ne retiennent pas le process. */
  startTimers(): void {
    for (const docId of this.providers.configuredDocIds()) {
      for (const config of this.providers.providersFor(docId)) {
        if (config.interval_sec <= 0) continue;
        const timer = setInterval(() => {
          void this.syncProvider(docId, config).catch((e) =>
            this.log.error("synchro wifi périodique : échec inattendu", docId, config.id, e instanceof Error ? e.message : String(e)));
        }, config.interval_sec * 1000);
        // `unref` n'existe que sur le Timeout Node (pas dans le type DOM du build de test mixte) — cast assumé.
        (timer as any).unref?.();
        this.timers.push(timer);
        this.log.info("synchro wifi périodique armée", docId, config.id, config.interval_sec + "s");
      }
    }
  }

  stopTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** RÉ-ARME les timers périodiques : arrête les timers courants puis les redémarre selon la
      config ACTUELLE. Depuis l'UI de configuration, la config change À CHAUD (CRUD) — sans ce
      ré-armement, un ajout/retrait ou un `interval_sec` modifié ne prendrait effet qu'au
      prochain redémarrage. Appelé après CHAQUE écriture CRUD (idempotent). */
  rearmTimers(): void {
    this.stopTimers();
    this.startTimers();
  }

  /** Synchronise UN provider d'UN document. Ne JETTE jamais : tout aboutit à un statut
      (ok ou erreur) — le document garde son état précédent en cas d'échec (contrat adaptateur). */
  async syncProvider(docId: string, config: WifiProviderConfig): Promise<WifiProviderStatus> {
    // Clé COMPOSITE non ambiguë du couple document × provider. Sérialisée en JSON plutôt que
    // jointe par un séparateur : ni un identifiant de document ni un id de provider n'ont de jeu
    // de caractères garanti, et une simple concaténation ferait collisionner ("a"+"bc") et ("ab"+"c").
    const key = JSON.stringify([docId, config.id]);
    if (this.running.has(key)) {
      // Chevauchement (timer + manuel, ou console lente) : on ne double pas la synchro en cours.
      const current = this.status.get(docId) && this.status.get(docId)!.get(config.id);
      if (current) return current;
      // Aucun état antérieur : statut SYNTHÉTIQUE « déjà en cours » SANS LE STOCKER. Le stocker
      // figerait un `ok:true` trompeur qui MASQUERAIT le résultat réel de la passe en cours.
      return {
        provider_id: config.id, kind: config.kind, interval_sec: config.interval_sec,
        last_attempt: null, last_success: null, ok: true, message: "synchronisation déjà en cours", counts: null,
      };
    }
    // ANTI-RAFALE : sous le délai minimal depuis la dernière TENTATIVE, on rend le dernier statut
    // (annoté, SANS le stocker — le statut persistant reste le vrai résultat) au lieu de relancer
    // une passe complète.
    const prior = this.status.get(docId) && this.status.get(docId)!.get(config.id);
    if (prior && prior.last_attempt !== null && this.minIntervalSec > 0) {
      const elapsedMs = Date.now() - Date.parse(prior.last_attempt);
      if (elapsedMs >= 0 && elapsedMs < this.minIntervalSec * 1000) {
        this.log.info("synchro wifi ignorée (anti-rafale)", docId, config.id, Math.round(elapsedMs / 1000) + "s écoulées, minimum " + this.minIntervalSec + "s");
        return { ...prior, message: prior.message + " · relance ignorée (dernière synchro il y a " + Math.round(elapsedMs / 1000) + " s, délai minimal " + this.minIntervalSec + " s)" };
      }
    }
    this.running.add(key);
    try {
      const status = await this.doSync(docId, config);
      // SIGNALEMENT au module notifications — ICI, APRÈS les sorties ANTICIPÉES (« déjà en cours »,
      // anti-rafale) : celles-ci ne synchronisent RIEN, donc ne signalent rien. Clé STABLE par
      // couple document×provider : le moteur notify déduplique dessus. On `raise` à CHAQUE passe
      // en échec SANS aucun comptage ici — l'anti-spam est ENTIÈREMENT au moteur, le producteur
      // ne fait que refléter l'état COURANT (échec → raise, succès → resolve).
      const problemKey = "wifi-sync:" + docId + ":" + config.id;
      if (status.ok) this.problems?.resolve(problemKey);
      else this.problems?.raise(problemKey, {
        event_type: "wifi-sync-failure",
        severity: "error",
        title: "Synchro clients wifi en échec — " + config.id,
        body: status.message,   // résumé lisible SANS clé d'API (garanti par UnifiHttp/ConfigDb)
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

  private async doSync(docId: string, config: WifiProviderConfig): Promise<WifiProviderStatus> {
    const nowIso = new Date().toISOString();
    const repo = this.docs.repo(docId);
    if (!repo) return this.record(docId, config, { ok: false, message: "document inconnu", attemptIso: nowIso });

    // TRAÇAGE : chaque étape de la passe est journalisée — démarrage, volume d'inventaire, plan
    // d'opérations, écriture — pour suivre une synchro de bout en bout dans les logs serveur,
    // même quand elle « réussit » avec un résultat suspect.
    this.log.info("synchro wifi démarrée", docId, config.id, "kind " + config.kind + ", timeout " + config.timeout_sec + "s");

    // 1) Inventaire provider. Échec → statut en erreur, document INTACT (état précédent conservé).
    let records;
    try {
      records = (await this.makeAdapter(config).inventory()).clients;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("synchro wifi : inventaire en échec", docId, config.id, message);
      // PILE COMPLÈTE au log (jamais dans le statut/toast — elle reste côté serveur) : le
      // `message` seul est inexploitable pour certaines erreurs internes de Node.
      this.log.warn("synchro wifi : pile d'erreur\n" + WifiSyncService.stackOf(e));
      return this.record(docId, config, { ok: false, message, attemptIso: nowIso });
    }

    // 2) Réconciliation PURE contre les clients de CETTE instance (périmètre multi-contrôleurs).
    //    RAPPROCHEMENT D'AP — version SIMPLE (décision D4) : nom d'équipement ⇄ `ap_name`,
    //    insensible à la casse et trimé. Candidat UNIQUE → résolu ; PLUSIEURS → ambigu → null
    //    (on ne devine pas quel AP) ; ZÉRO → null. Volontairement PLUS SIMPLE que la hiérarchie à
    //    3 niveaux des VMs (hostnames d'IP, FQDN…) : le besoin n'est pas démontré côté wifi, et
    //    une hiérarchie non éprouvée coûterait des rapprochements FAUX plutôt que des absents.
    //    Index construit PARESSEUSEMENT (au premier AP à résoudre) puis mémoïsé pour la passe :
    //    un SEUL balayage des équipements, quel que soit le nombre d'AP.
    let apIndex: Map<string, Set<string>> | null = null;
    const buildApIndex = (): Map<string, Set<string>> => {
      if (apIndex) return apIndex;
      const byName = new Map<string, Set<string>>();
      for (const equipment of repo.list("equipments", { pageSize: 100000 }).rows) {
        const name = (typeof equipment.name === "string" ? equipment.name : "").trim().toLowerCase();
        if (!name) continue;
        const set = byName.get(name);
        if (set) set.add(equipment.id); else byName.set(name, new Set([equipment.id]));
      }
      return (apIndex = byName);
    };
    const resolvedByName = new Map<string, string | null>();
    const resolveAp = (apName: string): string | null => {
      if (resolvedByName.has(apName)) return resolvedByName.get(apName)!;
      const candidates = buildApIndex().get(apName.trim().toLowerCase());
      let resolved: string | null = null;
      if (!candidates || candidates.size === 0) {
        this.log.info("synchro wifi : AP non rapproché (aucun équipement homonyme)", docId, config.id, apName);
      } else if (candidates.size === 1) {
        resolved = [...candidates][0];
        this.log.info("synchro wifi : AP rapproché", docId, config.id, apName + " → " + resolved);
      } else {
        // AMBIGU : on ne devine pas. Le champ reste null et l'utilisateur voit « AP non rapproché ».
        this.log.info("synchro wifi : AP ambigu (non rapproché)", docId, config.id, apName + " → " + candidates.size + " équipements");
      }
      resolvedByName.set(apName, resolved);
      return resolved;
    };

    const existingClients = repo.findBy("wifiClients", "provider_id", config.id);
    this.log.info("synchro wifi : inventaire reçu", docId, config.id, records.length + " client(s) remonté(s), " + existingClients.length + " dans le document");
    const ops = WifiReconcile.plan({
      providerId: config.id,
      records,
      existingClients,
      resolveApEquipmentId: resolveAp,
      newId: () => randomUUID(),
      nowIso,
    });
    const counts: WifiSyncCounts = { created: ops.creates.length, updated: ops.updates.length, disconnected: ops.orphans.length, unchanged: ops.unchanged };
    this.log.info("synchro wifi : plan d'opérations", docId, config.id, WifiSyncService.summary(counts));

    // INVENTAIRE VIDE : ce n'est PAS forcément une anomalie côté wifi (un site sans client
    // connecté existe), mais c'est le symptôme des DEUX pièges de configuration les plus
    // fréquents — mauvais site, ou clé d'API sans droit de lecture sur les clients. On le dit
    // dans le statut (visible dans l'UI) au lieu d'un « 0 créé » sibyllin.
    const emptyHint = records.length === 0
      ? "AUCUN client remonté par le contrôleur — vérifiez le SITE configuré et les droits de la clé d'API "
        + "(l'API d'intégration filtre par permissions et renvoie une liste vide SANS erreur) · "
      : "";

    // 3) Rien à écrire → AUCUNE révision consommée, aucun événement SSE (idempotence de bout en bout).
    if (!ops.creates.length && !ops.updates.length && !ops.orphans.length) {
      return this.record(docId, config, { ok: true, message: emptyHint + WifiSyncService.summary(counts), attemptIso: nowIso, successIso: nowIso, counts });
    }

    // 4) Patchs → enregistrements COMPLETS (le dépôt remplace la ligne entière) : relecture au
    //    moment d'écrire — un client supprimé entre le plan et l'écriture n'est PAS ressuscité.
    const updates: { collection: string; record: Record<string, any> }[] = [];
    for (const op of [...ops.updates, ...ops.orphans]) {
      const current = repo.getOne("wifiClients", op.id);
      if (!current) continue;
      updates.push({ collection: "wifiClients", record: { ...current, ...op.patch, updated_date: nowIso } });
    }
    const creates = ops.creates.map((record) => ({ collection: "wifiClients", record }));

    // 5) AUTORITÉ SERVEUR : normalisation + validation partagées (même discipline que /transact).
    const fetch = (collection: string, id: string) => repo.getOne(collection, id);
    const find = (collection: string, field: string, value: any) => repo.findBy(collection, field, String(value));
    const errors: ValidationError[] = [];
    for (const entry of [...creates, ...updates]) {
      const result = DataValidator.normalizeAndValidate("wifiClients", entry.record, fetch, find);
      errors.push(...result.errors);
      entry.record = result.record;
    }
    if (errors.length) {
      // Données irrecevables : on n'écrit RIEN (pas d'écriture partielle) — détail au log, résumé
      // au statut. Jamais la clé (les messages de validation citent les champs).
      const detail = errors.slice(0, 3).map((e) => e.path + " : " + e.message).join(" · ");
      this.log.warn("synchro wifi : données invalides, écriture refusée", docId, config.id, detail, "(" + errors.length + " erreur(s))");
      return this.record(docId, config, { ok: false, message: "données de synchro invalides — " + detail, attemptIso: nowIso });
    }

    // 6) Écriture transactionnelle + révision + SSE — le même triptyque que la couche HTTP
    //    (les autres clients rechargent `wifiClients` en granulaire via leur ReloadPlanner).
    try {
      const rev = this.docs.markChanged(docId);
      repo.transact({ creates, updates }, rev);
      this.live.publish(docId, {
        rev,
        origin: "wifi-sync",   // aucun client ne porte cet id → tous rechargent (y compris l'initiateur du bouton)
        by: { name: "Synchro Wifi · " + config.id, ip: "" },
        changeset: { ...Changeset.empty(), collections: ["wifiClients"] },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error("synchro wifi : écriture en échec", docId, config.id, message);
      this.log.error("synchro wifi : pile d'erreur\n" + WifiSyncService.stackOf(e));
      return this.record(docId, config, { ok: false, message: "écriture en échec — " + message, attemptIso: nowIso });
    }

    this.log.info("synchro wifi OK", docId, config.id, WifiSyncService.summary(counts));
    return this.record(docId, config, { ok: true, message: emptyHint + WifiSyncService.summary(counts), attemptIso: nowIso, successIso: nowIso, counts });
  }

  /* --------------------------------------------------------------------------
     Helpers privés (statut)
     -------------------------------------------------------------------------- */

  /** Résumé lisible d'une passe. « déconnecté(s) » et non « orphelin(s) » : c'est le LIBELLÉ
      métier de la décision D2 — la mécanique est celle des VMs, le vocabulaire est le nôtre. */
  private static summary(counts: WifiSyncCounts): string {
    return counts.created + " créé(s), " + counts.updated + " mis à jour, " + counts.disconnected + " déconnecté(s), " + counts.unchanged + " inchangé(s)";
  }

  /** Pile COMPLÈTE d'une erreur pour les logs serveur : la sienne + celle de sa `cause`
      (`UnifiHttpError` la transporte). Sans elle, une erreur interne de Node se réduit à un
      message inexploitable. */
  private static stackOf(e: unknown): string {
    if (e instanceof UnifiHttpError) return e.fullStack();
    if (e instanceof Error) {
      const cause = (e as any).cause;
      return (e.stack || e.message) + (cause instanceof Error && cause.stack ? "\n  cause : " + cause.stack : "");
    }
    return String(e);
  }

  /** Enregistre et renvoie le nouvel état d'un provider. `last_success` SURVIT aux échecs
      ultérieurs (l'UI peut afficher « en erreur depuis…, dernière réussite à… »). */
  private record(docId: string, config: WifiProviderConfig,
                 s: { ok: boolean; message: string; attemptIso: string | null; successIso?: string; counts?: WifiSyncCounts }): WifiProviderStatus {
    let perDoc = this.status.get(docId);
    if (!perDoc) { perDoc = new Map(); this.status.set(docId, perDoc); }
    const prior = perDoc.get(config.id);
    const next: WifiProviderStatus = {
      provider_id: config.id, kind: config.kind, interval_sec: config.interval_sec,
      last_attempt: s.attemptIso ?? (prior ? prior.last_attempt : null),
      last_success: s.successIso ?? (prior ? prior.last_success : null),
      ok: s.ok,
      message: s.message,
      counts: s.counts ?? (prior ? prior.counts : null),
    };
    perDoc.set(config.id, next);
    return next;
  }
}
