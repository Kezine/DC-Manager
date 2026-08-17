/* =============================================================================
   COOKIES — LECTURE d'un en-tête `Cookie` et COMPOSITION d'un `Set-Cookie`
   (helper du dossier `auth/`, classe pure, aucun import).

   Sœur de `ContentDisposition` (racine de `src-server/src/`) : même nature —
   composer et lire un en-tête HTTP est une règle de FORMAT, testable pour
   elle-même, et qui n'a aucune raison de vivre dans le fichier qui s'en sert.
   Deux consommateurs ici : `OidcAuthProvider` (lit le cookie de session) et
   `OidcRoutes` (lit et pose les cookies de session et de transaction).

   ── Pourquoi ne PAS prendre une dépendance (`cookie`, `cookie-parser`) ────
   Principe n°12 : proposer une librairie plutôt que réinventer — mais le même
   principe réserve l'implémentation maison au besoin TRIVIAL. Il s'agit ici de
   découper sur `;` et de concaténer des attributs, soit la trentaine de lignes
   ci-dessous, sans état ni cas limite exotique ; et le lot a déjà dépensé sa
   dépendance là où elle est INDISPENSABLE — la cryptographie d'OIDC
   (`openid-client`), qu'il aurait été fautif d'écrire à la main.

   ⚠ `LegacySsoAuthProvider` n'est volontairement PAS recâblé ici, et ce n'est
   pas une déduplication oubliée : ce provider ne « lit pas un cookie » — il
   PROXIFIE l'en-tête `Cookie` ENTIER quand aucun nom n'est configuré, et la
   valeur qu'il extrait sert de CLÉ DE CACHE, pas de valeur de cookie. Les deux
   codes se ressemblent ; les deux responsabilités, non.
   ============================================================================= */

/** Attributs d'un cookie POSÉ. Volontairement restreint à ce que le mode OIDC emploie : tout
    attribut ajouté « au cas où » serait un attribut que personne ne teste. */
export interface CookieAttributes {
  /** Toujours vrai dans ce dossier : un porteur de session ne doit pas être lisible en JavaScript
      (c'est ce qui neutralise le vol de session par XSS). Explicite pour rester relisible. */
  httpOnly?: boolean;
  /** `Secure` — transmis en HTTPS seulement. Piloté par `OIDC_COOKIE_SECURE` (défaut vrai). */
  secure?: boolean;
  /** `Lax` convient au flux OIDC : le retour de l'OP est une navigation GET de haut niveau, donc
      le cookie de transaction est BIEN renvoyé — là où `Strict` le retiendrait et casserait le
      callback, et où `None` ouvrirait le cookie à tout contexte tiers. */
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  /** Durée de vie en SECONDES. `0` efface le cookie (cf. `expire`). */
  maxAgeSeconds?: number;
}

export class CookieHeader {
  /** Valeur du cookie `name` dans un en-tête `Cookie`, ou `null`.

      La valeur est DÉCODÉE (`decodeURIComponent`) : les identifiants que nous posons sont en
      base64url, donc insensibles à l'encodage, mais un intermédiaire peut percent-encoder, et une
      valeur mal encodée ne doit pas faire JETER l'authentification — d'où le repli sur la valeur
      brute. Un cookie illisible rend un appelant anonyme, jamais une erreur 500. */
  static read(header: string | string[] | undefined | null, name: string): string | null {
    const raw = Array.isArray(header) ? header.join("; ") : String(header ?? "");
    if (raw === "") return null;
    for (const part of raw.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      if (part.slice(0, separator).trim() !== name) continue;
      const value = part.slice(separator + 1).trim();
      try { return decodeURIComponent(value); } catch { return value; }
    }
    return null;
  }

  /** En-tête `Set-Cookie` COMPLET pour un cookie posé. La valeur est encodée — nos valeurs n'en ont
      pas besoin, mais poser un cookie dont la valeur casserait la syntaxe de l'en-tête serait un
      défaut latent qui n'apparaîtrait qu'au premier caractère inhabituel. */
  static serialize(name: string, value: string, attributes: CookieAttributes = {}): string {
    const parts = [name + "=" + encodeURIComponent(value)];
    parts.push("Path=" + (attributes.path || "/"));
    if (attributes.httpOnly !== false) parts.push("HttpOnly");
    if (attributes.secure) parts.push("Secure");
    parts.push("SameSite=" + (attributes.sameSite || "Lax"));
    if (typeof attributes.maxAgeSeconds === "number") {
      const maxAge = Math.max(0, Math.floor(attributes.maxAgeSeconds));
      parts.push("Max-Age=" + maxAge);
      // `Expires` EN PLUS de `Max-Age` : les navigateurs modernes préfèrent `Max-Age`, mais une
      // date passée reste la seule instruction que comprennent les intermédiaires les plus anciens.
      // Ceinture et bretelles sur l'EFFACEMENT — un cookie de session qui survivrait à une
      // déconnexion serait le pire des défauts de ce lot.
      if (maxAge === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
    return parts.join("; ");
  }

  /** En-tête qui EFFACE un cookie : même nom, valeur vide, durée nulle. Les attributs `Path`,
      `Secure` et `SameSite` doivent correspondre à ceux de la pose, sinon le navigateur considère
      qu'il s'agit d'un AUTRE cookie et garde l'ancien — piège classique, d'où cette méthode plutôt
      qu'un `serialize(name, "", { maxAgeSeconds: 0 })` recopié à chaque appel. */
  static expire(name: string, attributes: CookieAttributes = {}): string {
    return CookieHeader.serialize(name, "", { ...attributes, maxAgeSeconds: 0 });
  }
}
