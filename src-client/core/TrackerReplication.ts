/* =============================================================================
   TrackerReplication — état de RÉPLICATION d'une intervention vers un tracker
   distant : est-elle répliquée, où en est la POUSSÉE de son contenu, et quel
   lien ouvrir. Classe PURE (aucun DOM, aucun store, aucun réseau, AUCUNE
   dépendance i18n : elle ne rend que des CLÉS de traduction, comme
   `InterventionsFormat` — la vue localise au point d'affichage).

   POURQUOI UN MODULE À PART de `core/TrackerStatus` (principe n°2) : les deux
   parlent de choses différentes, et les confondre ferait grossir le mauvais
   fichier. `TrackerStatus` classe l'état d'un TICKET (le tracker fait foi :
   statut, catégorie, introuvable) ; ce module-ci décrit ce que DC MANAGER sait
   de sa propre réplication (répliquée ou non, poussée à jour / en attente / en
   échec, quelle URL ouvrir). Le partage des vérités du chantier passe très
   exactement entre les deux.

   ── AGNOSTICISME DE MARQUE ───────────────────────────────────────────────────
   Aucun champ, aucune clé et aucun libellé ci-dessous ne nomme un tracker : tout
   passe par les colonnes `tracker_*`. La référence LISIBLE du ticket, elle, vit
   dans un champ HÉRITÉ de la feature interventions (antérieure au pont) que ce
   module ne touche pas : l'appelant lui a déjà donné une URL de repli s'il en
   avait une (cf. `ticketUrl`). C'est ce découpage qui garde ce fichier lisible
   par le verrou d'agnosticisme sans la moindre exemption.
   ============================================================================= */
import type { BadgeClass } from "./InterventionsFormat";

/** ÉTATS de poussée persistés par le pont — MIROIR de `TRACKER_PUSH_STATES` (serveur). Duplication
    assumée et signalée : la colonne vit dans `interventions.db`, base SERVEUR hors du schéma
    partagé, donc sans canal `src-shared/` par où la faire transiter (comparaison verrouillée par
    test). `none` n'en fait PAS partie : c'est l'absence de valeur, pas un état persisté. */
export const TRACKER_PUSH_STATES = ["synced", "pending", "error"] as const;

/** État de poussée, plus l'absence (`none` = jamais poussée / non répliquée). */
export type TrackerPushState = (typeof TRACKER_PUSH_STATES)[number] | "none";

/** Vue MINIMALE de l'état de réplication porté par une intervention — forme TOLÉRANTE (tout est
    optionnel et nullable) : ces colonnes sont vides tant que le module `tracker/` est absent, et
    ce module ne doit jamais dépendre du modèle complet des interventions. */
export interface TrackerReplicationState {
  /** Provider de réplication (null = non répliquée). */
  tracker_provider_id?: string | null;
  /** 🚨 Identifiant INTERNE du ticket distant — c'est LUI qui atteste la réplication, jamais la
      référence lisible : une clé change au déplacement de projet, et un utilisateur peut avoir
      saisi une référence à la main sur une intervention qui n'a jamais été répliquée. */
  tracker_ext_id?: string | null;
  tracker_status?: string | null;
  tracker_status_category?: string | null;
  tracker_assignee?: string | null;
  /** Lien d'interface du ticket, persisté tel que composé par l'adaptateur. */
  tracker_url?: string | null;
  /** Dernier retour d'état RÉUSSI (ISO). */
  tracker_last_sync?: string | null;
  tracker_push_state?: string | null;
  /** Dernier message d'échec de poussée — ACTIONNABLE (celui du tracker, intact). */
  tracker_push_error?: string | null;
}

export class TrackerReplication {
  /** L'intervention est-elle RÉPLIQUÉE ? Décidé sur l'identifiant INTERNE et rien d'autre (cf.
      `tracker_ext_id`) : c'est la seule marque d'une identité distante réellement établie. */
  static isReplicated(state: TrackerReplicationState | null | undefined): boolean {
    return TrackerReplication.text(state && state.tracker_ext_id) !== "";
  }

  /** État de POUSSÉE normalisé. Une valeur hors de l'ensemble fermé (base éditée à la main, version
      antérieure) est lue comme `none` : mieux vaut n'afficher aucun état qu'un état inventé. */
  static pushState(state: TrackerReplicationState | null | undefined): TrackerPushState {
    const raw = TrackerReplication.text(state && state.tracker_push_state);
    return (TRACKER_PUSH_STATES as readonly string[]).includes(raw) ? (raw as TrackerPushState) : "none";
  }

  /** Une poussée a-t-elle ÉCHOUÉ ? Seul état qui appelle une action de l'utilisateur (« Mettre à
      jour le ticket ») — `pending` se résorbe tout seul à la passe suivante. */
  static hasPushError(state: TrackerReplicationState | null | undefined): boolean {
    return TrackerReplication.pushState(state) === "error";
  }

  /** Message d'échec de poussée (rogné), "" si aucun. Le message vient du TRACKER et est transmis
      intact par le pont : c'est lui, et pas une reformulation, qui dit quel champ corriger. */
  static pushError(state: TrackerReplicationState | null | undefined): string {
    return TrackerReplication.text(state && state.tracker_push_error);
  }

  /** Clé i18n du libellé d'un état de poussée (ex. « tracker.ticket.push.error »). */
  static pushStateLabelKey(pushState: TrackerPushState): string { return "tracker.ticket.push." + pushState; }

  /** Classe de badge d'un état de poussée : à jour = DISCRET (c'est le régime normal, il ne doit pas
      attirer l'œil), en attente = attention, en échec = erreur. `none` estompé. */
  static pushStateClass(pushState: TrackerPushState): BadgeClass {
    switch (pushState) {
      case "synced":  return "dim";
      case "pending": return "warn";
      case "error":   return "err";
      default:        return "dim";
    }
  }

  /** URL du ticket à ouvrir. Le lien PERSISTÉ par le pont (`tracker_url`) PRIME sur tout montage
      local : il a été composé par l'adaptateur à partir de l'instance réellement interrogée, alors
      que le repli (référence + base d'URL configurée à part) suppose que les deux désignent la même
      instance — ce que rien ne garantit. `fallback` = ce montage hérité, déjà calculé par l'appelant
      (null s'il n'y en a pas). Renvoie null quand il n'y a rien à ouvrir. */
  static ticketUrl(trackerUrl: string | null | undefined, fallback: string | null | undefined): string | null {
    const persisted = TrackerReplication.text(trackerUrl);
    if (persisted !== "") return persisted;
    const local = TrackerReplication.text(fallback);
    return local !== "" ? local : null;
  }

  /** Chaîne ROGNÉE d'une valeur tolérante ("" si absente/non chaîne). */
  private static text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }
}
