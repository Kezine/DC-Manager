import type { DocumentStore } from "../documents.js";
import { Logger } from "../logger.js";
import { Changeset } from "../../../src-shared/DocumentChangeset.js";   // marqueur de module (pastille d'onglet)
import {
  OPTION_AUTO_REPLICATE, TRACKER_STATUS_CATEGORY_FALLBACK,
  type InterventionForPush, type InterventionTrackerSource, type TrackerDegradeSink,
  type TrackerProviderAdapter, type TrackerProviderConfig, type TrackerProviderConfigSource,
  type TrackerPushContent, type TrackerPushKind, type TrackerStatePatch, type TrackerTicketState,
} from "./TrackerProvider.js";
import { JiraAdapter } from "./JiraAdapter.js";
import { TrackerLabels } from "./TrackerLabels.js";
import { TrackerPassScope } from "./TrackerPassScope.js";

/* =============================================================================
   MOTEUR DU PONT INTERVENTIONS ⇄ TRACKER — module `tracker/` amovible.

   Il fait DEUX choses, dans cet ordre, par couple document × provider :
   ① la POUSSÉE des interventions dues (création ou mise à jour du CONTENU) ;
   ② le RETOUR D'ÉTAT des interventions déjà répliquées (statut, assigné).

   ── LE PARTAGE DES VÉRITÉS (la clé de voûte) ─────────────────────────────────
   DC Manager fait foi sur le CONTENU (titre, description, type, priorité,
   échéance, étiquettes `DCM-*`) ; le tracker fait foi sur le TRAITEMENT (statut,
   assigné), en LECTURE SEULE. Le `status` DC Manager n'est JAMAIS poussé et le
   statut du tracker n'écrase JAMAIS rien : deux workflows coexistent, sans
   ping-pong possible.

   ── TOLÉRANCE : LA POUSSÉE N'EST JAMAIS BLOQUANTE ────────────────────────────
   L'enregistrement d'une intervention réussit tracker éteint. La poussée est une
   CONSÉQUENCE asynchrone, pas une condition : le hook `onInterventionWrite` marque
   la poussée DUE (colonne persistée) et rend la main immédiatement. Un échec pose
   un état `error` STABLE — pas une rafale : il est rejoué à la passe périodique et
   par l'action manuelle, jamais en boucle immédiate (risque n°3 du cadrage).
   `pending`/`error` étant PERSISTÉS, un redémarrage du serveur ne perd aucune
   poussée : la passe suivante les ramasse.

   ── CE QU'ON NE DÉTRUIT JAMAIS ───────────────────────────────────────────────
   Aucune suppression distante (une intervention supprimée laisse son ticket
   vivre), aucune suppression locale (un ticket introuvable rend l'intervention
   « introuvable », jamais absente), aucune étiquette étrangère touchée (le diff
   ne voit que le sous-ensemble `DCM-*`, cf. `TrackerLabels`).

   ── AGNOSTIQUE DE MARQUE ─────────────────────────────────────────────────────
   Ce fichier ne connaît que le contrat `TrackerProviderAdapter`. Le SEUL endroit
   qui nomme une marque est la fabrique `adapterFor` — c'est le point d'extension
   n°2 du chantier (ajouter une marque = 1 adaptateur + 1 ligne ici + 1 branche
   d'options de validation + 1 option du <select> côté UI). Un test relit les
   sources des modules génériques pour vérifier qu'aucune marque n'y a fui.

   ── DÉPENDANCE INVERSÉE ──────────────────────────────────────────────────────
   Rien de `interventions/` n'est importé : le module travaille sur l'interface
   `InterventionTrackerSource`, déclarée chez lui (cf. `TrackerProvider.ts`) et
   satisfaite structurellement par `InterventionsModule` au bootstrap. Le
   `DocumentStore`, lui, est le CŒUR (autorisé) : il sert UNIQUEMENT à résoudre les
   objets liés pour composer les étiquettes.

   Pas d'Express ici : les routes vivent dans `TrackerModule.ts`. Le bus live est vu
   par une interface minimale — `LiveBus` la satisfait, un stub de test aussi.
   ============================================================================= */

/** Ce que le moteur exige du bus live (publication seule — jamais d'abonnement ici). */
export interface TrackerLivePublisher {
  publish(docId: string, data: unknown): void;
}

/** CONSOMMATEUR de signalement de problèmes persistants — DÉPENDANCE INVERSÉE (même patron que les
    modules vm/ et wifi/). Le service déclare ICI le contrat MINIMAL qu'il attend d'un module de
    notifications, mais n'importe RIEN de `notify/` : les features restent amovibles indépendamment.
    C'est `index.ts` qui PONTE (typage STRUCTUREL) le NotifyModule vers cette interface au bootstrap.
    `raise`/`resolve` sont fire-and-forget : le moteur notify gère TOUT l'anti-spam (déduplication
    par clé, rappels espacés) — le producteur ne compte rien. */
export interface ProblemReporter {
  raise(key: string, event: { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id?: string | null }): void;
  resolve(key: string): void;
}

/** Compteurs d'UNE passe — les deux moitiés du pont, séparément (une poussée en échec et un retour
    d'état parfait ne doivent pas se compenser dans un résumé). */
export interface TrackerSyncCounts {
  /** Poussées DUES trouvées (pending + error) pour ce provider. */
  push_due: number;
  /** Poussées RÉUSSIES à cette passe. */
  pushed: number;
  /** Poussées en ÉCHEC à cette passe (état `error` persisté, rejoué à la suivante). */
  push_failed: number;
  /** Poussées REPORTÉES par le plafond de passe — 0 en régime normal. */
  push_skipped: number;
  /** Interventions RÉPLIQUÉES pour ce provider (l'assiette du retour d'état). */
  tracked: number;
  /** Identifiants réellement DEMANDÉS au tracker (≤ `tracked` si le plafond a joué). */
  queried: number;
  /** Interventions dont l'état de suivi a CHANGÉ (donc été écrit). */
  updated: number;
  /** Tickets INTROUVABLES à cette passe (supprimés, projet archivé, permission perdue). */
  missing: number;
  /** Interventions dont l'état n'a pas bougé — aucune écriture (idempotence). */
  unchanged: number;
  /** Interventions répliquées REPORTÉES au prochain passage par le plafond — 0 en régime normal. */
  skipped: number;
}

/** État de synchro d'UN provider d'UN document — matière de `GET …/tracker/status`. En mémoire
    uniquement (reperdu au redémarrage — assumé : c'est un état opérationnel, pas une donnée).
    ⚠ DUPLICATION assumée : le client portera un MIROIR de ce DTO réseau (lot P3). */
