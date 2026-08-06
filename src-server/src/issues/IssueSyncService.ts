import { randomUUID } from "node:crypto";
import type { DocumentStore } from "../documents.js";
import type { RepositoryContract } from "../db.js";
import { Logger } from "../logger.js";
import { DataValidator, type ValidationError } from "../../../src-shared/DataValidation.js";
import { Changeset } from "../../../src-shared/DocumentChangeset.js";
import type { IssueProviderConfig, IssueProviderConfigSource, IssueProviderAdapter, IssueRecord, IssueResolution } from "./IssueProvider.js";
import { JiraAdapter } from "./JiraAdapter.js";
import { IssueReconcile } from "./IssueReconcile.js";

/* =============================================================================
   MOTEUR DE SYNCHRO DES TICKETS — module `issues/` amovible. Exécute une passe par
   couple document × provider : assiette lue dans le DOCUMENT → résolution par
   l'adaptateur → réconciliation (`IssueReconcile`, pure) → écriture
   TRANSACTIONNELLE + événement SSE (les clients rechargent la collection `issues`
   en granulaire, comme pour n'importe quelle écriture HTTP).

   🚨 L'ASSIETTE EST INVERSÉE (§3 du cadrage), et c'est ce qui distingue ce service
   de `VmSyncService`/`WifiSyncService` : là-bas on appelle `inventory()` et la
   SOURCE dicte le contenu ; ici on LIT D'ABORD le document (`findBy("issues",
   "provider_id", …)`) et on demande au tracker l'état de CES tickets-là
   (`resolve(extIds)`). Conséquences portées par tout le fichier :
   - une passe ne CRÉE jamais d'enregistrement (le plan n'a pas de `creates`) ;
   - une assiette VIDE n'appelle même pas le tracker — il n'y a rien à demander ;
   - le volume n'est PAS borné par la source mais par l'UTILISATEUR (il suit ce
     qu'il veut), d'où le PLAFOND de passe ci-dessous, journalisé et jamais tu.
   Les DEUX portes d'entrée de l'assiette sont des ACTES : « Suivre un ticket »
   (`followReference`, ici même — elle a besoin du même triptyque d'écriture, donc
   la dupliquer ailleurs serait une duplication pure) et « Ouvrir un ticket » (L5).

   AGNOSTIQUE DE MARQUE : ce fichier ne connaît que le contrat
   `IssueProviderAdapter`. Le SEUL endroit qui nomme une marque est la fabrique
   `adapterFor` — c'est le point d'extension n°2 du chantier (ajouter une marque =
   1 adaptateur + 1 ligne ici + 1 branche d'options de validation + 1 option du
   <select> côté UI). Un test relit les sources des modules génériques pour vérifier
   qu'aucune marque n'y a fui.

   AUTORITÉ SERVEUR : tout enregistrement écrit passe par la même validation
   partagée que /transact (`DataValidator`) — un tracker défaillant (ou un décodage
   inattendu) ne peut pas injecter de données invalides dans le document.

   Concurrence : le dépôt (better-sqlite3) est SYNCHRONE et Node mono-thread — la
   séquence relecture → fusion patch → transact s'exécute sans écriture intercalée.
   La relecture AU MOMENT D'ÉCRIRE (plutôt que le snapshot du plan) minimise la
   fenêtre d'écrasement d'une édition locale concurrente : seuls les champs du patch
   (champs SOURCE) sont posés — les `notes` et les `targets` saisis pendant la passe
   survivent.

   Pas d'Express ici : les routes vivent dans `IssueModule.ts`. Le bus live est vu
   par une interface minimale — `LiveBus` la satisfait, un stub de test aussi.
   ============================================================================= */

/** Enregistrement générique du document (le serveur manipule du JSON brut). */
type Rec = { [k: string]: any };

/** Ce que le moteur exige du bus live (publication seule — jamais d'abonnement ici). */
export interface IssueLivePublisher {
  publish(docId: string, data: unknown): void;
}

/** CONSOMMATEUR de signalement de problèmes persistants — DÉPENDANCE INVERSÉE (même patron que les
    modules vm/ et wifi/). Le service `issues/` déclare ICI le contrat MINIMAL qu'il attend d'un
    module de notifications, mais n'importe RIEN de `notify/` : les features restent amovibles
    indépendamment. C'est `index.ts` qui PONTE (typage STRUCTUREL) le NotifyModule vers cette
    interface au bootstrap. `raise`/`resolve` sont fire-and-forget : le moteur notify gère TOUT
    l'anti-spam (déduplication par clé, rappels espacés) — le producteur ne compte rien. */
export interface ProblemReporter {
  raise(key: string, event: { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id?: string | null }): void;
  resolve(key: string): void;
}

