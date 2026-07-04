/* ============================================================================
   CHANGESET DE DOCUMENT — code PARTAGÉ front ⇄ back (TS pur, source de vérité UNIQUE).

   Décrit CE QUI a changé lors d'une (ou plusieurs) écriture(s). Le serveur le CONSTRUIT
   et le joint à l'événement SSE ; le client le CONSOMME pour planifier un rechargement
   granulaire (cf. src/sync/ReloadPlanner.ts).

   Contrainte `shared/` : fichier AUTO-SUFFISANT (aucun import relatif).
   ============================================================================ */

/** Périmètre d'une (ou plusieurs) écriture(s) sur le document. */
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

/** Fabrique / fusion de changesets (méthodes statiques regroupées — cf. CLAUDE.md). */
export class Changeset {
  /** Changeset « rien » (élément neutre de la fusion). */
  static empty(): DocumentChangeset {
    return { full: false, collections: [], meta: false, images: false };
  }

  /** Changeset « tout » : repli sûr quand le périmètre est inconnu (→ rechargement total). */
  static full(): DocumentChangeset {
    return { full: true, collections: [], meta: true, images: true };
  }

  /** Normalise une valeur reçue (réseau, donc non fiable) en `DocumentChangeset` ; `null`/forme invalide → « tout ».
      `isCollection` (INJECTÉ pour garder `shared/` auto-suffisant — pas d'import de Schema) filtre les collections
      INCONNUES : une collection factice propagée déclencherait un refetch inutile côté client. Absent → aucun filtre. */
  static coerce(raw: unknown, isCollection?: (c: string) => boolean): DocumentChangeset {
    if (!raw || typeof raw !== "object") return Changeset.full();
    const candidate = raw as Partial<DocumentChangeset>;
    if (candidate.full) return Changeset.full();
    return {
      full: false,
      collections: Array.isArray(candidate.collections) ? candidate.collections.filter((c): c is string => typeof c === "string" && (!isCollection || isCollection(c))) : [],
      meta: !!candidate.meta,
      images: !!candidate.images,
    };
  }

  /** Fusionne deux changesets (accumulation d'événements rapprochés débouncés) : union des périmètres. */
  static merge(left: DocumentChangeset, right: DocumentChangeset): DocumentChangeset {
    if (left.full || right.full) return { ...Changeset.full(), collections: Changeset.unionCollections(left, right) };
    return {
      full: false,
      collections: Changeset.unionCollections(left, right),
      meta: left.meta || right.meta,
      images: left.images || right.images,
    };
  }

  /** Union dédupliquée des collections de deux changesets (ordre stable : gauche puis nouveautés de droite). */
  private static unionCollections(left: DocumentChangeset, right: DocumentChangeset): string[] {
    const seen = new Set(left.collections);
    const merged = left.collections.slice();
    for (const collection of right.collections) if (!seen.has(collection)) { seen.add(collection); merged.push(collection); }
    return merged;
  }
}
