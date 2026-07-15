import type { NotificationMessage, Notifier } from "./Notifier.js";
import { WebhookFormat } from "./WebhookFormat.js";

/* =============================================================================
   NOTIFIER WEBHOOK GÉNÉRIQUE — décision Q5 (2026-07-14) : les services
   d'envoi de l'utilisateur (sms, email) EXISTENT déjà et s'appellent en
   HTTP POST JSON. Le POST prend DEUX formes, selon les réglages de l'instance
   (cf. NotifyDb : simple_mode / simple_max_chars / html) :

   - NORMAL (défaut) : { to, subject, body, severity, event_type, format } —
     clés ANGLAISES (contrat aligné sur les passerelles de l'utilisateur,
     décision 2026-07-15) ; `format` ("text" | "html") dit à la passerelle
     comment lire `body` : texte brut (linefeed = seul formatage) par défaut,
     HTML mis en forme (paragraphes/<br>, entités échappées) si le réglage
     `html` de l'instance est actif.
   - SIMPLIFIÉ : strict minimum { to, text } (DEUX clés, rien d'autre), pour les
     passerelles SMS basiques ; `text` est le message compacté/tronqué.

   Jeton d'auth optionnel en en-tête `Authorization: Bearer …`. Il arrive ICI en
   CLAIR (déchiffré par NotifyDb/SecretBox au moment de construire l'instance,
   jamais avant) et ne vit qu'en mémoire. INVARIANT : il n'apparaît JAMAIS dans
   une erreur ou un log — les erreurs jetées ne citent que le statut HTTP et
   l'hôte (pas l'URL complète : un chemin de webhook peut porter un secret de
   type capability).

   `fetch` INJECTÉ (global en prod — Node ≥ 20) : les tests substituent un
   stub sans réseau. Timeout par AbortSignal (pas de requête fantôme qui
   retient une remise — le moteur retentera au rappel).
   ============================================================================= */

/** Réglages d'envoi PROPRES à une instance webhook (miroir camelCase des colonnes de notify.db —
    cf. WebhookNotifier.optionsFrom). Défauts = comportement historique (payload complet, texte brut). */
export interface WebhookSendOptions {
  /** Payload SIMPLIFIÉ { to, text } (deux clés) au lieu du payload complet. */
  simple: boolean;
  /** Mode simplifié : plafond de longueur du `text` compact (bornes validées côté NotifyValidate). */
  simpleMaxChars: number;
  /** Mode NORMAL : `corps` mis en forme HTML si true, texte brut sinon. Le mode simplifié l'IGNORE. */
  html: boolean;
}

export class WebhookNotifier implements Notifier {
  readonly kind = "webhook";

  /** Délai maximal d'UN POST (secondes) — au-delà, échec (retenté au rappel). */
  static readonly DEFAULT_TIMEOUT_SEC = 10;

  /** Options par défaut = comportement HISTORIQUE : payload complet, texte brut (rétro-compat). */
  static readonly DEFAULT_OPTIONS: WebhookSendOptions = { simple: false, simpleMaxChars: 300, html: false };

  /** @param url  Endpoint du service (validé par NotifyValidate).
      @param token  Jeton d'auth en clair (déchiffré à l'instant de l'envoi) — null = webhook sans auth.
      @param fetchImpl  fetch injecté (stub en test).
      @param options  Réglages d'envoi de l'instance (simplifié / HTML / plafond) — défauts historiques.
      @param timeoutSec  Borne d'attente du POST. */
  constructor(
    private readonly url: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: WebhookSendOptions = WebhookNotifier.DEFAULT_OPTIONS,
    private readonly timeoutSec: number = WebhookNotifier.DEFAULT_TIMEOUT_SEC,
  ) {}

  /** Traduit les réglages d'INSTANCE (colonnes snake_case de notify.db) en options d'envoi.
      Mutualisé (principe n°3) entre les DEUX points de construction : SubscriptionRouter (production)
      et NotifyModule.notifierFor (test direct d'un canal). */
  static optionsFrom(instance: { simple: boolean; simple_max_chars: number; html: boolean }): WebhookSendOptions {
    return { simple: instance.simple, simpleMaxChars: instance.simple_max_chars, html: instance.html };
  }

  async send(message: NotificationMessage): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token !== null) headers["Authorization"] = "Bearer " + this.token;
    // Deux formes de payload (cf. en-tête du fichier). Le mode simplifié n'émet QUE { to, text } ;
    // le mode normal porte le contrat complet en clés ANGLAISES + `format` pour lever
    // l'ambiguïté texte/HTML côté passerelle.
    const payload = this.options.simple
      ? { to: message.target.address, text: WebhookFormat.simpleText(message, this.options.simpleMaxChars) }
      : {
          to: message.target.address,
          subject: message.title,
          body: this.options.html ? WebhookFormat.htmlBody(message) : WebhookFormat.textBody(message),
          severity: message.severity,
          event_type: message.event_type,
          format: this.options.html ? "html" : "text",
        };
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutSec * 1000),
      });
    } catch (e) {
      // Échec RÉSEAU (refus, DNS, timeout) : message reformulé SANS l'URL complète ni le jeton.
      const cause = e instanceof Error ? e.name + (e.message ? " — " + WebhookNotifier.scrub(e.message) : "") : String(e);
      throw new Error("webhook injoignable (" + this.host() + ") : " + cause);
    }
    if (!response.ok) {
      // Le CORPS de la réponse n'est pas repris (un service mal luné pourrait y refléter
      // l'Authorization reçue) — le statut suffit au diagnostic.
      throw new Error("webhook en échec (" + this.host() + ") : HTTP " + response.status);
    }
  }

  /** Hôte seul pour les messages d'erreur (jamais l'URL complète — chemin potentiellement secret). */
  private host(): string {
    try { return new URL(this.url).host; } catch { return "url invalide"; }
  }

  /** Ceinture : si un message d'erreur bas niveau citait l'URL, il est tronqué à l'hôte. */
  private static scrub(text: string): string {
    return text.replace(/https?:\/\/[^\s"']+/g, (raw) => { try { return new URL(raw).host; } catch { return "<url>"; } });
  }
}
