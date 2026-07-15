import type { NotificationMessage, NotifySeverity } from "./Notifier.js";

/* =============================================================================
   FORMATAGE DU CORPS DES WEBHOOKS — module PUR (aucun réseau, aucun état, aucune
   horloge), extrait de WebhookNotifier pour être testé SEUL. Trois formes de
   rendu, choisies par les réglages d'instance (cf. NotifyDb/WebhookNotifier) :

   - `simpleText` : message COMPACT sur UNE ligne, pour les passerelles minimales
     (payload { to, text }). Une passerelle SMS attend une ligne courte — d'où le
     repli des retours à la ligne et la troncature bornée.
   - `htmlBody`   : corps mis en forme HTML (paragraphes / <br>), destiné aux
     passerelles e-mail HTML.
   - `textBody`   : corps BRUT, comportement HISTORIQUE — le linefeed est le seul
     formatage, la passerelle l'affiche tel quel (rétro-compatibilité).

   INVARIANT DE SÛRETÉ : le contenu (title/body) vient des PRODUCTEURS de problèmes
   (VM, certificats…) — on ne lui fait JAMAIS confiance. `htmlBody` échappe donc
   systématiquement `& < > " '` AVANT toute mise en forme : aucune injection HTML
   possible depuis un message d'alerte, même si un producteur y glisse du balisage.
   ============================================================================= */
export class WebhookFormat {
  /** Ellipse ajoutée à la fin d'un texte tronqué — UN caractère (U+2026), donc compté 1 dans la limite. */
  private static readonly ELLIPSIS = "…";

  /** Préfixe de gravité du texte compact. Rien pour « info » : le cas nominal ne s'alourdit pas. */
  private static severityPrefix(severity: NotifySeverity): string {
    if (severity === "error") return "[erreur] ";
    if (severity === "warning") return "[avertissement] ";
    return "";
  }

  /** Texte COMPACT sur une seule ligne, borné à `maxChars` (ellipse « … » finale COMPRISE dans la
      limite — jamais plus de `maxChars` caractères). Forme : « [gravité] Titre — Corps », le
      « — Corps » étant omis si le corps est vide. Les retours à la ligne (titre et corps) sont
      repliés en espaces : une passerelle SMS ne veut qu'une ligne. */
  static simpleText(message: NotificationMessage, maxChars: number): string {
    const title = WebhookFormat.foldLines(message.title);
    const body = WebhookFormat.foldLines(message.body);
    const composed = (WebhookFormat.severityPrefix(message.severity) + title + (body ? " — " + body : "")).trim();
    return WebhookFormat.truncate(composed, maxChars);
  }

  /** Fragment HTML propre du corps : entités ÉCHAPPÉES (contenu non fiable), corps découpé en
      paragraphes `<p>…</p>` sur les lignes vides et en `<br>` sur les retours à la ligne simples.
      Corps vide → fragment vide (rien à mettre en forme). */
  static htmlBody(message: NotificationMessage): string {
    const normalized = message.body.replace(/\r\n?/g, "\n"); // CRLF/CR → LF (source de saisie hétérogène)
    return normalized
      .split(/\n[ \t]*\n+/)                                   // ligne vide (éventuels espaces/tabs) = fin de paragraphe
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== "")
      // ÉCHAPPER d'abord (le contenu est du texte, pas du HTML), PUIS transformer les linefeeds
      // internes en <br> : l'ordre garantit que le <br> injecté n'est pas lui-même échappé.
      .map((paragraph) => "<p>" + WebhookFormat.escapeHtml(paragraph).replace(/\n/g, "<br>") + "</p>")
      .join("");
  }

  /** Corps BRUT, tel quel (comportement historique — aucun formatage hormis les linefeeds du producteur). */
  static textBody(message: NotificationMessage): string {
    return message.body;
  }

  /* -------------------------------------------------------------------------- */

  /** Replie tout enchaînement de retours à la ligne en UN espace (mise à plat sur une ligne). */
  private static foldLines(text: string): string {
    return text.replace(/[\r\n]+/g, " ");
  }

  /** Tronque à `maxChars` en réservant l'ellipse finale DANS la limite. Bords :
      longueur == maxChars → texte intact ; longueur == maxChars+1 → tronqué à `maxChars`
      caractères (ellipse comprise). `maxChars` est borné par la validation (≥ 20), le
      garde-fou couvre néanmoins les très petites limites. */
  private static truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    if (maxChars <= 1) return WebhookFormat.ELLIPSIS.slice(0, Math.max(0, maxChars));
    return text.slice(0, maxChars - 1) + WebhookFormat.ELLIPSIS;
  }

  /** Échappe les entités HTML sensibles (& en PREMIER pour ne pas ré-échapper les entités produites). */
  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
