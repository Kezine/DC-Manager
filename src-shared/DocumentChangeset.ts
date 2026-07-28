/* ============================================================================
   CHANGESET DE DOCUMENT — code PARTAGÉ front ⇄ back (TS pur, source de vérité UNIQUE).

   Décrit CE QUI a changé lors d'une (ou plusieurs) écriture(s). Le serveur le CONSTRUIT
   et le joint à l'événement SSE ; le client le CONSOMME pour planifier un rechargement
   granulaire (cf. src/sync/ReloadPlanner.ts).

   Portée `shared/` : TS PUR (ni DOM ni Node), compilé des DEUX côtés — front (résolution
   *bundler*) et serveur (NodeNext). Ce fichier n'importe rien : c'est un CONSTAT, plus une
   contrainte. L'auto-suffisance de `src-shared/` est LEVÉE (cf. `CLAUDE.md` § « Code partagé
   front/back ») — un import relatif vers un autre fichier partagé est AUTORISÉ, à une
   condition IMPÉRATIVE : écrire le spécificateur avec l'extension `.js`
   (`import { X } from "./Foo.js"` pour un fichier `Foo.ts`). NodeNext l'EXIGE côté serveur ;
   l'omettre compile côté front puis CASSE le build serveur.
   ⚠ Donc : ne JAMAIS dupliquer ici une règle qui vit déjà dans un autre fichier partagé au
   motif de « rester auto-suffisant » — c'est exactement la dette que les lots de
   déduplication (`TrayGeometry`, `RackDepthPolicy`) ont eu à résorber.
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
  /** MARQUEUR d'écriture dans un MODULE amovible (ex. `["interventions"]`, `["certs"]`). Ces bases sont
      SÉPARÉES du document cœur (hors révision) : leur événement live sert UNIQUEMENT à rafraîchir les
      PASTILLES d'onglet côté client — le `ReloadPlanner` du cœur l'IGNORE (aucune collection à recharger).
      Optionnel : une écriture du cœur ne le pose jamais. */
  modules?: string[];
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

  /** Changeset MODULE (interventions/certs…) : AUCUN changement de collection/méta/image du cœur — juste le
      marqueur `modules` pour rafraîchir les pastilles d'onglet. Le `ReloadPlanner` le traite comme « rien »
      (refetch [], threeRebuild none). */
  static modules(names: string[]): DocumentChangeset {
    return { full: false, collections: [], meta: false, images: false, modules: names.slice() };
  }

  /** Normalise une valeur reçue (réseau, donc non fiable) en `DocumentChangeset` ; `null`/forme invalide → « tout ».
      `isCollection` filtre les collections INCONNUES : une collection factice propagée déclencherait un refetch
      inutile côté client. Absent → aucun filtre.
      ⚠ Il est INJECTÉ par CHOIX, plus par contrainte : `Schema` serait importable (`"./Schema.js"`, cf. en-tête).
      Ce qu'on garde en l'injectant, c'est de laisser l'APPELANT décider du référentiel de collections — le
      serveur a le sien, un test peut en fournir un factice — sans que le changeset ait à connaître le schéma. */
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