export interface TrackerProviderStatus {
  provider_id: string;
  kind: string;
  /** Période de synchro automatique (0 = manuelle) — reprise de la config (affichage UI). */
  interval_sec: number;
  /** Dernière TENTATIVE (ISO). null = jamais synchronisé depuis le démarrage. */
  last_attempt: string | null;
  /** Dernière synchro RÉUSSIE (ISO) — conservée quand une tentative ultérieure échoue. */
  last_success: string | null;
  ok: boolean;
  /** Résumé lisible (compteurs, dégradés) ou message d'erreur — JAMAIS le jeton d'API. */
  message: string;
  counts: TrackerSyncCounts | null;
}

/** NATURE d'un refus d'action manuelle. Existe pour que la ROUTE choisisse son code HTTP sans
    réinterpréter un message : `invalid` = demande incomplète/incohérente (400) · `not_found` =
    document ou intervention inconnus (404) · `conflict` = déjà répliquée (409) · `tracker` = le
    tracker a REFUSÉ (422 : la requête est bien formée, c'est la demande qui est inexploitable). */
export type TrackerActionFailure = "invalid" | "not_found" | "conflict" | "tracker";

/** Résultat d'une action manuelle (« Répliquer », « Mettre à jour le ticket »). */
export interface TrackerActionResult {
  ok: boolean;
  /** Nature du refus (null en succès) — cf. `TrackerActionFailure`. */
  failure: TrackerActionFailure | null;
  provider_id: string | null;
  /** Identité distante du ticket (créé, lié ou déjà connu) — null si l'action n'a rien pu établir. */
  ext_id: string | null;
  /** Clé LISIBLE du ticket. 🚨 Rendue MÊME en échec quand un ticket a bien été créé : c'est la
      seule information qui rende la situation rattrapable. */
  key: string | null;
  /** Message lisible et ACTIONNABLE — jamais le jeton. Sur un refus du TRACKER, c'est SON message,
      transmis TEL QUEL. */
  message: string;
}

/** Résultat interne d'une poussée (création ou mise à jour). */
interface PushOutcome {
  ok: boolean;
  message: string;
  extId: string | null;
  key: string | null;
  /** Messages de DÉGRADÉ accumulés (ex. priorité refusée par le projet). */
  degraded: string[];
}

export class TrackerSyncService {
  /** Délai MINIMAL par défaut entre DEUX passes d'un même couple document×provider (anti-rafale) :
      Node sérialise les requêtes, mais deux POST …/tracker/sync quasi simultanés déclencheraient deux
      passes SUCCESSIVES — la seconde re-résoudrait toute l'assiette pour rien. Sous ce délai,
      l'appelant reçoit le dernier statut (annoté) au lieu d'une nouvelle passe. */
  static readonly DEFAULT_MIN_INTERVAL_SEC = 10;

  /** 🚨 PLAFOND d'interventions répliquées interrogées par passe. Contrairement à `vm/` et `wifi/`,
      où la SOURCE borne naturellement le volume, l'assiette est ici PILOTÉE PAR L'UTILISATEUR : rien
      n'empêche un document de répliquer des milliers d'interventions, et une passe non bornée
      finirait par marteler le tracker (429) ou dépasser tout délai raisonnable.
      500 = 5 lots de 100 chez un adaptateur qui résout par lots — coûteux mais pas déraisonnable.
      ⚠ Ce qui est tronqué est JOURNALISÉ et remonté DANS LE STATUT, et le ROULEMENT
      (`TrackerPassScope` + curseurs) garantit que le reliquat n'est jamais le même. */
  static readonly MAX_TICKETS_PER_PASS = 500;

  /** Plafond de POUSSÉES par passe. Une poussée coûte 1 à 2 requêtes ÉCRIVANTES ; tracker éteint,
      chacune consomme en plus tout le délai de la requête. Sans plafond, une passe pourrait tenir le
      verrou anti-chevauchement pendant des heures. Le ROULEMENT s'applique ici aussi : le reliquat
      d'une passe passe en tête de la suivante (cf. `TrackerPassScope`). */
  static readonly MAX_PUSHES_PER_PASS = 50;

  /** Libellé de statut posé sur une intervention dont le ticket est INTROUVABLE. Écrit dans le
      champ « statut BRUT », ce qui est assumé : la colonne porte ce que l'opérateur doit LIRE, et
      « introuvable » est un fait, pas une traduction du vocabulaire d'un workflow. La CATÉGORIE,
      elle, retombe sur `unknown` — c'est elle qui pilote pastilles et tris. */
  static readonly NOT_FOUND_STATUS = "introuvable";

