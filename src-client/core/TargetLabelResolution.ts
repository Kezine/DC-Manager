/* =============================================================================
   TargetLabelResolution — QUELS enregistrements aller chercher pour résoudre des
   libellés de cibles, et GROUPÉS comment (vague 4 du chantier « lazy-load des
   collections », cf. docs/hydratation.md § « Vague 4 »).

   LE PROBLÈME : `labelOf(kind, id)` est SYNCHRONE (un listing résout ses libellés
   au moment du rendu), mais une famille de cibles peut vivre dans une collection
   chargée PARESSEUSEMENT (`applications` depuis la vague 2, `spares` depuis la
   vague 4) : une cible non absorbée s'afficherait « introuvable », comme si elle
   avait été supprimée. Le préalable historique — hydrater la collection ENTIÈRE —
   contredisait la doctrine du chantier (2026-08-13 : « hydraté = ce que le 3D
   consomme ») : on chargerait tout un corpus pour trois libellés.

   LA FORME RETENUE : une résolution GROUPÉE des seuls ids RÉFÉRENCÉS par ce qu'on
   va afficher. Cette classe en porte la partie PURE — la collecte/partition :
   liens {kind, id} → « quels ids MANQUENT au cache, par collection ». L'hôte
   (main.ts) n'a plus qu'à faire un `fetchMany` par collection du résultat
   (absorption + indexation par le Store), et le rendu synchrone trouve tout.

   POURQUOI un module séparé (principe n°2/n°7) : la règle (dédoublonnage, famille
   inconnue ignorée, cache consulté) est testable headless — la carte kind →
   collection et le prédicat de présence au cache sont INJECTÉS, jamais importés.

   Propriétés garanties (testées) :
   - mode FICHIER : tout est en cache → résultat VIDE → l'hôte ne fait AUCUN
     appel adaptateur (le no-op du principe n°15 est structurel, pas testé par
     un `if (mode)`) ;
   - lien ORPHELIN (cible supprimée, jamais présente au cache) : son id RESTE
     demandé — `getMany` ne rend que ce qui existe, l'orphelin reste non résolu
     et s'affiche « introuvable » (comportement voulu). Le coût est UNE lecture
     groupée par affichage qui le référence, jamais une erreur ;
   - famille INCONNUE (slug non déclaré) : ignorée — `labelOf` la rend déjà
     « introuvable », rien à charger.
   ============================================================================= */

/** Un lien de cible : couple famille (slug) + identifiant. */
export interface TargetLinkRef {
  kind: string;
  id: string;
}

export class TargetLabelResolution {
  /** Partition des ids ABSENTS du cache, par collection : `links` (avec doublons et familles
      inconnues tolérés) → `{ collection: [ids manquants, dédoublonnés] }`.
      `collectionOf` mappe un slug de famille vers sa collection (null/undefined = famille inconnue,
      ignorée) ; `isCached` dit si l'enregistrement est déjà au cache (il n'y a alors RIEN à charger —
      c'est ce prédicat qui rend le mode fichier structurellement muet). */
  static missingByCollection(
    links: ReadonlyArray<TargetLinkRef>,
    collectionOf: (kind: string) => string | null | undefined,
    isCached: (collection: string, id: string) => boolean,
  ): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const seen = new Set<string>();
    for (const link of links || []) {
      if (!link || !link.id) continue;
      const collection = collectionOf(link.kind);
      if (!collection) continue;   // famille inconnue : labelOf la rend « introuvable », rien à charger
      const key = collection + " " + link.id;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isCached(collection, link.id)) continue;   // déjà en cache : le rendu synchrone le trouvera
      (out[collection] = out[collection] || []).push(link.id);
    }
    return out;
  }
}