/** Compteurs d'UNE passe. ⚠ `tracked` et `skipped` n'ont PAS d'équivalent côté vm//wifi/ : ils
    n'existent que parce que l'assiette est pilotée par l'utilisateur (cf. l'en-tête) — ce sont eux
    qui rendent VISIBLE une assiette devenue trop grosse pour une seule passe. */
export interface IssueSyncCounts {
  /** Tickets SUIVIS par le document pour cette instance de provider (l'assiette complète). */
  tracked: number;
  /** Identifiants réellement DEMANDÉS au tracker à cette passe (≤ `tracked` si le plafond a joué). */
  queried: number;
  /** Tickets dont au moins un champ source a changé. */
  updated: number;
  /** Tickets passés « INTROUVABLES » à cette passe (supprimés, projet archivé, permission perdue). */
  missing: number;
  /** Tickets déjà à jour. */
  unchanged: number;
  /** Tickets suivis REPORTÉS au prochain passage à cause du plafond — 0 en régime normal. */
  skipped: number;
}

/** État de synchro d'UN provider d'UN document — matière de `GET /documents/:docId/issues/status`.
    En mémoire uniquement (reperdu au redémarrage — assumé : c'est un état opérationnel, pas une
    donnée). ⚠ DUPLICATION assumée : le client portera un MIROIR de ce DTO réseau (lot L4) — toute
    évolution ici devra y être répercutée, comme pour `WifiProviderStatus`. */
export interface IssueProviderStatus {
  provider_id: string;
  kind: string;
  /** Période de synchro automatique (0 = manuelle) — reprise de la config (affichage UI). */
  interval_sec: number;
  /** Dernière TENTATIVE (ISO). null = jamais synchronisé depuis le démarrage. */
  last_attempt: string | null;
  /** Dernière synchro RÉUSSIE (ISO) — conservée quand une tentative ultérieure échoue. */
  last_success: string | null;
  ok: boolean;
  /** Résumé lisible (compteurs) ou message d'erreur — JAMAIS le jeton d'API. */
  message: string;
  counts: IssueSyncCounts | null;
}

/** Résultat de la porte d'entrée « Suivre un ticket » (décision D4). */
export interface IssueFollowResult {
  ok: boolean;
  /** Enregistrement du document (créé ou rafraîchi), tel qu'il est PERSISTÉ. null si refus. */
  issue: Rec | null;
  /** Le ticket était DÉJÀ suivi : rien n'a été créé. L'UI doit le DIRE plutôt que d'annoncer une
      création — sinon l'utilisateur croit avoir ajouté une ligne qui n'apparaît nulle part. */
  already: boolean;
  /** Provider ayant RECONNU la référence (null si aucun). */
  provider_id: string | null;
  /** Message lisible et ACTIONNABLE — jamais le jeton. */
  message: string;
}

export class IssueSyncService {
  /** Délai MINIMAL par défaut entre DEUX passes d'un même couple document×provider (anti-rafale) :
      Node sérialise les requêtes, mais deux POST /issues/sync quasi simultanés déclencheraient deux
      passes SUCCESSIVES — la seconde re-résoudrait toute l'assiette pour rien. Sous ce délai,
      l'appelant reçoit le dernier statut (annoté) au lieu d'une nouvelle passe. */
  static readonly DEFAULT_MIN_INTERVAL_SEC = 10;

  /** 🚨 PLAFOND de tickets interrogés par passe (risque n°7 du cadrage). Contrairement à `vm/` et
      `wifi/`, où la SOURCE borne naturellement le volume (un cluster a N VMs), l'assiette est ici
      PILOTÉE PAR L'UTILISATEUR : rien n'empêche un document de suivre des milliers de tickets, et
      une passe non bornée finirait par marteler le tracker (429) ou dépasser tout délai raisonnable.
      500 = 5 lots de 100 chez un adaptateur qui résout par lots — coûteux mais pas déraisonnable.
      ⚠ Ce qui est tronqué est JOURNALISÉ et remonté DANS LE STATUT : un plafond silencieux se
      lirait « tout est à jour » alors que la moitié de l'assiette n'a pas été regardée. Et le
      ROULEMENT (cf. `passScope` + `cursors`) garantit que le reliquat n'est jamais le même. */
  static readonly MAX_ISSUES_PER_PASS = 500;

