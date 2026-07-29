/* =============================================================================
   WebglHostVisibility — « l'hôte du moteur 3D WebGL doit-il être VISIBLE ? »

   Classe PURE : aucun DOM, aucun store, aucun réseau. Ne prend que l'état de vue
   (trois drapeaux) et n'en rend qu'un booléen — donc testable hors navigateur,
   ce qui est TOUT l'intérêt de son existence (voir plus bas).

   POURQUOI CE MODULE (principe n°2 : une règle identifiable vit dans sa propre
   fonction testable ; dette n°7 du backlog, signalée par l'utilisateur le
   2026-07-29).

   Le canevas WebGL est un hôte PERSISTANT : on le conserve attaché entre les
   onglets/sous-vues pour éviter une reconstruction coûteuse de la scène (il est
   délibérément EXCLU de `DcBase.clearStage`). Sa VISIBILITÉ est donc pilotée à
   part, par un simple `style.display`. Or, dans `DcBase.render()`, DEUX lignes
   décidaient chacune de leur côté :
     • l'une le rendait visible dès qu'on était en « 3D + WebGL » ;
     • l'autre, plus bas, sortait sur le cas « aucune salle » (message
       « Aucune salle ») SANS retoucher l'hôte.
   Conséquence exacte du bug : en chargeant un document SANS SALLE alors qu'on
   était en vue 3D, la première ligne rendait l'hôte visible, la sortie anticipée
   se contentait d'ajouter le message par-dessus, et le canevas du document
   PRÉCÉDENT restait monté et affiché — tout le reste de l'UI annonçait pourtant
   « plus rien ». Deux endroits posant la même question ont fini par y répondre
   différemment : la panne classique qu'une SOURCE UNIQUE ferme (cf. `Locatable`,
   `VmStatus`).

   POURQUOI EN FAIRE UN MODULE PLUTÔT QU'UNE LIGNE. `render()` n'est pas
   atteignable en test : elle sort d'emblée sur `typeof document === "undefined"`
   et le harnais est un Node sans DOM. Une règle laissée à l'intérieur
   échapperait donc à tout verrou — un futur remaniement pourrait rouvrir la
   contradiction sans qu'aucun test ne rougisse. Extraite ici, la décision porte
   une TABLE DE VÉRITÉ verrouillée par test, et `render()` la consomme À UN SEUL
   endroit.

   LA RÈGLE, en trois conditions ET rien de plus : l'hôte est visible si, et
   seulement si, on est en vue 3D, avec le moteur WebGL, ET qu'il y a une salle à
   montrer. Sans salle, il n'y a RIEN à dessiner en 3D (la vue affiche le message
   « Aucune salle ») : l'hôte doit être masqué — sans être détaché, l'optimisation
   « moteur gardé chaud » survit puisqu'on ne touche qu'à `display`.

   ⚠ POURQUOI LA VUE ÉTAGE (« floor ») N'EST PAS UN PARAMÈTRE. On pourrait croire
   qu'un « étage cible » entre dans la décision. Il n'en est rien : la Vue étage
   est un rendu 2D (SVG), l'hôte WebGL n'y est JAMAIS montré. La condition
   `view === "3d"` la couvre donc entièrement, quel que soit l'étage résolu. La
   « Vue étage 3D » (étages empilés) est, elle, une vue « 3d » avec `multiDc` —
   pas la vue « floor » — et passe par la branche salle normale.

   ⚠ CE N'EST PAS UNE QUESTION DE REPÈRE (borne §6.6) : ce module ne compose
   aucune transformée, il ne fait pas partie de `geometry/`. Il répond « la vue
   doit-elle AFFICHER son canevas 3D ? » à partir de l'état de vue — sa place est
   donc `core/`, aux côtés de `Locatable`/`VmStatus`.
   ============================================================================= */

/** Les trois natures de vue de la vue Datacenter (pendant du champ `DcBase.view`). */
export type DcViewKind = "3d" | "top" | "floor";

export class WebglHostVisibility {
  /** L'hôte du moteur 3D WebGL doit-il être VISIBLE ?
      @param view    nature de la vue courante (« 3d » | « top » | « floor »).
      @param useWebGL moteur 3D = WebGL (Three.js) actif — false = 3D legacy SVG (hôte démonté ailleurs).
      @param hasRoom il y a une SALLE à montrer (`DcBase.current()` non nul) — sans salle, rien à dessiner. */
  static visible(view: DcViewKind, useWebGL: boolean, hasRoom: boolean): boolean {
    return view === "3d" && useWebGL && hasRoom;
  }
}
