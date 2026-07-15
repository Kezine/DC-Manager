/* =============================================================================
   VALIDATION PURE des objets de configuration du module `notify/` — instances
   de canaux (notifier_instances) et abonnements (subscriptions). Même
   philosophie que vm/ProviderConfigValidate : une classe PURE (ni DB, ni
   réseau), des messages d'erreur UNIQUES réutilisés par toutes les surfaces
   (routes REST, tests), et JAMAIS de secret dans un message (le jeton est
   validé par présence/type, jamais cité).
   ============================================================================= */

/** Kinds d'instance supportés en v1 (cadrage 2026-07-14, Q5) : console (dummy,
    aucune configuration) et webhook générique (POST JSON + jeton optionnel). */
export const NOTIFIER_KINDS = ["console", "webhook"] as const;
export type NotifierKind = (typeof NOTIFIER_KINDS)[number];

/** Canaux d'abonnement v1 — déterminent l'ADRESSE prise sur le contact
    (email → contact.email, sms → contact.phone). */
export const SUBSCRIPTION_CHANNELS = ["email", "sms"] as const;

/** Plafond de longueur du `text` en mode « envoi simplifié » d'un webhook. Le défaut (300) tient
    dans un SMS ; en dessous de 20 le message n'a plus de sens, au-delà de 5000 on sort du cas
    d'usage « passerelle simple ». Bornes VALIDÉES (grief hors bornes) — cf. parseInstance. */
export const SIMPLE_MAX_CHARS_DEFAULT = 300;
export const SIMPLE_MAX_CHARS_MIN = 20;
export const SIMPLE_MAX_CHARS_MAX = 5000;

/** Instance de canal VALIDÉE (sans le jeton — il voyage à part, chiffré à part). */
export interface NotifierInstanceCandidate {
  id: string;
  kind: NotifierKind;
  label: string;
  /** Endpoint du service (webhook) — null pour console. */
  url: string | null;
  enabled: boolean;
  /** Webhook : POST SIMPLIFIÉ { to, text } (deux clés) au lieu du payload complet. Défaut false. */
  simple: boolean;
  /** Webhook simplifié : plafond de longueur du texte compact (bornes [20, 5000], défaut 300). */
  simple_max_chars: number;
  /** Webhook NON simplifié : corps mis en forme HTML si true, texte brut sinon. Défaut false.
      Stocké même quand `simple` est actif (le mode simplifié l'IGNORE ; l'UI le masque). */
  html: boolean;
}

/** Abonnement VALIDÉ : route un TYPE d'événement vers un contact × canal × instance. */
export interface SubscriptionCandidate {
  id: string;
  /** null = tous les documents (abonnement global). */
  doc_id: string | null;
  /** Type d'événement ("cert-expiry", "vm-sync-failure", "test") ou "*" (tous). */
  event_type: string;
  /** Référence SOUPLE vers la collection contacts d'un document (garde-fou à l'affichage,
      pas de FK — la collection vit dans le document, pas dans notify.db). */
  contact_id: string;
  channel: (typeof SUBSCRIPTION_CHANNELS)[number];
  notifier_id: string;
  enabled: boolean;
}

/** Erreur de validation à N griefs — les routes la traduisent en 400 { issues }. */
export class NotifyConfigError extends Error {
  constructor(readonly issues: string[]) {
    super("configuration de notification invalide : " + issues.join(" · "));
    this.name = "NotifyConfigError";
  }
}