  /** docId → providerId → dernier état connu. */
  private readonly status = new Map<string, Map<string, IssueProviderStatus>>();
  /** couple document×provider → RANG de départ de la prochaine passe TRONQUÉE (roulement).
      En mémoire, comme `status` : reperdu au redémarrage, ce qui au pire refait un tour depuis le
      début — jamais une zone morte. ⚠ Sans ce curseur, une assiette plafonnée dont RIEN ne change
      resterait figée : l'idempotence n'écrit pas `last_sync` sur un ticket inchangé, donc l'ordre de
      priorité ne bougerait plus et la queue de l'assiette ne serait JAMAIS interrogée. */
  private readonly cursors = new Map<string, number>();
  /** Couples document×provider EN COURS (anti-chevauchement timer ↔ synchro manuelle). */
  private readonly running = new Set<string>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly docs: DocumentStore,
    private readonly live: IssueLivePublisher,
    // SOURCE de config vue par CONTRAT : base chiffrée (IssueProviderConfigDb) en production,
    // stub minimal en test — le moteur ignore le support de stockage.
    private readonly providers: IssueProviderConfigSource,
    private readonly log: Logger = new Logger("error"),
    /** Fabrique d'adaptateur INJECTÉE (stub en test). Défaut : par `kind` de la config. */
    private readonly makeAdapter: (config: IssueProviderConfig) => IssueProviderAdapter = IssueSyncService.adapterFor,
    /** Délai minimal entre deux passes (secondes) — injectable (0 en test). S'applique aussi aux
        timers : un `interval_sec` inférieur est de fait plafonné par ce délai. */
    private readonly minIntervalSec: number = IssueSyncService.DEFAULT_MIN_INTERVAL_SEC,
    /** Rapporteur de problèmes persistants au module notifications — OPTIONNEL, injecté au bootstrap
        par typage structurel. undefined = feature notify absente → aucun signalement. */
    private readonly problems?: ProblemReporter,
    /** Plafond de tickets par passe — injectable pour tester la troncature sans fabriquer 500 lignes. */
    private readonly maxIssuesPerPass: number = IssueSyncService.MAX_ISSUES_PER_PASS,
  ) {}

  /** FABRIQUE PAR MARQUE — LE point d'extension « nouvelle marque » côté runtime (point n°2 du
      chantier). Ajouter un tracker d'une autre marque = écrire son `XxxAdapter` (préfixe de marque)
      et ajouter UNE ligne ici. Un `kind` inconnu échoue à la SYNCHRO (statut en erreur pour CE
      provider), pas au chargement — les autres providers vivent. ⚠ La liste doit rester en phase
      avec `IssueProviderConfigValidate.KIND_OPTION_SPECS` (un kind validable sans adaptateur donnerait
      un provider enregistrable mais mort) : un test de cohérence confronte les deux. */
  static adapterFor(config: IssueProviderConfig): IssueProviderAdapter {
    if (config.kind === "jira") return JiraAdapter.fromConfig(config);
    throw new Error("type de provider de tickets inconnu : « " + config.kind + " » (supportés : jira)");
  }

  /** Synchronise TOUS les providers d'un document (bouton « Synchroniser », séquentiel : volumes
      faibles, et un échec n'empêche pas les suivants). */
  async syncDocument(docId: string): Promise<IssueProviderStatus[]> {
    const results: IssueProviderStatus[] = [];
    for (const config of this.providers.providersFor(docId)) results.push(await this.syncProvider(docId, config));
    return results;
  }

  /** État courant des providers d'un document — les jamais-synchronisés apparaissent aussi (fusion
      config déclarée × état runtime), pour que l'UI liste ce qui est configuré.
      Consomme `summariesFor` (résumés SANS jeton) et NON `providersFor` : le chemin STATUT n'a besoin
      que d'id/kind/intervalle — inutile (et malsain) d'y faire circuler les jetons d'API. */
  statusFor(docId: string): IssueProviderStatus[] {
    const summaries = this.providers.summariesFor(docId);
    const runtime = this.status.get(docId);
    // PURGE DES STATUTS FANTÔMES : un provider RETIRÉ de la config laisserait indéfiniment son état
    // runtime ici — fuite mémoire lente, et entrée obsolète qui pourrait resurgir. `statusFor` est le
    // point de passage naturel de la purge (il connaît la config DÉCLARÉE).
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

  /** Arme les synchros PÉRIODIQUES (interval_sec > 0) pour chaque couple document×provider. La config
      est lue à l'appel (pas de snapshot) : `rearmTimers()` la relit après chaque écriture CRUD
      (rechargement à chaud). `unref()` : les timers ne retiennent pas le process. */
  startTimers(): void {
    for (const docId of this.providers.configuredDocIds()) {
      for (const config of this.providers.providersFor(docId)) {
        if (config.interval_sec <= 0) continue;
        const timer = setInterval(() => {
          void this.syncProvider(docId, config).catch((e) =>
            this.log.error("synchro tickets périodique : échec inattendu", docId, config.id, e instanceof Error ? e.message : String(e)));
        }, config.interval_sec * 1000);
        // `unref` n'existe que sur le Timeout Node (pas dans le type DOM du build de test mixte) — cast assumé.
        (timer as any).unref?.();
        this.timers.push(timer);
        this.log.info("synchro tickets périodique armée", docId, config.id, config.interval_sec + "s");
      }
    }
  }

  stopTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** RÉ-ARME les timers périodiques : arrête les timers courants puis les redémarre selon la config
      ACTUELLE. Depuis l'UI de configuration, la config change À CHAUD (CRUD) — sans ce ré-armement,
      un ajout/retrait ou un `interval_sec` modifié ne prendrait effet qu'au prochain redémarrage.
      Appelé après CHAQUE écriture CRUD (idempotent). */
  rearmTimers(): void {
    this.stopTimers();
    this.startTimers();
  }

  /** Synchronise UN provider d'UN document. Ne JETTE jamais : tout aboutit à un statut (ok ou
      erreur) — le document garde son état précédent en cas d'échec (contrat d'adaptateur). */
  async syncProvider(docId: string, config: IssueProviderConfig): Promise<IssueProviderStatus> {
    // Clé COMPOSITE non ambiguë du couple document × provider. Sérialisée en JSON plutôt que jointe
    // par un séparateur : ni un identifiant de document ni un id de provider n'ont de jeu de
    // caractères garanti, et une concaténation ferait collisionner ("a"+"bc") et ("ab"+"c").
    const key = JSON.stringify([docId, config.id]);
    if (this.running.has(key)) {
      // Chevauchement (timer + manuel, ou tracker lent) : on ne double pas la passe en cours.
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
    // (annoté, SANS le stocker — le statut persistant reste le vrai résultat) au lieu de relancer une
    // passe complète.
    const prior = this.status.get(docId) && this.status.get(docId)!.get(config.id);
    if (prior && prior.last_attempt !== null && this.minIntervalSec > 0) {
      const elapsedMs = Date.now() - Date.parse(prior.last_attempt);
      if (elapsedMs >= 0 && elapsedMs < this.minIntervalSec * 1000) {
        this.log.info("synchro tickets ignorée (anti-rafale)", docId, config.id, Math.round(elapsedMs / 1000) + "s écoulées, minimum " + this.minIntervalSec + "s");
        return { ...prior, message: prior.message + " · relance ignorée (dernière synchro il y a " + Math.round(elapsedMs / 1000) + " s, délai minimal " + this.minIntervalSec + " s)" };
      }
    }
    this.running.add(key);
    try {
      const status = await this.doSync(docId, config);
      // SIGNALEMENT au module notifications — ICI, APRÈS les sorties ANTICIPÉES (« déjà en cours »,
      // anti-rafale) : celles-ci ne synchronisent RIEN, donc ne signalent rien. Clé STABLE par couple
      // document×provider : le moteur notify déduplique dessus. On `raise` à CHAQUE passe en échec
      // SANS aucun comptage ici — l'anti-spam est ENTIÈREMENT au moteur, le producteur ne fait que
      // refléter l'état COURANT (échec → raise, succès → resolve).
      const problemKey = "issue-sync:" + docId + ":" + config.id;
      if (status.ok) this.problems?.resolve(problemKey);
      else this.problems?.raise(problemKey, {
        event_type: "issue-sync-failure",
        severity: "error",
        title: "Synchro des tickets en échec — " + config.id,
        body: status.message,   // résumé lisible SANS jeton (garanti par JiraHttp/ConfigDb)
        doc_id: docId,
      });
      return status;
    } finally {
      this.running.delete(key);
    }
  }

  /* --------------------------------------------------------------------------
     « SUIVRE UN TICKET » — porte d'entrée n°1 de l'assiette (décision D4)
     -------------------------------------------------------------------------- */

  /** Résout une RÉFÉRENCE saisie par l'utilisateur (clé lisible « INFRA-123 » ou URL collée depuis
      le navigateur) et FAIT ENTRER le ticket dans l'assiette du document.

      Vit dans le SERVICE et non dans la route parce qu'elle a besoin d'EXACTEMENT le même montage
      que la synchro — fabrique d'adaptateur, validation partagée, triptyque
      `markChanged`→`transact`→`publish` — et parce que `IssueModule.ts` (Express) reste hors test,
      comme `api.ts`. La route n'est qu'une enveloppe HTTP.

      🚨 IDENTITÉ = `ext_id`, L'IDENTIFIANT INTERNE — jamais la référence saisie (risque n°1 du
      cadrage). Suivre « INFRA-123 » puis, après un déplacement de projet, « OPS-45 » doit
      reconnaître LE MÊME ticket : on ne crée pas de doublon, on rafraîchit l'existant (dont la clé,
      qui est un simple champ d'affichage). Chercher par la référence saisie produirait au premier
      déplacement un doublon PLUS un orphelin, en silence.

      REFUS : référence non résolue → AUCUN enregistrement créé (on ne persiste pas un ticket
      fantôme) et un message actionnable. */
  async followReference(docId: string, reference: string): Promise<IssueFollowResult> {
    const nowIso = new Date().toISOString();
    const refused = (message: string): IssueFollowResult => ({ ok: false, issue: null, already: false, provider_id: null, message });

    const repo = this.docs.repo(docId);
    if (!repo) return refused("document inconnu");
    const raw = typeof reference === "string" ? reference.trim() : "";
    if (raw === "") return refused("indiquez la clé du ticket (par exemple « INFRA-123 ») ou collez l'URL de sa page");

    const configs = this.providers.providersFor(docId);
    if (configs.length === 0) return refused("aucun provider de tickets configuré sur ce document — configurez-en un avant de suivre un ticket");

    // MULTI-PROVIDERS — RÈGLE RETENUE, explicite : on interroge les providers DANS L'ORDRE DE
    // CONFIGURATION (ordre stable, par id) et on retient LE PREMIER QUI RECONNAÎT la référence.
    // Pourquoi pas « tous puis arbitrage » : deux trackers peuvent légitimement porter la même clé
    // (« INFRA-123 » existe chez l'un et chez l'autre) et rien ne permet de trancher à leur place ;
    // s'arrêter au premier est déterministe, et l'utilisateur qui vise l'autre instance colle l'URL
    // — qui, elle, désigne l'instance sans ambiguïté.
    // ⚠ Un provider qui JETTE (jeton invalide, réseau, droits) n'est PAS une non-reconnaissance : on
    // mémorise son erreur et on continue. Si personne ne reconnaît ET qu'au moins un a échoué, le
    // message porte l'échec — dire « introuvable » enverrait l'utilisateur corriger sa saisie alors
    // que c'est le provider qu'il faut réparer.
    let found: IssueRecord | null = null;
    let matched: IssueProviderConfig | null = null;
    const failures: string[] = [];
    for (const candidate of configs) {
      try {
        const record = await this.makeAdapter(candidate).lookup(raw);
        if (record !== null) { found = record; matched = candidate; break; }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.log.warn("suivi de ticket : provider en échec", docId, candidate.id, message);
        failures.push("« " + candidate.id + " » : " + message);
      }
    }
    if (found === null || matched === null) {
      if (failures.length) return refused("aucun provider n'a pu résoudre « " + raw + " » — " + failures.join(" · "));
      return refused("ticket « " + raw + " » introuvable ou inaccessible — vérifiez la clé (ou l'URL) et les droits du compte de service sur son projet");
    }
    const record = found;
    const provider = matched;

    // DÉJÀ SUIVI ? Recherche par `ext_id` (index dédié), restreinte à CETTE instance : deux trackers
    // distincts peuvent porter le même identifiant interne, ce sont deux tickets différents.
    const already = repo.findBy("issues", "ext_id", record.ext_id).find((r) => r.provider_id === provider.id) || null;

    if (already) {
      // RAFRAÎCHISSEMENT via le MÊME plan que la synchro (réutilisation, pas ré-écriture d'un diff) :
      // même normalisation, mêmes patchs minimaux, même retour d'orphelinat. Un ticket suivi qu'on
      // « re-suit » est donc simplement remis à jour — et s'il n'a pas bougé, RIEN n'est écrit.
      const ops = IssueReconcile.plan({ providerId: provider.id, resolution: { found: [record], missing: [] }, existingIssues: [already], nowIso });
      if (ops.updates.length === 0) {
        return { ok: true, issue: already, already: true, provider_id: provider.id, message: "ticket déjà suivi — aucun changement" };
      }
      const current = repo.getOne("issues", already.id);
      if (!current) return refused("le ticket suivi a disparu du document pendant l'opération — réessayez");
      const error = this.writeIssues(docId, repo, [], [{ ...current, ...ops.updates[0].patch, updated_date: nowIso }], "Suivi de ticket · " + provider.id);
      if (error) return refused(error);
      return { ok: true, issue: repo.getOne("issues", already.id), already: true, provider_id: provider.id, message: "ticket déjà suivi — fiche rafraîchie" };
    }

    // CRÉATION de l'enregistrement. Elle est ICI, et surtout PAS dans `IssueReconcile` : ce module
    // affirme en tête qu'il ne crée RIEN, et y glisser un constructeur d'enregistrement brouillerait
    // exactement ce qu'on veut rendre évident. Les champs SOURCE viennent de la normalisation
    // PARTAGÉE (la même que la synchro — sinon la première passe trouverait un faux delta) ; les
    // champs LOCAUX partent à leur défaut, l'utilisateur les enrichit ensuite.
    const created: Rec = {
      id: randomUUID(),
      created_date: nowIso,
      updated_date: nowIso,
      ...IssueReconcile.sourceOf(record, nowIso),
      // Estampille DÉFENSIVE : le contrat veut que l'adaptateur pose `provider_id`, mais c'est ce
      // champ qui délimite le PÉRIMÈTRE de toutes les passes suivantes — un ticket mal estampillé
      // ne serait plus jamais rafraîchi, sans le moindre signal.
      provider_id: provider.id,
      /* locaux — défauts du modèle (enrichis ensuite par l'utilisateur, jamais par la synchro) */
      notes: "",
      description: "",
      targets: [],
    };
    const error = this.writeIssues(docId, repo, [created], [], "Suivi de ticket · " + provider.id);
    if (error) return refused(error);
    this.log.info("suivi de ticket : enregistrement créé", docId, provider.id, record.key + " (ext_id " + record.ext_id + ")");
    return { ok: true, issue: repo.getOne("issues", created.id), already: false, provider_id: provider.id, message: "ticket « " + (record.key || record.ext_id) + " » suivi" };
  }

  /* --------------------------------------------------------------------------
     Cœur d'une passe de synchro
     -------------------------------------------------------------------------- */

  private async doSync(docId: string, config: IssueProviderConfig): Promise<IssueProviderStatus> {
    const nowIso = new Date().toISOString();
    const repo = this.docs.repo(docId);
    if (!repo) return this.record(docId, config, { ok: false, message: "document inconnu", attemptIso: nowIso });

    // TRAÇAGE : chaque étape de la passe est journalisée — démarrage, assiette, plan d'opérations,
    // écriture — pour suivre une synchro de bout en bout dans les logs serveur, même quand elle
    // « réussit » avec un résultat suspect.
    this.log.info("synchro tickets démarrée", docId, config.id, "kind " + config.kind + ", timeout " + config.timeout_sec + "s");

    // 1) ASSIETTE : ce que le DOCUMENT suit pour CETTE instance (l'inverse de vm/ et wifi/).
    const tracked = repo.findBy("issues", "provider_id", config.id);
    const cursorKey = JSON.stringify([docId, config.id]);
    const scope = IssueSyncService.passScope(tracked, this.maxIssuesPerPass, this.cursors.get(cursorKey) || 0);
    // Roulement : la prochaine passe reprend là où celle-ci s'arrête. Le curseur avance AVANT de
    // connaître l'issue de la passe, et c'est VOULU : une fenêtre qui échoue systématiquement (un
    // ticket qui fait tousser le tracker, par exemple) ne doit pas bloquer indéfiniment le tour des
    // autres — elle repassera au tour suivant.
    this.cursors.set(cursorKey, scope.nextStart);
    const zeroCounts: IssueSyncCounts = { tracked: tracked.length, queried: 0, updated: 0, missing: 0, unchanged: 0, skipped: scope.skipped };

    if (scope.batch.length === 0) {
      // ASSIETTE VIDE : aucun ticket suivi → on n'appelle même PAS le tracker. Ce n'est ni une
      // erreur ni une anomalie (c'est l'état d'un provider fraîchement configuré) : c'est le régime
      // NORMAL tant que personne n'a cliqué « Suivre un ticket ».
      this.log.info("synchro tickets : aucun ticket suivi", docId, config.id);
      return this.record(docId, config, {
        ok: true, attemptIso: nowIso, successIso: nowIso, counts: zeroCounts,
        message: "aucun ticket suivi pour ce provider — utilisez « Suivre un ticket » pour en ajouter",
      });
    }

    // PLAFOND : ce qui est tronqué est DIT (log + statut), jamais tu — cf. `MAX_ISSUES_PER_PASS`.
    let capHint = "";
    if (scope.skipped > 0) {
      capHint = "PLAFOND DE PASSE ATTEINT — " + scope.skipped + " ticket(s) suivi(s) n'ont PAS été interrogés à cette passe "
        + "(maximum " + this.maxIssuesPerPass + ") ; les passes suivantes prennent la suite par roulement · ";
      this.log.warn("synchro tickets : PLAFOND de passe atteint", docId, config.id,
        tracked.length + " ticket(s) suivi(s), " + scope.batch.length + " interrogé(s), " + scope.skipped + " reporté(s)");
    }

    // 2) RÉSOLUTION PAR LOTS chez l'adaptateur (`resolve`, jamais `inventory`). Le découpage en lots
    //    est SON affaire (le contrat l'exige) : ré-émietter ici en appels unitaires ferait la
    //    différence entre une passe à 5 requêtes et une passe à 500.
    //    Échec → statut en erreur, document INTACT (état précédent conservé).
    let resolution: IssueResolution;
    try {
      resolution = await this.makeAdapter(config).resolve(scope.batch);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("synchro tickets : résolution en échec", docId, config.id, message);
      // PILE COMPLÈTE au log (jamais dans le statut/toast — elle reste côté serveur) : le `message`
      // seul est inexploitable pour certaines erreurs internes de Node.
      this.log.warn("synchro tickets : pile d'erreur\n" + IssueSyncService.stackOf(e));
      return this.record(docId, config, { ok: false, message, attemptIso: nowIso });
    }

    // 3) Réconciliation PURE contre les tickets de CETTE instance (périmètre multi-trackers).
    const ops = IssueReconcile.plan({ providerId: config.id, resolution, existingIssues: tracked, nowIso });
    const counts: IssueSyncCounts = {
      tracked: tracked.length, queried: scope.batch.length,
      updated: ops.updates.length, missing: ops.orphans.length, unchanged: ops.unchanged, skipped: scope.skipped,
    };
    this.log.info("synchro tickets : plan d'opérations", docId, config.id, IssueSyncService.summary(counts));
    if (ops.untracked > 0) {
      // ANOMALIE (jamais fatale) : le tracker a rendu des tickets qu'on ne suit pas. On les IGNORE —
      // c'est la règle du chantier — mais on le dit, parce que ça signale un adaptateur qui répond à
      // côté de la demande (un JQL trop large, par exemple).
      this.log.warn("synchro tickets : tickets rendus SANS être suivis — ignorés (la synchro ne crée jamais)", docId, config.id, String(ops.untracked));
    }

    // 4) Rien à écrire → AUCUNE révision consommée, aucun événement SSE (idempotence de bout en bout).
    if (!ops.updates.length && !ops.orphans.length) {
      return this.record(docId, config, { ok: true, message: capHint + IssueSyncService.summary(counts), attemptIso: nowIso, successIso: nowIso, counts });
    }

    // 5) Patchs → enregistrements COMPLETS (le dépôt remplace la ligne entière) : relecture au moment
    //    d'écrire — un ticket supprimé entre le plan et l'écriture n'est PAS ressuscité, et les
    //    champs LOCAUX (notes, targets) modifiés entre-temps ne sont pas écrasés.
    const updates: Rec[] = [];
    for (const op of [...ops.updates, ...ops.orphans]) {
      const current = repo.getOne("issues", op.id);
      if (!current) continue;
      updates.push({ ...current, ...op.patch, updated_date: nowIso });
    }

    const error = this.writeIssues(docId, repo, [], updates, "Synchro Tickets · " + config.id);
    if (error) return this.record(docId, config, { ok: false, message: error, attemptIso: nowIso });

    this.log.info("synchro tickets OK", docId, config.id, IssueSyncService.summary(counts));
    return this.record(docId, config, { ok: true, message: capHint + IssueSyncService.summary(counts), attemptIso: nowIso, successIso: nowIso, counts });
  }

  /* --------------------------------------------------------------------------
     Écriture — le triptyque PARTAGÉ par la synchro et par « Suivre un ticket »
     -------------------------------------------------------------------------- */

  /** Écrit un lot dans la collection `issues` : validation PARTAGÉE (autorité serveur), transaction,
      révision, SSE. Rend `null` en cas de succès, un message d'erreur LISIBLE sinon.
      MUTUALISÉ entre la passe de synchro et « Suivre un ticket » : les deux doivent produire
      exactement la même trace (révision + événement) sous peine de laisser des clients désynchronisés
      dans un cas sur deux. Lot vide → aucun effet, aucune révision, aucun SSE. */
  private writeIssues(docId: string, repo: RepositoryContract, createRecords: Rec[], updateRecords: Rec[], author: string): string | null {
    if (!createRecords.length && !updateRecords.length) return null;
    const creates = createRecords.map((record) => ({ collection: "issues", record }));
    const updates = updateRecords.map((record) => ({ collection: "issues", record }));

    // AUTORITÉ SERVEUR : normalisation + validation partagées (même discipline que /transact).
    const fetch = (collection: string, id: string) => repo.getOne(collection, id);
    const find = (collection: string, field: string, value: any) => repo.findBy(collection, field, String(value));
    const errors: ValidationError[] = [];
    for (const entry of [...creates, ...updates]) {
      const result = DataValidator.normalizeAndValidate("issues", entry.record, fetch, find);
      errors.push(...result.errors);
      entry.record = result.record;
    }
    if (errors.length) {
      // Données irrecevables : on n'écrit RIEN (jamais d'écriture partielle) — détail au log, résumé
      // à l'appelant. Jamais le jeton (les messages de validation citent les champs).
      const detail = errors.slice(0, 3).map((e) => e.path + " : " + e.message).join(" · ");
      this.log.warn("issues : données invalides, écriture refusée", docId, detail, "(" + errors.length + " erreur(s))");
      return "données de tickets invalides — " + detail;
    }

    // Écriture transactionnelle + révision + SSE — le même triptyque que la couche HTTP (les autres
    // clients rechargent `issues` en granulaire via leur ReloadPlanner).
    try {
      const rev = this.docs.markChanged(docId);
      repo.transact({ creates, updates }, rev);
      this.live.publish(docId, {
        rev,
        origin: "issue-sync",   // aucun client ne porte cet id → tous rechargent (y compris l'initiateur)
        by: { name: author, ip: "" },
        changeset: { ...Changeset.empty(), collections: ["issues"] },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error("issues : écriture en échec", docId, message);
      this.log.error("issues : pile d'erreur\n" + IssueSyncService.stackOf(e));
      return "écriture en échec — " + message;
    }
    return null;
  }

  /* --------------------------------------------------------------------------
     Helpers privés / purs
     -------------------------------------------------------------------------- */

  /** PÉRIMÈTRE D'UNE PASSE : quels identifiants interroger, combien sont reportés, et où reprendre
      à la passe suivante. PUR et statique — donc testable seul, ce qui compte parce que c'est ici
      que se joue tout le comportement du plafond.

      ORDRE STABLE : `last_sync` CROISSANT (les jamais synchronisés d'abord, `""` triant avant tout
      ISO), départage par `ext_id`. Il donne une priorité SENSÉE au premier tour — on regarde
      d'abord ce qu'on n'a jamais regardé.

      ROULEMENT : quand l'assiette dépasse le plafond, la fenêtre part de `startAt` et boucle sur la
      liste ; `nextStart` dit où reprendre. C'est ce qui empêche toute ZONE MORTE, et un simple tri
      n'y suffirait PAS : l'idempotence n'écrit `last_sync` que sur un ticket qui a CHANGÉ, donc une
      assiette stable garderait éternellement le même ordre — et la queue ne serait jamais
      interrogée. Avec le roulement, l'assiette entière défile en ⌈N/plafond⌉ passes, que quelque
      chose change ou non. Assiette sous le plafond → aucun roulement (`nextStart` remis à 0). */
  static passScope(tracked: Rec[], max: number, startAt: number = 0): { batch: string[]; skipped: number; nextStart: number } {
    const seen = new Set<string>();
    const candidates: { extId: string; lastSync: string }[] = [];
    for (const issue of tracked) {
      const extId = issue && typeof issue.ext_id === "string" ? issue.ext_id.trim() : "";
      if (extId === "" || seen.has(extId)) continue;   // sans identité → inréconciliable ; doublon → une seule demande
      seen.add(extId);
      candidates.push({ extId, lastSync: typeof issue.last_sync === "string" ? issue.last_sync : "" });
    }
    candidates.sort((a, b) => (a.lastSync < b.lastSync ? -1 : a.lastSync > b.lastSync ? 1 : a.extId.localeCompare(b.extId)));
    const limit = max > 0 ? max : candidates.length;   // plafond absurde (0/négatif) → aucun plafond, plutôt qu'une passe morte
    if (candidates.length <= limit) return { batch: candidates.map((c) => c.extId), skipped: 0, nextStart: 0 };
    // Fenêtre CIRCULAIRE : `startAt` est ramené dans les bornes (un curseur mémorisé peut dépasser
    // après un retrait de tickets), puis on prend `limit` éléments en bouclant sur la liste.
    const start = ((startAt % candidates.length) + candidates.length) % candidates.length;
    const batch: string[] = [];
    for (let i = 0; i < limit; i++) batch.push(candidates[(start + i) % candidates.length].extId);
    return { batch, skipped: candidates.length - limit, nextStart: (start + limit) % candidates.length };
  }

  /** Résumé lisible d'une passe. « introuvable(s) » et non « orphelin(s) » : c'est le LIBELLÉ métier
      du chantier (un ticket suivi qui disparaît est un incident, pas une déconnexion banale). */
  private static summary(counts: IssueSyncCounts): string {
    return counts.tracked + " suivi(s), " + counts.queried + " interrogé(s), " + counts.updated + " mis à jour, "
      + counts.missing + " introuvable(s), " + counts.unchanged + " inchangé(s)";
  }

  /** Pile COMPLÈTE d'une erreur pour les logs serveur : la sienne + celle de sa `cause`. Le premier
      test est STRUCTUREL (`fullStack`) et non un `instanceof` d'une classe de marque : ce service est
      agnostique, et un autre adaptateur exposera la même commodité sans hériter de celle-ci. */
  private static stackOf(e: unknown): string {
    const withFullStack = e as { fullStack?: unknown } | null | undefined;
    if (withFullStack && typeof withFullStack.fullStack === "function") return String((withFullStack.fullStack as () => string)());
    if (e instanceof Error) {
      const cause = (e as any).cause;
      return (e.stack || e.message) + (cause instanceof Error && cause.stack ? "\n  cause : " + cause.stack : "");
    }
    return String(e);
  }

  /** Enregistre et renvoie le nouvel état d'un provider. `last_success` SURVIT aux échecs ultérieurs
      (l'UI peut afficher « en erreur depuis…, dernière réussite à… »). */
  private record(docId: string, config: IssueProviderConfig,
                 s: { ok: boolean; message: string; attemptIso: string | null; successIso?: string; counts?: IssueSyncCounts }): IssueProviderStatus {
    let perDoc = this.status.get(docId);
    if (!perDoc) { perDoc = new Map(); this.status.set(docId, perDoc); }
    const prior = perDoc.get(config.id);
    const next: IssueProviderStatus = {
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
