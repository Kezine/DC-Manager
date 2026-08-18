/* ============================================================================
   ENTITYLINK — deep-link d'ENTITÉ : le format d'URL qui désigne UNE fiche.
   Code PARTAGÉ front ⇄ back (TS pur) — source de vérité UNIQUE du format.

   POURQUOI CE MODULE (chantier étiquettes QR, arbitrage du GO 2026-08-18).
   Une étiquette QR imprimée encode l'URL ABSOLUE de la fiche de l'objet :

       <URL publique de l'instance>#doc/<docId>/fiche/<collection>/<id>

   Deux consommateurs, de part et d'autre du réseau — d'où `src-shared/` :
     · le SERVEUR (génération du QR) CONSTRUIT le lien (`build`) à partir de
       l'URL publique configurée (jamais dérivée des en-têtes de requête) ;
     · le CLIENT le LIT (`parse`) — au boot / sur `hashchange` (le navigateur a
       ouvert l'URL scannée hors app), et depuis le greffon de scan (la caméra
       a décodé le texte brut du QR).

   ⚠ INVARIANT DE SURVIE : le client extrait la cible SANS tenir compte de
   l'HÔTE imprimé. Une étiquette générée sur `https://ancienne-url/` reste
   lisible DANS l'app après un déménagement de l'instance — seule l'ouverture
   hors app (appareil photo → navigateur) meurt avec l'ancienne URL, et se
   règle en réimprimant. C'est l'arbitrage « URL absolue + id stable ».

   Le fragment vit APRÈS le `#` : côté serveur web il n'est jamais transmis
   (aucune route à prévoir), côté client il cohabite avec les hashes de VUE
   historiques (`#equipements`) — `doc/…` contient des `/`, aucun nom de vue
   n'en contient, donc `ShellNav.resolveHash` l'ignore proprement et c'est
   `EntityLink.parse` qui est tenté EN PREMIER par le routage du boot.

   SÉCURITÉ. `parse` est nourri de texte NON SÛR (un QR scanné est une entrée
   externe) : la collection est validée contre la liste CANONIQUE du schéma
   (liste blanche — jamais un nom libre), l'id n'est traité que comme CLÉ de
   recherche (introuvable → rien), et AUCUNE navigation automatique n'est
   décidée ici — le module rend une cible, l'appelant décide quoi en faire.

   FORME CANONIQUE STRICTE : exactement `doc/<docId>/fiche/<collection>/<id>`,
   chaque segment variable encodé par `encodeURIComponent`. Un lien forgé qui
   s'en écarte (segments en trop/en moins, %-encodage invalide, collection
   inconnue) rend `null` — pas de rattrapage laxiste : la seule source de
   liens est `build`, la tolérance n'apporterait que de l'ambiguïté.
   ============================================================================ */

import { Schema } from "./Schema.js";

/** Cible désignée par un deep-link d'entité. `docId` est le document SERVEUR (mode API) ;
    le mode fichier, mono-document par nature, l'ignore à la résolution. */
export interface EntityLinkTarget {
  docId: string;
  collection: string;
  id: string;
}

export class EntityLink {
  /** Fragment canonique (SANS le `#`) désignant `target`. Segments encodés un à un :
      un id contenant `/`, `#` ou un espace survit au round-trip build → parse. */
  static fragment(target: EntityLinkTarget): string {
    return "doc/" + encodeURIComponent(target.docId)
      + "/fiche/" + encodeURIComponent(target.collection)
      + "/" + encodeURIComponent(target.id);
  }

  /** URL ABSOLUE du deep-link : `publicBaseUrl` + `#` + fragment canonique.
      `publicBaseUrl` est l'URL PUBLIQUE configurée de l'instance (page de l'app, chemin de
      proxy compris) — le serveur ne la devine jamais depuis la requête. Un `#…` résiduel en
      bout de base est retiré (une base collée depuis la barre d'adresse en traîne souvent un) :
      le fragment est ENTIÈREMENT remplacé, jamais concaténé à un autre. */
  static build(publicBaseUrl: string, target: EntityLinkTarget): string {
    const base = String(publicBaseUrl || "").trim().replace(/#.*$/, "");
    return base + "#" + EntityLink.fragment(target);
  }

  /** Lit une cible d'entité dans `text` — URL complète (quel qu'en soit l'HÔTE, cf. invariant
      de survie), `location.hash` (`#doc/…`) ou fragment nu (`doc/…`). `null` si le texte ne
      porte pas un deep-link canonique (hash de vue, QR étranger, lien forgé mal formé…). */
  static parse(text: unknown): EntityLinkTarget | null {
    const raw = String(text ?? "").trim();
    if (!raw) return null;
    // Le fragment est ce qui suit le PREMIER `#` ; sans `#`, le texte entier est tenté comme
    // fragment nu (cas d'un appelant qui a déjà déshabillé le hash).
    const hashAt = raw.indexOf("#");
    const fragment = hashAt >= 0 ? raw.slice(hashAt + 1) : raw;
    const parts = fragment.split("/");
    if (parts.length !== 5 || parts[0] !== "doc" || parts[2] !== "fiche") return null;
    let docId: string, collection: string, id: string;
    try {
      docId = decodeURIComponent(parts[1]);
      collection = decodeURIComponent(parts[3]);
      id = decodeURIComponent(parts[4]);
    } catch {
      return null;   // %-encodage invalide (URIError) : lien forgé, pas des nôtres
    }
    if (!docId || !id || !Schema.isCollection(collection)) return null;
    return { docId, collection, id };
  }
}
