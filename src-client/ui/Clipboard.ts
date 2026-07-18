import { Notify } from "./Notify";
import { I18n } from "../i18n/I18n";

/* =============================================================================
   Clipboard — copie de texte dans le presse-papiers avec retour visuel (toast) et
   REPLI robuste. Extraite en primitive UI réutilisable (principe n°2) : l'aide au
   déploiement de la confiance (CertsAdminView) propose un bouton « Copier » par bloc
   de commande, mais le besoin est générique.

   Deux voies, dans l'ordre :
     1. `navigator.clipboard.writeText` — API moderne, mais RÉSERVÉE aux contextes
        SÉCURISÉS (HTTPS ou localhost) : servie en HTTP simple sur un hôte de LAN,
        `navigator.clipboard` est ABSENT (même piège que WebCrypto, cf. certs.md) ;
     2. repli historique `<textarea>` hors écran + `document.execCommand("copy")`,
        qui fonctionne encore hors contexte sécurisé.
   Tout échec (permission refusée, aucune des deux voies) donne un toast d'erreur
   invitant à copier manuellement — jamais de silence.
   ============================================================================= */
export class Clipboard {
  /** Copie `text` puis affiche un toast : `okMessage` (défaut « Copié ») au succès, un message
      d'erreur sinon. Renvoie le succès (rarement utile — le toast suffit à l'UI). */
  static async copy(text: string, okMessage = I18n.t("ui.clipboard.copied")): Promise<boolean> {
    const ok = await Clipboard.write(text);
    Notify.toast(ok ? okMessage : I18n.t("ui.clipboard.failed"), ok ? "ok" : "err");
    return ok;
  }

  /** Écriture BRUTE (sans toast) : tente l'API moderne, retombe sur le repli execCommand. */
  private static async write(text: string): Promise<boolean> {
    try {
      const nav = typeof navigator !== "undefined" ? navigator : null;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        await nav.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* permission refusée / contexte non sécurisé → repli ci-dessous */ }
    return Clipboard.execCommandFallback(text);
  }

  /** Repli : sélectionne le texte dans un `<textarea>` hors écran puis `execCommand("copy")`.
      Déprécié mais toujours pris en charge, et seule voie hors contexte sécurisé. */
  private static execCommandFallback(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      // Hors écran mais SÉLECTIONNABLE (display:none empêcherait la sélection donc la copie).
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }
}