  /** docId → providerId → dernier état connu. */
  private readonly status = new Map<string, Map<string, TrackerProviderStatus>>();
  /** Curseurs de ROULEMENT des passes plafonnées. Clé = `[docId, providerId, phase]` sérialisée en
      JSON (jamais une concaténation : ni un id de document ni un id de provider n'ont de jeu de
      caractères garanti, et `"a"+"bc"` collisionnerait avec `"ab"+"c"`). Deux phases INDÉPENDANTES —
      la poussée et le retour d'état ne parcourent pas la même liste.
      En mémoire, comme `status` : reperdu au redémarrage, ce qui au pire refait un tour depuis le
      début — jamais une zone morte. */
  private readonly cursors = new Map<string, number>();
  /** Couples document×provider EN COURS (anti-chevauchement timer ↔ synchro manuelle). */
  private readonly running = new Set<string>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    /** Cœur : sert UNIQUEMENT à résoudre les objets liés (étiquettes `DCM-*`). */
    private readonly docs: DocumentStore,
    /** Surface du module interventions, vue par CONTRAT (dépendance inversée — cf. l'en-tête). */
    private readonly interventions: InterventionTrackerSource,
    /** SOURCE de config vue par CONTRAT : base chiffrée en production, stub minimal en test. */
    private readonly providers: TrackerProviderConfigSource,
    private readonly log: Logger = new Logger("error"),
    /** Fabrique d'adaptateur INJECTÉE (stub en test). Défaut : par `kind` de la config. */
    private readonly makeAdapter: (config: TrackerProviderConfig) => TrackerProviderAdapter = TrackerSyncService.adapterFor,
    /** Délai minimal entre deux passes (secondes) — injectable (0 en test). S'applique aussi aux
        timers : un `interval_sec` inférieur est de fait plafonné par ce délai. */
    private readonly minIntervalSec: number = TrackerSyncService.DEFAULT_MIN_INTERVAL_SEC,
    /** Rapporteur de problèmes persistants au module notifications — OPTIONNEL, injecté au bootstrap
        par typage structurel. undefined = feature notify absente → aucun signalement. */
    private readonly problems?: ProblemReporter,
    /** Bus live — OPTIONNEL : sans lui le pont fonctionne, les pastilles des AUTRES clients ne se
        rafraîchissent simplement pas toutes seules. */
    private readonly live?: TrackerLivePublisher,
    /** Plafonds injectables (tester la troncature sans fabriquer 500 lignes). */
    private readonly maxTicketsPerPass: number = TrackerSyncService.MAX_TICKETS_PER_PASS,
    private readonly maxPushesPerPass: number = TrackerSyncService.MAX_PUSHES_PER_PASS,
  ) {}

  /** FABRIQUE PAR MARQUE — LE point d'extension « nouvelle marque » côté runtime. Ajouter un tracker
      d'une autre marque = écrire son `XxxAdapter` (préfixe de marque) et ajouter UNE ligne ici. Un
      `kind` inconnu échoue à la SYNCHRO (statut en erreur pour CE provider), pas au chargement — les
      autres providers vivent. ⚠ La liste doit rester en phase avec
      `TrackerProviderConfigValidate.KIND_OPTION_SPECS` (un kind validable sans adaptateur donnerait
      un provider enregistrable mais mort) : un test de cohérence confronte les deux DANS LES DEUX SENS. */
  static adapterFor(config: TrackerProviderConfig): TrackerProviderAdapter {
    if (config.kind === "jira") return JiraAdapter.fromConfig(config);
    throw new Error("type de provider de tracker inconnu : « " + config.kind + " » (supportés : jira)");
  }

  /* --------------------------------------------------------------------------
     LE HOOK — tout ce que le pont apprend du module interventions
     -------------------------------------------------------------------------- */

  /** Appelé APRÈS chaque écriture réussie d'une intervention (branché dans `index.ts`).
      🚨 NE BLOQUE JAMAIS et NE JETTE JAMAIS : la réponse HTTP du PUT est déjà décidée, la poussée
      n'en est qu'une conséquence. On marque la poussée DUE (colonne persistée, donc rattrapable même
      si le processus meurt à la ligne suivante) puis on tente la poussée en tâche de fond.

      `delete` ne déclenche RIEN côté tracker : doctrine « jamais de suppression distante » — un
      ticket peut déjà avoir été vu, commenté, assigné ; un ticket en trop se ferme, un ticket
      supprimé ne revient pas. Il sortira simplement de l'assiette du retour d'état. */
  onInterventionWrite(docId: string, interventionId: string, kind: "put" | "delete"): void {
    if (kind === "delete") return;
    let due = false;
    try {
      due = this.markPushDue(docId, interventionId);
    } catch (e) {
      // Un pont qui casse ne doit pas contaminer le module interventions : on journalise et on rend
      // la main. L'intervention, elle, est bel et bien enregistrée.
      this.log.error("tracker : marquage de poussée en échec", docId, interventionId, e instanceof Error ? e.message : String(e));
      return;
    }
    if (!due) return;
    void this.pushIntervention(docId, interventionId).catch((e) =>
      this.log.error("tracker : poussée asynchrone — échec inattendu", docId, interventionId, e instanceof Error ? e.message : String(e)));
  }

  /** Décide si une écriture d'intervention rend une poussée DUE, et pose l'état persisté.
      Trois cas, et le troisième est le seul subtil :
      1. intervention DÉJÀ répliquée → poussée due (mise à jour du contenu) ;
      2. non répliquée, AUCUN provider en réplication automatique → rien (l'utilisateur répliquera à
         la main s'il le veut) ;
      3. non répliquée, PLUSIEURS providers en réplication automatique → ⚠ AMBIGU : une intervention
         = UN ticket, et rien ne permet de choisir un tracker à la place de l'utilisateur. On ne
         réplique donc PAS, et on le DIT dans le journal — un silence ici se lirait « la réplication
         ne marche pas ». Le choix revient à l'action manuelle « Répliquer ». */
  private markPushDue(docId: string, interventionId: string): boolean {
    const item = this.interventions.getOne(docId, interventionId);
    if (!item) return false;

    if (TrackerSyncService.text(item.tracker_ext_id) !== "") {
      this.interventions.applyTrackerState(docId, interventionId, { tracker_push_state: "pending" });
      return true;
    }

    const autos = this.autoReplicateProviders(docId);
    if (autos.length === 0) return false;
    if (autos.length > 1) {
      this.log.warn("tracker : réplication automatique AMBIGUË — plusieurs providers en automatique",
        docId, interventionId, autos.map((c) => c.id).join(", "),
        "→ aucune réplication automatique ; utilisez l'action « Répliquer » en désignant le provider");
      return false;
    }
    // ⚠ RÉFÉRENCE DÉJÀ SAISIE : l'utilisateur a renseigné une clé de ticket à la main. Créer
    // automatiquement un NOUVEAU ticket produirait un doublon de ce qu'il désignait — exactement ce
    // que l'action « Lier » existe pour éviter. On s'abstient donc, et on le journalise.
    if (TrackerSyncService.text(item.jira_ref) !== "") {
      this.log.info("tracker : réplication automatique ignorée — référence déjà saisie",
        docId, interventionId, TrackerSyncService.text(item.jira_ref),
        "→ utilisez « Répliquer » pour LIER le ticket existant, ou videz la référence pour en créer un");
      return false;
    }
    this.interventions.applyTrackerState(docId, interventionId, { tracker_provider_id: autos[0].id, tracker_push_state: "pending" });
    return true;
  }

  /** Providers du document en RÉPLICATION AUTOMATIQUE. L'option est lue par son NOM GÉNÉRIQUE
      (`OPTION_AUTO_REPLICATE`), jamais par marque : une marque qui ne la déclare pas est traitée
      comme « pas d'automatisme » — on ne crée pas chez un tiers sur une intention non exprimée. */
  private autoReplicateProviders(docId: string): TrackerProviderConfig[] {
    return this.providers.providersFor(docId).filter((config) => config.options && config.options[OPTION_AUTO_REPLICATE] === true);
  }

  /* --------------------------------------------------------------------------
     ACTIONS MANUELLES (routes) — répliquer, lier, re-pousser
     -------------------------------------------------------------------------- */

  /** RÉPLICATION MANUELLE d'une intervention : création d'un ticket, ou LIAISON d'un ticket existant
      (`link: true`, à partir de la référence déjà saisie dans `jira_ref`).

      ⚠ ADOPTION EN CONNAISSANCE DE CAUSE (risque n°6 du cadrage) : lier un ticket créé par une AUTRE
      source est parfaitement légitime (« ce ticket, c'est mon intervention »), mais DC Manager fait
      dès lors foi sur le contenu — la première poussée écrasera son titre et sa description. C'est
      à l'UI de le dire avant de demander cette action ; le serveur, lui, l'exécute. */
  async replicate(docId: string, interventionId: string, opts: { providerId?: string | null; link?: boolean } = {}): Promise<TrackerActionResult> {
    const refused = (failure: TrackerActionFailure, message: string, providerId: string | null = null): TrackerActionResult =>
      ({ ok: false, failure, provider_id: providerId, ext_id: null, key: null, message });

    const item = this.interventions.getOne(docId, interventionId);
    if (!item) return refused("not_found", "intervention inconnue");
    if (TrackerSyncService.text(item.tracker_ext_id) !== "") {
      return refused("conflict", "cette intervention est DÉJÀ répliquée (ticket « " + TrackerSyncService.text(item.jira_ref) + " ») — utilisez « Mettre à jour le ticket »", item.tracker_provider_id);
    }

    const configs = this.providers.providersFor(docId);
    if (configs.length === 0) return refused("invalid", "aucun provider de tracker configuré sur ce document — configurez-en un avant de répliquer");
    const wanted = TrackerSyncService.text(opts.providerId);
    let config: TrackerProviderConfig | null = null;
    if (wanted !== "") {
      config = configs.find((candidate) => candidate.id === wanted) || null;
      if (!config) return refused("invalid", "provider « " + wanted + " » inconnu sur ce document (configurés : " + configs.map((c) => c.id).join(", ") + ")");
    } else if (configs.length === 1) {
      config = configs[0];
    } else {
      // Aucun repli « le premier » : répliquer produit un effet IRRÉVERSIBLE chez un tiers — on ne
      // devine pas lequel.
      return refused("invalid", "ce document a plusieurs providers de tracker (" + configs.map((c) => c.id).join(", ") + ") — indiquez celui chez qui répliquer");
    }

    if (opts.link === true) return await this.linkExisting(docId, interventionId, item, config);

    // CRÉATION : on marque la poussée due AVANT de partir (si le processus meurt pendant l'appel
    // distant, la reprise sait qu'il y avait quelque chose à faire), puis on pousse pour de bon.
    this.interventions.applyTrackerState(docId, interventionId, { tracker_provider_id: config.id, tracker_push_state: "pending", tracker_push_error: null });
    const outcome = await this.pushIntervention(docId, interventionId);
    this.publishInterventions(docId, "Réplication · " + config.id);
    return {
      ok: outcome.ok, failure: outcome.ok ? null : "tracker", provider_id: config.id,
      ext_id: outcome.extId, key: outcome.key, message: outcome.message,
    };
  }

  /** LIAISON d'un ticket EXISTANT désigné par la référence déjà saisie (clé lisible ou URL collée).
      Le ticket n'est pas créé : il est ADOPTÉ, puis une poussée aligne son contenu sur DC Manager. */
  private async linkExisting(docId: string, interventionId: string, item: InterventionForPush, config: TrackerProviderConfig): Promise<TrackerActionResult> {
    const reference = TrackerSyncService.text(item.jira_ref);
    if (reference === "") {
      return { ok: false, failure: "invalid", provider_id: config.id, ext_id: null, key: null, message: "aucune référence de ticket à lier — renseignez la référence du ticket sur l'intervention, ou créez-en un nouveau" };
    }
    let state: TrackerTicketState | null;
    try {
      state = await this.makeAdapter(config).lookup(reference);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("tracker : liaison — le provider a échoué", docId, interventionId, config.id, message);
      return { ok: false, failure: "tracker", provider_id: config.id, ext_id: null, key: null, message };
    }
    if (state === null) {
      return {
        ok: false, failure: "tracker", provider_id: config.id, ext_id: null, key: null,
        message: "ticket « " + reference + " » introuvable ou inaccessible — vérifiez la référence et les droits du compte de service sur son projet",
      };
    }
    // 🚨 L'IDENTITÉ D'ABORD (leçon v1) : `ext_id` est l'identifiant INTERNE, jamais la référence
    // saisie — une clé change au déplacement de projet.
    this.interventions.applyTrackerState(docId, interventionId, {
      tracker_provider_id: config.id,
      tracker_ext_id: state.ext_id,
      jira_ref: state.key !== "" ? state.key : null,
      tracker_url: state.url,
      tracker_status: state.status,
      tracker_status_category: state.status_category,
      tracker_assignee: state.assignee,
      tracker_last_sync: new Date().toISOString(),
      tracker_push_state: "pending",
      tracker_push_error: null,
    });
    this.log.info("tracker : ticket EXISTANT lié à une intervention", docId, interventionId, config.id, state.key + " (ext_id " + state.ext_id + ")");
    // Le contenu DC Manager fait foi : on aligne le ticket adopté immédiatement.
    const outcome = await this.pushIntervention(docId, interventionId);
    this.publishInterventions(docId, "Liaison · " + config.id);
    return {
      ok: outcome.ok, failure: outcome.ok ? null : "tracker", provider_id: config.id,
      ext_id: state.ext_id, key: state.key || null,
      message: outcome.ok
        ? "ticket « " + (state.key || state.ext_id) + " » lié et mis à jour"
        : "ticket « " + (state.key || state.ext_id) + " » lié, mais la mise à jour de son contenu a échoué — " + outcome.message,
    };
  }

  /** POUSSÉE MANUELLE (« Mettre à jour le ticket ») — la porte de récupération d'un échec (E4). */
  async pushNow(docId: string, interventionId: string): Promise<TrackerActionResult> {
    const item = this.interventions.getOne(docId, interventionId);
    if (!item) return { ok: false, failure: "not_found", provider_id: null, ext_id: null, key: null, message: "intervention inconnue" };
    if (TrackerSyncService.text(item.tracker_provider_id) === "") {
      return { ok: false, failure: "invalid", provider_id: null, ext_id: null, key: null, message: "cette intervention n'est pas répliquée — utilisez « Répliquer » d'abord" };
    }
    this.interventions.applyTrackerState(docId, interventionId, { tracker_push_state: "pending" });
    const outcome = await this.pushIntervention(docId, interventionId);
    this.publishInterventions(docId, "Poussée · " + TrackerSyncService.text(item.tracker_provider_id));
    return {
      ok: outcome.ok, failure: outcome.ok ? null : "tracker", provider_id: item.tracker_provider_id,
      ext_id: outcome.extId, key: outcome.key, message: outcome.message,
    };
  }

  /* --------------------------------------------------------------------------
     LA POUSSÉE (sens DCM → tracker)
     -------------------------------------------------------------------------- */

  /** Pousse UNE intervention : création si elle n'a pas encore d'identité distante, mise à jour
      sinon. NE JETTE JAMAIS — elle rend un `PushOutcome` et laisse derrière elle un état PERSISTÉ
      (`synced` ou `error` + message actionnable).

      ⚠ RELECTURE AU MOMENT DE POUSSER (risque n°4 du cadrage) : l'intervention est relue ICI, pas
      capturée au moment du hook. Une édition concurrente pendant l'appel distant gagne donc — c'est
      le comportement voulu (« dernier état gagne »), et l'inverse pousserait une version périmée. */
  private async pushIntervention(docId: string, interventionId: string): Promise<PushOutcome> {
    const degraded: string[] = [];
    const degrade: TrackerDegradeSink = (message) => {
      degraded.push(message);
      this.log.warn("tracker : poussée DÉGRADÉE", docId, interventionId, message);
    };
    const failed = (message: string, key: string | null = null, extId: string | null = null): PushOutcome => {
      this.failPush(docId, interventionId, message);
      return { ok: false, message, extId, key, degraded };
    };

    const item = this.interventions.getOne(docId, interventionId);
    // Supprimée entre le marquage et la poussée : ce n'est pas un échec, il n'y a plus rien à faire.
    if (!item) return { ok: true, message: "intervention disparue avant la poussée — rien à pousser", extId: null, key: null, degraded };

    const providerId = TrackerSyncService.text(item.tracker_provider_id);
    if (providerId === "") return failed("aucun provider de réplication désigné pour cette intervention");
    const config = this.providers.providersFor(docId).find((candidate) => candidate.id === providerId) || null;
    if (!config) {
      return failed("provider « " + providerId + " » introuvable ou inutilisable (supprimé, ou jeton indéchiffrable) — reconfigurez-le pour reprendre la réplication");
    }

    const content = this.composeContent(docId, item);
    let adapter: TrackerProviderAdapter;
    try { adapter = this.makeAdapter(config); }
    catch (e) { return failed(e instanceof Error ? e.message : String(e)); }

    const extId = TrackerSyncService.text(item.tracker_ext_id);
    try {
      return extId === ""
        ? await this.createRemote(docId, interventionId, config, adapter, content, degraded, degrade)
        : await this.updateRemote(docId, interventionId, adapter, extId, content, degraded, degrade);
    } catch (e) {
      // Message du tracker transmis TEL QUEL : c'est lui qui dit quoi faire (« le champ X est
      // requis »). L'envelopper le rendrait inexploitable.
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("tracker : poussée en échec", docId, interventionId, config.id, message);
      this.log.warn("tracker : pile d'erreur\n" + TrackerSyncService.stackOf(e));
      return failed(message, null, extId === "" ? null : extId);
    }
  }

  /** CRÉATION du ticket distant, puis enregistrement local.
      🚨 L'ORDRE EST IMPÉRATIF, et l'IDENTITÉ EST ÉCRITE AVANT TOUT LE RESTE. Un ticket créé chez un
      tiers doit toujours être rattrapable : si l'écriture locale échoue APRÈS la création, le ticket
      EXISTE — la clé doit alors survivre quelque part, et à défaut de la colonne d'identité, au
      moins dans le message d'erreur persisté. Jamais de suppression compensatoire côté tracker : on
      ne détruit pas dans un système tiers pour rattraper NOTRE propre écriture. */
  private async createRemote(
    docId: string, interventionId: string, config: TrackerProviderConfig,
    adapter: TrackerProviderAdapter, content: TrackerPushContent,
    degraded: string[], degrade: TrackerDegradeSink,
  ): Promise<PushOutcome> {
    const state = await adapter.createIssue(content, degrade);
    const key = state.key.trim();

    try {
      this.interventions.applyTrackerState(docId, interventionId, {
        tracker_provider_id: config.id,
        tracker_ext_id: state.ext_id,
        // La clé va dans le champ que l'utilisateur consulte DÉJÀ : le lien `JIRA_BASE_URL` marche
        // dès lors sans une ligne de code de plus.
        jira_ref: key !== "" ? key : null,
        tracker_url: state.url,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const message = "ticket " + (key ? "« " + key + " » " : "") + "CRÉÉ chez le tracker, mais son identité n'a PAS pu être enregistrée ici (" + detail + ")"
        + (key ? " — reprenez-le par « Répliquer » en mode LIAISON avec la clé « " + key + " »" : "");
      this.log.error("tracker : ÉCHEC PARTIEL — ticket créé, identité non enregistrée", docId, interventionId, key, detail);
      this.failPush(docId, interventionId, message);
      return { ok: false, message, extId: state.ext_id, key: key || null, degraded };
    }

    this.safeApply(docId, interventionId, {
      tracker_push_state: "synced",
      tracker_push_error: null,
      tracker_status: state.status,
      tracker_status_category: state.status_category,
      tracker_assignee: state.assignee,
      tracker_last_sync: new Date().toISOString(),
    });
    this.log.info("tracker : intervention RÉPLIQUÉE", docId, interventionId, config.id, key + " (ext_id " + state.ext_id + ")");
    return { ok: true, message: "ticket « " + (key || state.ext_id) + " » créé", extId: state.ext_id, key: key || null, degraded };
  }

  /** MISE À JOUR du contenu d'un ticket déjà répliqué.
      La relecture préalable n'est PAS un confort : c'est elle qui donne les étiquettes COURANTES,
      seule base d'un diff qui n'effleure pas les étiquettes des autres sources du projet partagé. */
  private async updateRemote(
    docId: string, interventionId: string, adapter: TrackerProviderAdapter, extId: string,
    content: TrackerPushContent, degraded: string[], degrade: TrackerDegradeSink,
  ): Promise<PushOutcome> {
    const current = await adapter.lookup(extId);
    if (current === null) {
      const message = "ticket introuvable ou inaccessible chez le tracker (identifiant « " + extId + " ») — il a pu être supprimé, déplacé hors de portée, ou le compte de service a perdu ses droits";
      this.failPush(docId, interventionId, message);
      // L'état de suivi reflète le constat : introuvable, sans rien supprimer localement.
      this.safeApply(docId, interventionId, { tracker_status: TrackerSyncService.NOT_FOUND_STATUS, tracker_status_category: TRACKER_STATUS_CATEGORY_FALLBACK });
      return { ok: false, message, extId, key: null, degraded };
    }

    const diff = TrackerLabels.diff(content.labels, current.labels);
    await adapter.updateIssue(extId, content, diff.add, diff.remove, degrade);

    const key = current.key.trim();
    this.safeApply(docId, interventionId, {
      tracker_push_state: "synced",
      tracker_push_error: null,
      ...(key !== "" ? { jira_ref: key } : {}),
      tracker_url: current.url,
      tracker_status: current.status,
      tracker_status_category: current.status_category,
      tracker_assignee: current.assignee,
      tracker_last_sync: new Date().toISOString(),
    });
    this.log.info("tracker : ticket mis à jour", docId, interventionId, key || extId,
      "labels +" + diff.add.length + " -" + diff.remove.length);
    return { ok: true, message: "ticket « " + (key || extId) + " » mis à jour", extId, key: key || null, degraded };
  }

  /** Compose le CONTENU poussé depuis une intervention relue (cf. §5 du cadrage — le mapping).
      ⚠ Le `status` DC Manager n'y figure PAS : il n'est JAMAIS poussé (E3). */
  private composeContent(docId: string, item: InterventionForPush): TrackerPushContent {
    return {
      summary: typeof item.title === "string" ? item.title : "",
      description: typeof item.description === "string" ? item.description : "",
      kind: (item.kind === "incident" ? "incident" : "intervention") as TrackerPushKind,
      labels: this.labelsFor(docId, item.links),
      priority: TrackerSyncService.text(item.priority) || null,
      duedate: TrackerSyncService.dateOnly(item.planned_end),
    };
  }

  /** Étiquettes `DCM-*` DÉSIRÉES : les liens de l'intervention RÉSOLUS contre le document (c'est le
      NOM de l'objet qui part, pas son identifiant — choix utilisateur explicite).
      ⚠ Une cible DISPARUE (lien orphelin, toléré par conception côté interventions) ne produit AUCUN
      label : ni son identifiant brut (illisible dans un tracker), ni une étiquette « introuvable »
      (qui polluerait le projet et ne désignerait rien). */
  private labelsFor(docId: string, links: Array<{ target_kind: string; target_id: string }>): string[] {
    const repo = this.docs.repo(docId);
    if (!repo) return [];
    const targets: Array<{ kind: string; name: string }> = [];
    for (const link of Array.isArray(links) ? links : []) {
      const collection = TrackerLabels.collectionOf(link && link.target_kind);
      if (collection === null) continue;
      const id = TrackerSyncService.text(link.target_id);
      if (id === "") continue;
      let record: { [k: string]: any } | null = null;
      try { record = repo.getOne(collection, id); }
      catch { record = null; }   // collection inconnue d'un document ancien : une étiquette de moins, jamais une passe perdue
      if (!record) continue;
      const name = typeof record.name === "string" ? record.name : "";
      targets.push({ kind: link.target_kind, name });
    }
    return TrackerLabels.compose(targets);
  }

  /** Pose l'état d'ÉCHEC de poussée : `error` STABLE + message ACTIONNABLE (celui du tracker, intact).
      Best-effort : si même cette écriture échoue, on journalise — refuser de continuer ne servirait
      personne. */
  private failPush(docId: string, interventionId: string, message: string): void {
    this.safeApply(docId, interventionId, { tracker_push_state: "error", tracker_push_error: message });
  }

  /** Écriture d'état TOLÉRANTE : une base momentanément indisponible ne doit pas transformer une
      poussée réussie en exception qui remonterait jusqu'à un timer. */
  private safeApply(docId: string, interventionId: string, patch: TrackerStatePatch): void {
    try {
      this.interventions.applyTrackerState(docId, interventionId, patch);
    } catch (e) {
      this.log.error("tracker : écriture de l'état de suivi en échec", docId, interventionId, e instanceof Error ? e.message : String(e));
    }
  }

  /* --------------------------------------------------------------------------
     LA PASSE (poussées dues + retour d'état)
     -------------------------------------------------------------------------- */

  /** Synchronise TOUS les providers d'un document (bouton « Synchroniser », séquentiel : volumes
      faibles, et un échec n'empêche pas les suivants). */
  async syncDocument(docId: string): Promise<TrackerProviderStatus[]> {
    const results: TrackerProviderStatus[] = [];
    for (const config of this.providers.providersFor(docId)) results.push(await this.syncProvider(docId, config));
    return results;
  }

  /** Synchronise UN provider d'UN document. Ne JETTE jamais : tout aboutit à un statut (ok ou
      erreur) — l'état local est conservé en cas d'échec (contrat d'adaptateur). */
  async syncProvider(docId: string, config: TrackerProviderConfig): Promise<TrackerProviderStatus> {
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
        this.log.info("tracker : passe ignorée (anti-rafale)", docId, config.id, Math.round(elapsedMs / 1000) + "s écoulées, minimum " + this.minIntervalSec + "s");
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
      const problemKey = "tracker-sync:" + docId + ":" + config.id;
      if (status.ok) this.problems?.resolve(problemKey);
      else this.problems?.raise(problemKey, {
        event_type: "tracker-sync-failure",
        severity: "error",
        title: "Synchro du tracker en échec — " + config.id,
        body: status.message,   // résumé lisible SANS jeton (garanti par JiraHttp/ConfigDb)
        doc_id: docId,
      });
      return status;
    } finally {
      this.running.delete(key);
    }
  }

  /** UNE passe : ① poussées dues, ② retour d'état. L'ordre compte — une création faite en ① entre
      dans l'assiette de ② dès la même passe. */
  private async doSync(docId: string, config: TrackerProviderConfig): Promise<TrackerProviderStatus> {
    const attemptIso = new Date().toISOString();
    if (!this.docs.get(docId)) return this.record(docId, config, { ok: false, message: "document inconnu", attemptIso });

    this.log.info("tracker : passe démarrée", docId, config.id, "kind " + config.kind + ", timeout " + config.timeout_sec + "s");
    const counts: TrackerSyncCounts = {
      push_due: 0, pushed: 0, push_failed: 0, push_skipped: 0,
      tracked: 0, queried: 0, updated: 0, missing: 0, unchanged: 0, skipped: 0,
    };
    const notes: string[] = [];

    // ① POUSSÉES DUES (créations et mises à jour). Un échec de poussée n'interrompt pas la passe :
    //    il pose un état `error` et laisse le retour d'état se faire — les deux moitiés du pont sont
    //    indépendantes, et une panne d'écriture ne doit pas priver l'opérateur de la lecture.
    await this.pushPass(docId, config, counts, notes);

    // ② RETOUR D'ÉTAT.
    const pullError = await this.pullPass(docId, config, counts, notes);

    if (counts.updated > 0 || counts.pushed > 0) this.publishInterventions(docId, "Synchro Tracker · " + config.id);

    if (pullError !== null) return this.record(docId, config, { ok: false, message: pullError, attemptIso, counts });
    const ok = counts.push_failed === 0;
    const message = (notes.length ? notes.join(" · ") + " · " : "") + TrackerSyncService.summary(counts);
    this.log.info("tracker : passe terminée", docId, config.id, TrackerSyncService.summary(counts));
    // `last_success` n'avance QUE sur une passe entièrement réussie : c'est ce qui permet à l'UI
    // d'afficher « en erreur depuis…, dernière réussite à… ». Une poussée en échec suffit donc à ne
    // pas l'avancer, même si le retour d'état, lui, s'est bien passé.
    return this.record(docId, config, { ok, message, attemptIso, ...(ok ? { successIso: attemptIso } : {}), counts });
  }

  /** ① Ramasse et exécute les poussées DUES de ce provider (plafonnées et ROULANTES : une file
      d'échecs stables ne doit pas monopoliser toutes les passes au détriment de la fin de liste). */
  private async pushPass(docId: string, config: TrackerProviderConfig, counts: TrackerSyncCounts, notes: string[]): Promise<void> {
    const due = this.interventions.listPushDue(docId).filter((row) => TrackerSyncService.text(row.tracker_provider_id) === config.id);
    counts.push_due = due.length;
    if (due.length === 0) return;

    const cursorKey = JSON.stringify([docId, config.id, "push"]);
    const scope = TrackerPassScope.compute(due, this.maxPushesPerPass, this.cursors.get(cursorKey) || 0, "id", "tracker_push_state");
    this.cursors.set(cursorKey, scope.nextStart);
    counts.push_skipped = scope.skipped;
    if (scope.skipped > 0) {
      // ⚠ Le tri de `TrackerPassScope` se fait ici sur `tracker_push_state` : « error » trie AVANT
      // « pending », donc les échecs anciens repassent d'abord — et le ROULEMENT garantit que la
      // queue de file finit toujours par être servie, quoi qu'il arrive aux données.
      notes.push("PLAFOND DE POUSSÉES ATTEINT — " + scope.skipped + " poussée(s) reportée(s) (maximum " + this.maxPushesPerPass + " par passe)");
      this.log.warn("tracker : PLAFOND de poussées atteint", docId, config.id, due.length + " due(s), " + scope.batch.length + " tentée(s), " + scope.skipped + " reportée(s)");
    }

    const degraded: string[] = [];
    for (const interventionId of scope.batch) {
      const outcome = await this.pushIntervention(docId, interventionId);
      if (outcome.ok) counts.pushed++; else counts.push_failed++;
      degraded.push(...outcome.degraded);
    }
    // DÉGRADÉS remontés au statut : une réplication amputée d'un champ n'est PAS un échec, mais la
    // taire ferait croire à une réplication complète.
    if (degraded.length) notes.push(degraded.length + " poussée(s) DÉGRADÉE(S) — " + degraded[0]);
  }

  /** ② Retour d'état : `resolve` par LOTS sur l'assiette (plafond ROULANT), écriture IDEMPOTENTE.
      Rend un message d'erreur si la résolution elle-même a échoué, `null` sinon. */
  private async pullPass(docId: string, config: TrackerProviderConfig, counts: TrackerSyncCounts, notes: string[]): Promise<string | null> {
    const tracked = this.interventions.listTracked(docId).filter((row) => TrackerSyncService.text(row.tracker_provider_id) === config.id);
    counts.tracked = tracked.length;

    const cursorKey = JSON.stringify([docId, config.id, "pull"]);
    const scope = TrackerPassScope.compute(tracked, this.maxTicketsPerPass, this.cursors.get(cursorKey) || 0, "tracker_ext_id", "tracker_last_sync");
    // Le curseur avance AVANT de connaître l'issue de la passe, et c'est VOULU : une fenêtre qui
    // échoue systématiquement ne doit pas bloquer indéfiniment le tour des autres.
    this.cursors.set(cursorKey, scope.nextStart);
    counts.skipped = scope.skipped;
    if (scope.skipped > 0) {
      notes.push("PLAFOND DE PASSE ATTEINT — " + scope.skipped + " intervention(s) répliquée(s) non interrogée(s) (maximum " + this.maxTicketsPerPass + ") ; les passes suivantes prennent la suite par roulement");
      this.log.warn("tracker : PLAFOND de passe atteint", docId, config.id,
        tracked.length + " répliquée(s), " + scope.batch.length + " interrogée(s), " + scope.skipped + " reportée(s)");
    }
    if (scope.batch.length === 0) return null;   // rien de répliqué → on n'appelle même pas le tracker
    counts.queried = scope.batch.length;

    let adapter: TrackerProviderAdapter;
    try { adapter = this.makeAdapter(config); }
    catch (e) { return e instanceof Error ? e.message : String(e); }

    let found: TrackerTicketState[];
    let missing: string[];
    try {
      const resolution = await adapter.resolve(scope.batch);
      found = resolution.found;
      missing = resolution.missing;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("tracker : retour d'état en échec", docId, config.id, message);
      this.log.warn("tracker : pile d'erreur\n" + TrackerSyncService.stackOf(e));
      return message;
    }

    const byExtId = new Map(tracked.map((row) => [TrackerSyncService.text(row.tracker_ext_id), row]));
    const nowIso = new Date().toISOString();

    for (const state of found) {
      const row = byExtId.get(state.ext_id);
      if (!row) continue;   // le tracker a rendu un ticket qu'on n'a pas demandé — ignoré
      const patch: TrackerStatePatch = {};
      if ((row.tracker_status || "") !== state.status) patch.tracker_status = state.status;
      if ((row.tracker_status_category || "") !== state.status_category) patch.tracker_status_category = state.status_category;
      if ((row.tracker_assignee || null) !== state.assignee) patch.tracker_assignee = state.assignee;
      if ((row.tracker_url || null) !== state.url) patch.tracker_url = state.url;
      // La CLÉ suit le ticket : un déplacement de projet la change, et c'est elle que l'utilisateur
      // lit sur la fiche. L'identité (`ext_id`), elle, ne bouge pas.
      if (state.key !== "" && (row.jira_ref || "") !== state.key) patch.jira_ref = state.key;
      if (Object.keys(patch).length === 0) { counts.unchanged++; continue; }   // IDEMPOTENCE : rien à écrire
      patch.tracker_last_sync = nowIso;
      this.safeApply(docId, row.id, patch);
      counts.updated++;
    }

    for (const extId of missing) {
      const row = byExtId.get(extId);
      if (!row) continue;
      counts.missing++;
      // INTROUVABLE : jamais de suppression locale, jamais de re-création automatique — l'objet
      // porte des liens, une description et un cycle de vie que le tracker ne connaît pas.
      if ((row.tracker_status || "") === TrackerSyncService.NOT_FOUND_STATUS
        && (row.tracker_status_category || "") === TRACKER_STATUS_CATEGORY_FALLBACK) { counts.unchanged++; continue; }
      this.safeApply(docId, row.id, {
        tracker_status: TrackerSyncService.NOT_FOUND_STATUS,
        tracker_status_category: TRACKER_STATUS_CATEGORY_FALLBACK,
        tracker_last_sync: nowIso,
      });
      counts.updated++;
    }
    return null;
  }

  /* --------------------------------------------------------------------------
     STATUT, TIMERS, publication live
     -------------------------------------------------------------------------- */

  /** État courant des providers d'un document — les jamais-synchronisés apparaissent aussi (fusion
      config déclarée × état runtime), pour que l'UI liste ce qui est configuré.
      Consomme `summariesFor` (résumés SANS jeton) et NON `providersFor` : le chemin STATUT n'a besoin
      que d'id/kind/intervalle — inutile (et malsain) d'y faire circuler les jetons d'API. */
  statusFor(docId: string): TrackerProviderStatus[] {
    const summaries = this.providers.summariesFor(docId);
    const runtime = this.status.get(docId);
    // PURGE DES ÉTATS FANTÔMES : un provider RETIRÉ de la config laisserait indéfiniment son état
    // runtime ici — fuite mémoire lente, et entrée obsolète qui pourrait resurgir. `statusFor` est le
    // point de passage naturel de la purge (il connaît la config DÉCLARÉE).
    const configured = new Set(summaries.map((s) => s.id));
    if (runtime) {
      for (const id of [...runtime.keys()]) if (!configured.has(id)) runtime.delete(id);
    }
    // MÊME RÈGLE pour les CURSEURS de roulement : ils sont indexés par le MÊME couple
    // document×provider, et un provider retiré y laisserait sinon ses entrées pour toujours. Purger
    // un état runtime et pas l'autre est un piège de relecture — les deux vieillissent ensemble.
    // ⚠ La clé est un JSON `[docId, providerId, phase]` : on la DÉCODE plutôt que de la découper,
    // une concaténation n'aurait pas de séparateur sûr.
    for (const cursorKey of [...this.cursors.keys()]) {
      let parts: unknown;
      try { parts = JSON.parse(cursorKey); } catch { continue; }   // clé illisible (jamais produite ici) : on n'y touche pas
      if (Array.isArray(parts) && parts[0] === docId && !configured.has(String(parts[1]))) this.cursors.delete(cursorKey);
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
            this.log.error("tracker : passe périodique — échec inattendu", docId, config.id, e instanceof Error ? e.message : String(e)));
        }, config.interval_sec * 1000);
        // `unref` n'existe que sur le Timeout Node (pas dans le type DOM du build de test mixte) — cast assumé.
        (timer as any).unref?.();
        this.timers.push(timer);
        this.log.info("tracker : passe périodique armée", docId, config.id, config.interval_sec + "s");
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

  /** Publie l'événement live du module interventions : les AUTRES clients rafraîchissent pastilles et
      listings SANS recharger le document (`interventions.db` est une base séparée, hors révision du
      cœur → le `ReloadPlanner` du client ignore ce marqueur). `origin` n'est celui d'aucun client, ce
      qui est voulu : la mise à jour vient du serveur, TOUS doivent la voir. */
  private publishInterventions(docId: string, author: string): void {
    if (!this.live) return;
    try {
      this.live.publish(docId, { origin: "tracker-sync", by: { name: author, ip: "" }, changeset: Changeset.modules(["interventions"]) });
    } catch (e) {
      this.log.warn("tracker : publication live en échec", docId, e instanceof Error ? e.message : String(e));
    }
  }

  /* --------------------------------------------------------------------------
     Helpers privés / purs
     -------------------------------------------------------------------------- */

  /** Chaîne rognée d'une valeur potentiellement nulle — "" quand il n'y a rien d'exploitable. */
  private static text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  /** Partie DATE (`YYYY-MM-DD`, en UTC) d'un horodatage ISO — `null` si absent/illisible.
      UTC et non l'heure locale du serveur : `planned_end` est stocké en UTC, et convertir dans le
      fuseau de la machine ferait basculer l'échéance d'un jour selon l'endroit où tourne le serveur. */
  private static dateOnly(value: unknown): string | null {
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw === "") return null;
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return null;
    return new Date(at).toISOString().slice(0, 10);
  }

  /** Résumé lisible d'une passe — les deux moitiés du pont, séparément. */
  private static summary(counts: TrackerSyncCounts): string {
    return "poussées : " + counts.pushed + " OK, " + counts.push_failed + " en échec sur " + counts.push_due + " due(s)"
      + (counts.push_skipped ? " (" + counts.push_skipped + " reportée(s))" : "")
      + " · état : " + counts.tracked + " répliquée(s), " + counts.queried + " interrogée(s), "
      + counts.updated + " mise(s) à jour, " + counts.missing + " introuvable(s), " + counts.unchanged + " inchangée(s)"
      + (counts.skipped ? " (" + counts.skipped + " reportée(s))" : "");
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
  private record(docId: string, config: TrackerProviderConfig,
                 s: { ok: boolean; message: string; attemptIso: string | null; successIso?: string; counts?: TrackerSyncCounts }): TrackerProviderStatus {
    let perDoc = this.status.get(docId);
    if (!perDoc) { perDoc = new Map(); this.status.set(docId, perDoc); }
    const prior = perDoc.get(config.id);
    const next: TrackerProviderStatus = {
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
