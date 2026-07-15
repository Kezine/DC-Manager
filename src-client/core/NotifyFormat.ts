/* =============================================================================
   NotifyFormat — logique PURE de la page d'administration « Notifications »
   (aucun DOM, aucun store, aucun réseau) : conversions d'intervalle de rappel
   (HEURES côté UI ⟷ SECONDES côté serveur), libellé lisible d'un intervalle, et
   résolution SOUPLE d'un libellé de contact (garde-fou « contact introuvable »).

   Pourquoi une classe pure dédiée (principes n°2/n°7) : ces règles sont testables
   en isolation (Tests/modules) et réutilisables par la vue sans la charger de
   calculs. La vue (NotificationsAdminView) ne fait qu'assembler le DOM ; toute
   arithmétique / résolution de référence passe ici.

   INTERVALLE DE RAPPEL : le serveur stocke des SECONDES (≥ 60, cf. NotifyValidate
   .parseRemindInterval) avec un défaut de 12 h (DEFAULT_REMIND_INTERVAL_SEC,
   NotifyEngine). L'UI raisonne en HEURES (décision de cadrage Q2) — d'où les deux
   conversions ci-dessous. Les constantes sont des MIROIRS commentés des valeurs
   serveur (duplication assumée, principe n°3 : ce sont des bornes de protocole,
   pas une règle métier partageable — à répercuter des deux côtés si elles bougent).
   ============================================================================= */

/** Défaut serveur du rappel : 12 h — MIROIR de `DEFAULT_REMIND_INTERVAL_SEC` (NotifyEngine). */
export const DEFAULT_REMIND_HOURS = 12;

/** Borne basse serveur : 60 s — MIROIR de la règle `remind_interval_sec ≥ 60` (NotifyValidate). */
export const MIN_REMIND_SEC = 60;

/** Suggestions d'`event_type` proposées en autocomplétion (datalist) des formulaires d'abonnement et
    de rappel. Données pures d'UI : « * » = tous les types ; « test » = remise d'essai routée. Les
    autres correspondent aux producteurs connus (VM, certificats) — enrichissable sans risque (saisie libre). */
export const EVENT_TYPE_SUGGESTIONS = ["*", "test", "vm-sync-failure", "cert-expiry"] as const;

export class NotifyFormat {
  /** HEURES (saisie UI) → SECONDES (protocole serveur). Arrondi à la seconde. Ne borne PAS : la
      validation (≥ 60 s) est un test séparé (`isValidRemindSec`) pour pouvoir afficher un grief clair. */
  static hoursToSec(hours: number): number {
    return Math.round((Number.isFinite(hours) ? hours : 0) * 3600);
  }

  /** SECONDES (serveur) → HEURES (affichage / champ de saisie). Valeur brute (non arrondie) :
      12 h ↔ 43200 s ronds ; les valeurs « sales » restent exactes pour un aller-retour fidèle. */
  static secToHours(sec: number): number {
    return (Number.isFinite(sec) ? sec : 0) / 3600;
  }

  /** Un intervalle (en secondes) respecte-t-il la borne serveur (entier ≥ 60) ? Sert au garde-fou
      d'UI AVANT l'envoi (le serveur revalide de toute façon — cf. NotifyValidate). */
  static isValidRemindSec(sec: number): boolean {
    return Number.isFinite(sec) && Math.floor(sec) >= MIN_REMIND_SEC;
  }

  /** Intervalle lisible en français depuis des SECONDES : « 12 h », « 1 h 30 », « 30 min », « 90 s ».
      ≤ 0 / non-fini → « — ». Grain d'affichage (l'unité de saisie reste l'heure). */
  static intervalLabel(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return "—";
    const hours = Math.floor(sec / 3600);
    const minutes = Math.round((sec % 3600) / 60);
    if (hours > 0 && minutes > 0) return hours + " h " + minutes;
    if (hours > 0) return hours + " h";
    if (minutes > 0) return minutes + " min";
    return Math.round(sec) + " s";
  }

  /** Libellé d'un contact référencé par un abonnement / une entrée d'historique. Référence SOUPLE
      (le `contact_id` vit dans notify.db, HORS du document — cf. Contact/NotifyValidate) : le contact
      peut appartenir à un AUTRE document, ou avoir été supprimé. Garde-fou EXIGÉ (cadrage §2) :
      - id vide → « (aucun) » (ex. cible d'un test direct sans contact) ;
      - trouvé, nom non vide → le nom ;
      - trouvé, nom vide → « (sans nom) » ;
      - introuvable dans la collection fournie → « (contact introuvable) » (jamais d'exception). */
  static contactLabel(contacts: Array<{ id: string; name?: string }>, contactId: string | null | undefined): string {
    const id = (typeof contactId === "string" ? contactId.trim() : "");
    if (id === "") return "(aucun)";
    const found = (Array.isArray(contacts) ? contacts : []).find((c) => c && c.id === id);
    if (!found) return "(contact introuvable)";
    const name = (typeof found.name === "string" ? found.name.trim() : "");
    return name !== "" ? name : "(sans nom)";
  }
}
