/* =============================================================================
   RackResize — règle PURE « qui ne tient plus dans la cage » lors d'un
   redimensionnement du nombre de U d'une baie (aucun store, aucun DOM → testable
   en isolation, cf. principe n°2).

   POURQUOI un module dédié : la règle est consommée par DEUX chemins qui doivent
   IMPÉRATIVEMENT s'accorder, sinon on rejoue le bug qu'elle corrige —
     • le chemin d'ÉCRITURE (formulaire de baie) qui décide ce qu'il faut déplacer
       ou supprimer quand `u_count` change ;
     • le chemin de RENDU (`RackScene.occupantsElev`) qui refuse de dessiner un
       occupant hors cage — indispensable car les documents DÉJÀ corrompus par les
       redimensionnements passés contiennent des pseudo-occupants hors bornes, que
       corriger l'écriture ne répare pas rétroactivement.

   ASYMÉTRIE ASSUMÉE entre les deux familles d'occupants (cf. `fallout`) : un
   équipement racké EXISTE hors de sa baie (il retombe au « pool » des non placés,
   accessible par ses listings), alors qu'un PSEUDO-OCCUPANT (obturateur, étagère,
   réservation) n'a AUCUNE existence hors baie et n'apparaît dans AUCUN listing —
   son seul point d'accès est la vue 3D / l'édition 2D de baie. Le laisser sans
   position U en ferait donc un fantôme définitivement inatteignable : on le
   SUPPRIME. La cascade `rackItems` détache alors les équipements posés dessus, qui
   redeviennent « non placés » (donc de nouveau accessibles).
   ============================================================================= */

/** Emprise en U d'un occupant de baie. `kind` distingue les deux familles :
    "item" = pseudo-occupant (collection `rackItems`), tout le reste = équipement racké
    (convention de `RackScene.occupantsElev`, qui émet "eq" / "item"). */
export interface RackUSpan { id: string; u: number; h: number; kind: string }

/** Occupants à évacuer d'une cage redimensionnée, par famille (ids). */
export interface RackResizeFallout { equipmentIds: string[]; itemIds: string[] }

export class RackResize {
  /** Un occupant de `h` U démarrant au U `u` tient-il dans une cage de `uCount` U ?
      Les U sont numérotés à partir de 1 ; l'occupant couvre `u … u + h − 1`. Une emprise
      à U < 1 est tenue pour NON conforme (donnée corrompue à évacuer, pas à dessiner). */
  static fits(u: number, h: number, uCount: number): boolean {
    const start = u | 0, height = Math.max(1, h | 0 || 1), max = Math.max(0, uCount | 0);
    return start >= 1 && start + height - 1 <= max;
  }

  /** Occupants qui NE TIENNENT PLUS dans une cage de `uCount` U, séparés par famille car leur
      traitement DIFFÈRE (équipement → remis au pool ; pseudo-occupant → supprimé, cf. en-tête).
      Ce qui tient encore n'est JAMAIS touché : agrandir une baie ne doit rien déplacer ni détruire. */
  static fallout(spans: RackUSpan[], uCount: number): RackResizeFallout {
    const out: RackResizeFallout = { equipmentIds: [], itemIds: [] };
    for (const s of spans) {
      if (RackResize.fits(s.u, s.h, uCount)) continue;
      if (s.kind === "item") out.itemIds.push(s.id); else out.equipmentIds.push(s.id);
    }
    return out;
  }
}
