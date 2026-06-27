/* ============================================================================
   CHANGESET DE DOCUMENT — description de CE QUI a changé lors d'une écriture.

   Émis par le serveur à chaque écriture (joint à l'événement SSE et au flux de
   notification ; cf. src-server/src/api.ts) et consommé par le client pour
   planifier un rechargement granulaire (cf. ReloadPlanner). La forme est
   volontairement minimale (grain COLLECTION) : le grain entité (ids) viendra avec
   la reconstruction 3D incrémentale (P4).

   NB : ce type est aujourd'hui DUPLIQUÉ côté serveur (src-server) faute de dossier
   de code partagé entre front et back. Toute évolution doit rester synchronisée
   des deux côtés — voir la discussion « code partagé » dans docs/ et CLAUDE.md.
   ============================================================================ */

/** Description du périmètre d'une (ou plusieurs) écriture(s) sur le document. */
export interface DocumentChangeset {
  /** `true` = périmètre indéterminé (import `/snapshot`, route inconnue) → recharger TOUT (repli sûr). */
  full: boolean;
  /** Collections touchées (création / mise à jour / suppression confondues). */
  collections: string[];
  /** La méta-document (nom du document…) a changé. */
  meta: boolean;
  /** Au moins une image de façade a changé. */
  images: boolean;
}

/** Changeset « rien » (élément neutre de la fusion). */
export function emptyChangeset(): DocumentChangeset {
  return { full: false, collections: [], meta: false, images: false };
}

/** Changeset « tout » : repli sûr quand le périmètre est inconnu (→ rechargement total). */
export function fullChangeset(): DocumentChangeset {
  return { full: true, collections: [], meta: true, images: true };
}

/** Normalise une valeur reçue (réseau, donc non fiable) en `DocumentChangeset` ; `null`/forme invalide → « tout ». */
export function coerceChangeset(raw: unknown): DocumentChangeset {
  if (!raw || typeof raw !== "object") return fullChangeset();
  const candidate = raw as Partial<DocumentChangeset>;
  if (candidate.full) return fullChangeset();
  return {
    full: false,
    collections: Array.isArray(candidate.collections) ? candidate.collections.filter((c) => typeof c === "string") : [],
    meta: !!candidate.meta,
    images: !!candidate.images,
  };
}

/** Fusionne deux changesets (accumulation d'événements rapprochés débouncés) : union des périmètres. */
export function mergeChangesets(left: DocumentChangeset, right: DocumentChangeset): DocumentChangeset {
  if (left.full || right.full) return { ...fullChangeset(), collections: unionCollections(left, right) };
  return {
    full: false,
    collections: unionCollections(left, right),
    meta: left.meta || right.meta,
    images: left.images || right.images,
  };
}

/** Union dédupliquée des collections de deux changesets (ordre stable : gauche puis nouveautés de droite). */
function unionCollections(left: DocumentChangeset, right: DocumentChangeset): string[] {
  const seen = new Set(left.collections);
  const merged = left.collections.slice();
  for (const collection of right.collections) if (!seen.has(collection)) { seen.add(collection); merged.push(collection); }
  return merged;
}
