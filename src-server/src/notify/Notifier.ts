/* =============================================================================
   CONTRATS DU SERVICE DE NOTIFICATIONS — module serveur `notify/` AMOVIBLE
   (pattern vm/ : le cœur n'importe rien d'ici ; supprimer la feature =
   retirer le câblage d'index.ts et le dossier notify/).

   Cadrage 2026-07-14 (« notifications-contacts-cadrage ») : notifier de
   manière ASYNCHRONE des problèmes persistants, interface-driven pour
   BRANCHER des canaux (webhooks sms/email de l'utilisateur, console…).
   Ce fichier ne porte QUE les contrats : les implémentations vivent chacune
   dans leur fichier (ConsoleNotifier, WebhookNotifier), le moteur anti-spam
   dans NotifyEngine.
   ============================================================================= */

/** Gravité d'un événement notifié (portée telle quelle aux canaux). */
export type NotifySeverity = "info" | "warning" | "error";

/** Destinataire RÉSOLU par le routage (abonnements par type d'événement, cf.
    NotifyEngine/NotifyRouter) : le contact abonné, l'adresse tirée du contact
    selon le canal demandé (email → contact.email, sms → contact.phone…). */
export interface NotificationTarget {
  contact_id: string;
  /** Adresse effective d'envoi (email, numéro…) — résolue AVANT l'appel au notifier. */
  address: string;
  /** Canal demandé par l'abonnement ("email" | "sms" | …) — le notifier peut l'ignorer (console). */
  channel: string;
}

/** Message COMPLET remis à un notifier — tout ce qu'il faut pour délivrer,
    sans retour vers le moteur (le notifier ne connaît ni la DB ni l'anti-spam). */
export interface NotificationMessage {
  /** Type STABLE de l'événement ("cert-expiry" | "vm-sync-failure" | "test" | …). */
  event_type: string;
  severity: NotifySeverity;
  title: string;
  body: string;
  /** Document concerné (null = événement global, hors document). */
  doc_id: string | null;
  target: NotificationTarget;
}

/** UN canal d'envoi. Une implémentation par transport ; les instances
    configurées (URL + jeton d'un webhook…) sont fabriquées par le module à
    partir de la table notifier_instances (cf. NotifyModule, S3).
    `send` JETTE en cas d'échec : le moteur journalise (last_error, historique)
    et RETENTERA au prochain rappel — jamais de retry immédiat ici. Les erreurs
    jetées ne doivent JAMAIS contenir de secret (jeton d'auth du webhook…). */
export interface Notifier {
  /** Transport implémenté ("console" | "webhook" | …) — sert au diagnostic/journal. */
  readonly kind: string;
  send(message: NotificationMessage): Promise<void>;
}
