import type { NotificationMessage, NotificationTarget, Notifier, NotifySeverity } from "./Notifier.js";

/* =============================================================================
   MOTEUR ANTI-SPAM DU SERVICE DE NOTIFICATIONS — cœur PUR du module `notify/`
   (aucun accès DB/réseau/horloge système : état, routage, journal et horloge
   INJECTÉS — testable en isolation, cf. Tests/modules/test-server.js).

   Sémantique (cadrage + décisions 2026-07-14) :
   - `raise(key, …)` — `key` = identité STABLE du problème (ex.
     `vm-sync:<docId>:<providerId>`). IDEMPOTENT PAR RUN : les détecteurs
     appellent raise à CHAQUE passe sans jamais spammer — envoi seulement si le
     problème est NOUVEAU ou si le rappel est DÛ (now ≥ next_remind_at).
   - `resolve(key)` — clôt le problème ; message « rétabli » UNE seule fois, et
     SEULEMENT si l'alerte initiale avait été effectivement envoyée (décision
     Q1 — pas de « rétabli » pour une alerte restée silencieuse).
   - RAPPELS à intervalle PAR TYPE d'événement (décision Q2 : défaut 12 h,
     réglable par type — d'où l'accès par FONCTION injectée, relue à chaque
     échéance pour suivre un réglage modifié à chaud).
   - Échec d'ENVOI : journalisé (last_error + historique), RETENTÉ au prochain
     rappel — pas de retry immédiat (le rappel EST le retry). `last_sent` n'est
     posé que si au moins UNE remise a réussi : c'est lui qui conditionne le
     message de rétablissement.

   Le message (title/body) est CONSERVÉ dans l'état : le timer de rappels
   (NotifyModule, S3) doit pouvoir re-notifier SANS que le producteur ne
   rappelle raise (producteurs à passes espacées, serveur redémarré…).
   ============================================================================= */

/** État persistant d'UN problème suivi — miroir de la table notification_states
    (notify.db, S3). Les horodatages sont des ISO 8601 (colonnes TEXT). */
export interface NotifyState {
  key: string;
  event_type: string;
  severity: NotifySeverity;
  doc_id: string | null;
  /** Dernier message connu du producteur — porté par l'état pour que les rappels
      autonomes (timer) reconstruisent la notification sans lui. */
  title: string;
  body: string;
  first_seen: string;
  /** Dernière remise RÉUSSIE (≥ 1 destinataire servi) — null tant que rien n'est parti.
      Conditionne le message de rétablissement (Q1). */
  last_sent: string | null;
  next_remind_at: string | null;
  remind_interval_sec: number;
  resolved_at: string | null;
  /** Dernier échec d'envoi (message SANS secret) — null si la dernière passe a réussi. */
  last_error: string | null;
}

/** Persistance de l'état — DÉLÉGUÉE (mémoire en test/S2, SQLite en S3).
    Contrat minimal : le moteur ne connaît ni SQL ni fichier. */
export interface NotifyStateStore {
  get(key: string): NotifyState | null;
  /** Insère ou remplace l'état complet (upsert par key). */
  set(state: NotifyState): void;
  /** États NON résolus (resolved_at null) — parcourus par la passe de rappels. */
  listActive(): NotifyState[];
}

/** Destinataire résolu par le ROUTAGE (abonnements par type × contact × canal ×
    instance) : l'instance de canal à employer + l'id de l'instance (journal). */
export interface ResolvedRecipient {
  /** Id de l'instance configurée (table notifier_instances) — pour l'historique. */
  notifier_id: string;
  notifier: Notifier;
  target: NotificationTarget;
}

/** Routage INJECTÉ : (type d'événement, document) → destinataires résolus.
    S3 le branche sur les tables subscriptions/notifier_instances + la
    collection contacts ; les tests injectent un stub. Relu À CHAQUE envoi
    (un abonnement ajouté est servi dès le prochain rappel). */
export type NotifyRouter = (event_type: string, doc_id: string | null) => ResolvedRecipient[];

/** Entrée du journal des remises (→ table notification_log, S3). Une entrée PAR
    destinataire tenté ; `phase` distingue première alerte / rappel / rétablissement. */
