const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

// Adresse mail PLAUSIBLE : un « @ » entouré de texte, SANS aucune espace (les classes excluent « @ »,
// donc exactement un « @ »). Garde volontairement SOBRE — la spec `contacts.email` ne contrôle le format
// qu'« en douceur » : un champ mal saisi (« pas-un-email », « a b@c.d ») doit rester LISIBLE en texte
// plutôt que de devenir un lien mort. `\s` rejette aussi les retours à la ligne, première barrière contre
// l'injection d'en-têtes mail.
const EMAIL_PLAUSIBLE = /^[^\s@]+@[^\s@]+$/;

/** Échappement HTML (texte → contenu sûr) + petits fabricants de fragments HTML sûrs. */
export class Html {
  static escape(s: unknown): string {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  /** Rend une adresse mail en lien `mailto:` cliquable, ou en simple texte échappé si l'adresse n'est pas
      plausible (comportement actuel préservé pour un champ mal saisi). Utilisé partout où une adresse de
      contact s'affiche (fiche + listing) — primitive UNIQUE pour ne pas dupliquer la règle (principe n°3). */
  static mailtoLink(email: unknown): string {
    const value = email === null || email === undefined ? "" : String(email);
    const text = this.escape(value);   // texte VISIBLE = l'adresse telle quelle, seulement échappée
    if (!EMAIL_PLAUSIBLE.test(value)) return text;
    // DOUBLE protection de l'URL : d'abord `encodeURIComponent` neutralise les caractères dangereux dans le
    // `mailto:` — notamment `?` et `&`, qui ouvriraient des champs d'en-tête (`?subject=`/`&bcc=`) — PUIS
    // `escape` sécurise l'insertion en VALEUR D'ATTRIBUT. Pas de `target="_blank"` : un `mailto:` n'ouvre
    // pas d'onglet (ce serait un onglet blanc parasite sur certains navigateurs).
    // ⚠ Le « @ » est RESTITUÉ après encodage : dans la grammaire `mailto:` (RFC 6068) il SÉPARE partie
    // locale et domaine, il n'est pas une donnée à encoder — un `%40` n'est pas redécodé par tous les
    // clients mail, qui reçoivent alors un destinataire invalide (« jean%40exemple.fr »). C'est sûr ici :
    // la garde ci-dessus a prouvé qu'il y a EXACTEMENT un « @ » et aucune espace, et les caractères
    // réellement dangereux (`?`, `&`, retours à la ligne) restent encodés.
    const href = this.escape("mailto:" + encodeURIComponent(value).replace(/%40/g, "@"));
    return `<a href="${href}">${text}</a>`;
  }
}