export class NotifyValidate {
  /** Valide/normalise une instance CANDIDATE (id fourni par l'URL, jeton HORS candidat).
      Jette NotifyConfigError avec TOUS les griefs (l'UI les montre d'un coup). */
  static parseInstance(id: string, candidate: Record<string, unknown>): NotifierInstanceCandidate {
    const issues: string[] = [];
    if (typeof id !== "string" || id.trim() === "") issues.push("id : requis (segment d'URL)");
    const kind = typeof candidate.kind === "string" ? candidate.kind.trim() : "";
    if (!(NOTIFIER_KINDS as readonly string[]).includes(kind)) {
      issues.push("kind : requis, parmi " + NOTIFIER_KINDS.join(" | "));
    }
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    if (label === "") issues.push("label : requis (nom lisible du canal)");
    let url: string | null = null;
    if (kind === "webhook") {
      const raw = typeof candidate.url === "string" ? candidate.url.trim() : "";
      if (raw === "") {
        issues.push("url : requise pour un webhook");
      } else {
        // http:// accepté À DESSEIN (services internes de l'utilisateur sur le LAN) — la
        // confidentialité du jeton sur le trajet relève du déploiement, pas de la validation.
        try {
          const parsed = new URL(raw);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") issues.push("url : protocole http(s) attendu");
          else url = raw;
        } catch {
          issues.push("url : invalide");
        }
      }
    } else if (typeof candidate.url === "string" && candidate.url.trim() !== "") {
      issues.push("url : sans objet pour le kind « console »");
    }
    // Réglages d'ENVOI propres au webhook. Pour un kind console ils sont SANS OBJET → ramenés aux
    // défauts SANS grief : contrairement à `url`, un booléen résiduel laissé par un formulaire ne
    // trahit pas une confusion de config (il ne « fuite » aucune donnée, il est simplement ignoré).
    let simple = false, html = false, simpleMaxChars = SIMPLE_MAX_CHARS_DEFAULT;
    if (kind === "webhook") {
      simple = candidate.simple === true;
      html = candidate.html === true;
      if (candidate.simple_max_chars !== undefined) {
        const n = typeof candidate.simple_max_chars === "number" && Number.isFinite(candidate.simple_max_chars)
          ? Math.floor(candidate.simple_max_chars) : NaN;
        if (!(n >= SIMPLE_MAX_CHARS_MIN && n <= SIMPLE_MAX_CHARS_MAX)) {
          issues.push("simple_max_chars : entier entre " + SIMPLE_MAX_CHARS_MIN + " et " + SIMPLE_MAX_CHARS_MAX + " attendu");
        } else simpleMaxChars = n;
      }
    }
    if (issues.length) throw new NotifyConfigError(issues);
    return {
      id: id.trim(), kind: kind as NotifierKind, label, url,
      enabled: candidate.enabled === undefined ? true : candidate.enabled === true,
      simple, simple_max_chars: simpleMaxChars, html,
    };
  }

  /** Valide/normalise un abonnement CANDIDAT (id fourni par l'URL). L'existence de
      l'instance référencée est vérifiée PAR LA FK (notify.db) ; celle du contact ne
      peut pas l'être ici (référence souple inter-bases — garde-fou à l'affichage). */
  static parseSubscription(id: string, candidate: Record<string, unknown>): SubscriptionCandidate {
    const issues: string[] = [];
    if (typeof id !== "string" || id.trim() === "") issues.push("id : requis (segment d'URL)");
    const eventType = typeof candidate.event_type === "string" ? candidate.event_type.trim() : "";
    if (eventType === "") issues.push("event_type : requis (« * » = tous les types)");
    const contactId = typeof candidate.contact_id === "string" ? candidate.contact_id.trim() : "";
    if (contactId === "") issues.push("contact_id : requis");
    const channel = typeof candidate.channel === "string" ? candidate.channel.trim() : "";
    if (!(SUBSCRIPTION_CHANNELS as readonly string[]).includes(channel)) {
      issues.push("channel : requis, parmi " + SUBSCRIPTION_CHANNELS.join(" | "));
    }
    const notifierId = typeof candidate.notifier_id === "string" ? candidate.notifier_id.trim() : "";
    if (notifierId === "") issues.push("notifier_id : requis (instance de canal)");
    const docId = typeof candidate.doc_id === "string" && candidate.doc_id.trim() !== "" ? candidate.doc_id.trim() : null;
    if (issues.length) throw new NotifyConfigError(issues);
    return {
      id: id.trim(), doc_id: docId, event_type: eventType, contact_id: contactId,
      channel: channel as SubscriptionCandidate["channel"], notifier_id: notifierId,
      enabled: candidate.enabled === undefined ? true : candidate.enabled === true,
    };
  }

  /** Valide un réglage d'intervalle de rappel PAR TYPE (page admin, décision Q2) :
      entier ≥ 60 s (borne basse anti-spam — en dessous, le rappel redevient du spam). */
  static parseRemindInterval(candidate: Record<string, unknown>): { event_type: string; remind_interval_sec: number } {
    const issues: string[] = [];
    const eventType = typeof candidate.event_type === "string" ? candidate.event_type.trim() : "";
    if (eventType === "") issues.push("event_type : requis");
    const interval = typeof candidate.remind_interval_sec === "number" && Number.isFinite(candidate.remind_interval_sec)
      ? Math.floor(candidate.remind_interval_sec) : NaN;
    if (!(interval >= 60)) issues.push("remind_interval_sec : entier ≥ 60 attendu (secondes)");
    if (issues.length) throw new NotifyConfigError(issues);
    return { event_type: eventType, remind_interval_sec: interval };
  }
}