export interface NotifyJournalEntry {
  sent_at: string;
  key: string;
  event_type: string;
  contact_id: string;
  channel: string;
  notifier_id: string;
  phase: "alerte" | "rappel" | "retablissement";
  ok: boolean;
  /** Message d'erreur (sans secret — contrat Notifier) si ok=false, null sinon. */
  detail: string | null;
}

/** Intervalle de rappel par défaut : 12 h (décision Q2). */
export const DEFAULT_REMIND_INTERVAL_SEC = 12 * 3600;

/** Issue d'un raise — informative (journal/tests) ; les producteurs peuvent l'ignorer. */
export type RaiseOutcome = "sent" | "reminded" | "silenced";
/** Issue d'un resolve : notifié / clos sans message (jamais envoyée) / inconnu ou déjà clos. */
export type ResolveOutcome = "resolved-notified" | "resolved-silent" | "not-active";

export class NotifyEngine {
  private readonly store: NotifyStateStore;
  private readonly router: NotifyRouter;
  private readonly clock: () => Date;
  private readonly remindIntervalSec: (event_type: string) => number;
  private readonly journal: (entry: NotifyJournalEntry) => void;

  constructor(deps: {
    store: NotifyStateStore;
    router: NotifyRouter;
    /** Horloge injectée (tests : contrôlée ; prod : now). */
    clock?: () => Date;
    /** Intervalle de rappel PAR TYPE (secondes) — relu à chaque échéance (réglage à chaud). */
    remindIntervalSec?: (event_type: string) => number;
    /** Consignation des remises tentées (historique consultable) — no-op par défaut. */
    journal?: (entry: NotifyJournalEntry) => void;
  }) {
    this.store = deps.store;
    this.router = deps.router;
    this.clock = deps.clock || (() => new Date());
    this.remindIntervalSec = deps.remindIntervalSec || (() => DEFAULT_REMIND_INTERVAL_SEC);
    this.journal = deps.journal || (() => { /* pas d'historique branché */ });
  }

  /** Signale un problème (idempotent par run — appelable à CHAQUE passe du détecteur).
      Nouveau problème (ou ré-apparition après resolve) → envoi immédiat ; déjà suivi →
      envoi seulement si le rappel est dû, sinon silencieux (l'état mémorise quand même
      le dernier message/severity du producteur, pour des rappels fidèles). */
  async raise(key: string, event: { event_type: string; severity: NotifySeverity; title: string; body: string; doc_id?: string | null }): Promise<RaiseOutcome> {
    const now = this.clock();
    const existing = this.store.get(key);

    // NOUVEAU problème — ou RÉ-APPARITION d'un problème résolu (le même key re-signalé
    // après un resolve est un NOUVEL épisode : first_seen repart, l'alerte repart).
    if (!existing || existing.resolved_at !== null) {
      const interval = this.remindIntervalSec(event.event_type);
      const state: NotifyState = {
        key,
        event_type: event.event_type,
        severity: event.severity,
        doc_id: event.doc_id ?? null,
        title: event.title,
        body: event.body,
        first_seen: now.toISOString(),
        last_sent: null,
        next_remind_at: NotifyEngine.plusSec(now, interval),
        remind_interval_sec: interval,
        resolved_at: null,
        last_error: null,
      };
      await this.deliver(state, "alerte", now);
      this.store.set(state);
      return "sent";
    }

    // DÉJÀ SUIVI : rafraîchir le message porté par l'état (le producteur peut préciser
    // le diagnostic d'une passe à l'autre — le prochain rappel enverra la version à jour).
    existing.severity = event.severity;
    existing.title = event.title;
    existing.body = event.body;

    const due = existing.next_remind_at !== null && now.getTime() >= Date.parse(existing.next_remind_at);
    if (!due) {
      this.store.set(existing);
      return "silenced";
    }
    await this.remind(existing, now);
    return "reminded";
  }

