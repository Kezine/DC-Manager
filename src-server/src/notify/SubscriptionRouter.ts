import { Logger } from "../logger.js";
import type { NotifyRouter, ResolvedRecipient } from "./NotifyEngine.js";
import type { NotifyDb } from "./NotifyDb.js";
import type { Notifier } from "./Notifier.js";
import { ConsoleNotifier } from "./ConsoleNotifier.js";
import { WebhookNotifier } from "./WebhookNotifier.js";
import type { Records } from "../../../src-shared/DataValidation.js";   // forme d'enregistrement DÉRIVÉE de la spec (contacts)

/* =============================================================================
   ROUTAGE PAR ABONNEMENTS — matérialise le `NotifyRouter` injecté au moteur :
   (event_type, doc_id) → destinataires résolus. Décision utilisateur
   2026-07-14 : routage par TYPE d'événement (abonnements event_type × contact
   × canal × instance, portée document ou globale).

   Résolution d'UN abonnement :
   1) instance de canal ACTIVE (notify.db) + jeton déchiffré à l'instant
      (SecretBox) → notifier concret (console | webhook). Déchiffrement en
      échec (clé changée) → instance EXCLUE de la remise, avertissement SANS
      contenu — les autres abonnements vivent ;
   2) contact (collection `contacts` DU DOCUMENT — référence souple) : cherché
      dans le document de l'ÉVÉNEMENT, sinon celui de l'ABONNEMENT, sinon dans
      TOUS les documents (abonnement global sur événement global : le contact
      vit forcément quelque part — les ids sont des UUID, pas de collision
      réaliste). Introuvable → abonnement ignoré (warn), garde-fou UI en S7 ;
   3) adresse selon le canal (email → contact.email, sms → contact.phone) —
      vide → abonnement ignoré (warn : contact sans adresse pour ce canal).

   Un lookup par remise (pas de cache) : volumes faibles, et la config reste
   modifiable à chaud sans invalidation à gérer.
   ============================================================================= */

/** Lecture MINIMALE d'un contact dans un document — contrat réduit du DocumentStore
    (dépendance inversée : le module reste testable sans le vrai store multi-documents). */
export interface ContactSource {
  /** Ids des documents existants (parcours de repli des abonnements globaux). */
  documentIds(): string[];
  /** L'enregistrement contact d'un document (forme dérivée de la spec), ou null (document ou contact inconnu). */
  contact(docId: string, contactId: string): Records.Contact | null;
}

export class SubscriptionRouter {
  constructor(
    private readonly db: NotifyDb,
    private readonly contacts: ContactSource,
    private readonly log: Logger = new Logger("error"),
    /** Fabrique du notifier console (injectable : sortie contrôlée en test). */
    private readonly consoleNotifier: Notifier = new ConsoleNotifier(),
    /** fetch des webhooks (injectable : stub en test). */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** La fonction à injecter au NotifyEngine (liée à cette instance). */
  asRouter(): NotifyRouter {
    return (eventType, docId) => this.route(eventType, docId);
  }

  route(eventType: string, docId: string | null): ResolvedRecipient[] {
    const recipients: ResolvedRecipient[] = [];
    for (const subscription of this.db.subscriptionsFor(eventType, docId)) {
      // 1) Instance active + notifier concret (jeton déchiffré à l'instant, jamais loggué).
      let instance;
      try {
        instance = this.db.instanceForSend(subscription.notifier_id);
      } catch {
        // Message SecretBox sans contenu sensible ; on reste volontairement laconique.
        this.log.warn("notify: jeton d'instance indéchiffrable — abonnement ignoré", subscription.id, subscription.notifier_id);
        continue;
      }
      if (!instance) continue; // instance supprimée entre-temps ou désactivée : abonnement muet
      let notifier: Notifier;
      if (instance.kind === "console") notifier = this.consoleNotifier;
      else if (instance.kind === "webhook" && instance.url) notifier = new WebhookNotifier(instance.url, instance.token, this.fetchImpl, WebhookNotifier.optionsFrom(instance));
      else { this.log.warn("notify: kind d'instance inconnu — abonnement ignoré", subscription.id, instance.kind); continue; }

      // 2) Contact (référence souple vers la collection d'un document).
      const contact = this.findContact(subscription.contact_id, docId ?? undefined, subscription.doc_id ?? undefined);
      if (!contact) {
        this.log.warn("notify: contact introuvable — abonnement ignoré", subscription.id, subscription.contact_id);
        continue;
      }

      // 3) Adresse selon le canal demandé.
      const field = subscription.channel === "sms" ? "phone" : "email";
      const address = typeof contact[field] === "string" ? (contact[field] as string).trim() : "";
      if (address === "") {
        this.log.warn("notify: contact sans adresse pour le canal — abonnement ignoré", subscription.id, subscription.channel);
        continue;
      }

      recipients.push({
        notifier_id: instance.id,
        notifier,
        target: { contact_id: subscription.contact_id, address, channel: subscription.channel },
      });
    }
    return recipients;
  }

  /** Cherche le contact : documents PRÉFÉRÉS d'abord (événement, puis abonnement),
      puis tous les autres (repli des abonnements globaux). */
  private findContact(contactId: string, ...preferredDocIds: Array<string | undefined>): Records.Contact | null {
    const tried = new Set<string>();
    for (const docId of preferredDocIds) {
      if (!docId || tried.has(docId)) continue;
      tried.add(docId);
      const contact = this.contacts.contact(docId, contactId);
      if (contact) return contact;
    }
    for (const docId of this.contacts.documentIds()) {
      if (tried.has(docId)) continue;
      const contact = this.contacts.contact(docId, contactId);
      if (contact) return contact;
    }
    return null;
  }
}
