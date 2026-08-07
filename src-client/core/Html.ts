const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

// Adresse mail PLAUSIBLE : un « @ » entouré de texte, SANS aucune espace (les classes excluent « @ »,
// donc exactement un « @ »). Garde volontairement SOBRE — la spec `contacts.email` ne contrôle le format
// qu'« en douceur » : un champ mal saisi (« pas-un-email », « a b@c.d ») doit rester LISIBLE en texte
// plutôt que de devenir un lien mort. `\s` rejette aussi les retours à la ligne, première barrière contre
// l'injection d'en-têtes mail.
const EMAIL_PLAUSIBLE = /^[^\s@]+@[^\s@]+$/;

// Schémas AUTORISÉS dans un lien SORTANT (cf. `Html.externalLink`). Liste BLANCHE, jamais une liste
// noire : une liste noire oublie toujours un schéma (`data:`, `vbscript:`, `blob:`…), alors qu'une
// liste blanche ne laisse passer que ce qu'on a explicitement voulu. `URL.protocol` rend le schéma
// déjà NORMALISÉ EN MINUSCULES, donc « JavaScript:… » ne peut pas se glisser par la casse.
const SAFE_LINK_SCHEMES = ["http:", "https:"];

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

  /** L'URL est-elle un lien SORTANT sûr, c'est-à-dire `http` ou `https` (liste blanche ci-dessus) ?
      🚨 POURQUOI CETTE GARDE EXISTE. Une URL affichée par l'app peut venir d'un TIERS (le lien
      canonique d'un ticket, composé par un adaptateur de tracker) ou d'un document IMPORTÉ, qui
      porte ce que son auteur y a mis. Rendre `javascript:alert(1)` cliquable exécuterait ce code
      dans la page au premier clic : c'est un XSS, et l'échappement HTML ne l'empêche PAS (la chaîne
      est parfaitement valide en valeur d'attribut). Le contrôle porte donc sur le SCHÉMA, pas sur
      les caractères. Une URL RELATIVE est refusée elle aussi — `new URL` jette sans base — ce qui
      est le bon comportement pour un lien censé pointer un service externe. */
  static isSafeHttpUrl(url: unknown): boolean {
    if (typeof url !== "string") return false;
    const raw = url.trim();
    if (raw === "") return false;
    try {
      return SAFE_LINK_SCHEMES.includes(new URL(raw).protocol);
    } catch (_) {
      return false;   // ni absolue, ni analysable → pas un lien
    }
  }

  /** Rend une URL EXTERNE en lien cliquable, ou en simple texte échappé si le schéma n'est pas sûr
      (même repli que `mailtoLink` sur une adresse implausible : on AFFICHE la valeur telle quelle
      plutôt que d'en faire un lien dangereux ou mort). Primitive UNIQUE de la règle (principe n°3) :
      la recopier à chaque point d'affichage garantirait qu'un point l'oublie.
      `text` = libellé visible ; absent, c'est l'URL elle-même. Le couple `target="_blank"` +
      `rel="noopener noreferrer"` est INDISSOCIABLE : sans `noopener`, la page ouverte reçoit un
      `window.opener` vers la nôtre et peut la rediriger (tabnabbing) ; `noreferrer` évite en plus de
      divulguer l'URL du document courant au service tiers. */
  static externalLink(url: unknown, text?: unknown): string {
    const raw = typeof url === "string" ? url.trim() : "";
    const label = this.escape(text === undefined || text === null || text === "" ? raw : text);
    if (!Html.isSafeHttpUrl(raw)) return label;
    return `<a href="${this.escape(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
}