  /** Clôt un problème. Message « rétabli » UNE fois, seulement si l'alerte avait été
      effectivement remise (last_sent posé — décision Q1). Inconnu/déjà clos = no-op. */
  async resolve(key: string): Promise<ResolveOutcome> {
    const state = this.store.get(key);
    if (!state || state.resolved_at !== null) return "not-active";
    const now = this.clock();
    state.resolved_at = now.toISOString();
    state.next_remind_at = null; // plus aucun rappel — le problème est clos
    const wasDelivered = state.last_sent !== null;
    if (wasDelivered) {
      // Le rétablissement N'EST PAS retenté en cas d'échec (pas de rappel après resolve) :
      // c'est un message de confort, l'état clos fait foi.
      await this.deliver(state, "retablissement", now);
    }
    this.store.set(state);
    return wasDelivered ? "resolved-notified" : "resolved-silent";
  }

  /** Passe de rappels AUTONOME (appelée par le timer du module, S3) : re-notifie tous
      les problèmes actifs dont l'échéance est atteinte — y compris ceux dont l'envoi
      initial avait échoué (le rappel EST le retry). Renvoie le nombre de rappels émis. */
  async runReminders(): Promise<number> {
    const now = this.clock();
    let reminded = 0;
    for (const state of this.store.listActive()) {
      if (state.next_remind_at === null || now.getTime() < Date.parse(state.next_remind_at)) continue;
      await this.remind(state, now);
      reminded++;
    }
    return reminded;
  }

  /* --------------------------------------------------------------------------
     Privé — remise aux destinataires + tenue de l'état
     -------------------------------------------------------------------------- */

  /** Rappel d'un état actif dû : replanifie (intervalle RELU — réglage à chaud) puis remet. */
  private async remind(state: NotifyState, now: Date): Promise<void> {
    const interval = this.remindIntervalSec(state.event_type);
    state.remind_interval_sec = interval;
    state.next_remind_at = NotifyEngine.plusSec(now, interval);
    await this.deliver(state, "rappel", now);
    this.store.set(state);
  }

  /** Remet le message de l'état à TOUS les destinataires routés (séquentiel — le volume
      est faible et l'ordre du journal reste lisible). Un échec n'empêche pas les autres
      remises ; il est journalisé et mémorisé (last_error), la réussite d'AU MOINS une
      remise pose last_sent. Aucun destinataire routé = silencieux (pas une erreur : les
      abonnements peuvent apparaître plus tard, le rappel suivant les servira). */
  private async deliver(state: NotifyState, phase: NotifyJournalEntry["phase"], now: Date): Promise<void> {
    const message = phase === "retablissement"
      ? {
        event_type: state.event_type,
        severity: "info" as NotifySeverity, // un rétablissement est une bonne nouvelle, quelle que soit la gravité d'origine
        title: "Rétabli — " + state.title,
        body: "Le problème signalé est rétabli : " + state.title,
        doc_id: state.doc_id,
      }
      : { event_type: state.event_type, severity: state.severity, title: state.title, body: state.body, doc_id: state.doc_id };

    const errors: string[] = [];
    let deliveredCount = 0;
    for (const recipient of this.router(state.event_type, state.doc_id)) {
      const full: NotificationMessage = { ...message, target: recipient.target };
      let detail: string | null = null;
      try {
        await recipient.notifier.send(full);
        deliveredCount++;
      } catch (e) {
        // Contrat Notifier : le message d'erreur ne contient aucun secret — sûr à stocker.
        detail = e instanceof Error ? e.message : String(e);
        errors.push(recipient.notifier.kind + ": " + detail);
      }
      this.journal({
        sent_at: now.toISOString(),
        key: state.key,
        event_type: state.event_type,
        contact_id: recipient.target.contact_id,
        channel: recipient.target.channel,
        notifier_id: recipient.notifier_id,
        phase,
        ok: detail === null,
        detail,
      });
    }
    if (deliveredCount > 0 && phase !== "retablissement") state.last_sent = now.toISOString();
    state.last_error = errors.length > 0 ? errors.join(" ; ") : null;
  }

  /** ISO 8601 de `date + seconds` (échéances stockées en TEXT). */
  private static plusSec(date: Date, seconds: number): string {
    return new Date(date.getTime() + seconds * 1000).toISOString();
  }
}
