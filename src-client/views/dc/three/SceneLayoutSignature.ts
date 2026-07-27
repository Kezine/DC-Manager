/* =============================================================================
   SIGNATURE de DISPOSITION de la scène 3D + DÉCISION d'invalidation.

   Module PUR (aucun import THREE, aucun DOM — seuls des TYPES sont importés, donc
   effacés à la compilation) : il est testable en Node, contrairement au moteur qu'il
   sert. C'est délibéré — l'invalidation du rendu 3D est la logique la plus subtile du
   moteur et la seule qu'on puisse couvrir sans monter un contexte WebGL.

   POURQUOI CE MODULE EXISTE. `DcThreeScene.applyOptionsDiff` décidait de reconstruire
   la scène à partir d'une clé qui ne portait QUE l'ensemble des identifiants de salles
   (« M:dc-a,dc-b »). Or la vue pousse une DISPOSITION complète : origine et orientation
   de chaque salle, décor d'étage (plans, étiquettes, séparateurs, OOB, équipements
   d'étage). Tout ce qui DÉPLACE la géométrie sans changer l'ENSEMBLE des salles était
   donc invisible au diff — la nouvelle disposition était mémorisée mais jamais appliquée
   au graphe de scène. Symptômes constatés : le curseur d'échelle inter-sites, la bascule
   linéaire/logarithmique et la bascule « Vue étage » (quand la portée affichée ne change
   pas) ne prenaient effet qu'au rechargement de la page.

   RÈGLE D'ARBITRAGE (cf. CLAUDE.md, « Rendu 3D ») : ne JAMAIS sous-invalider — une
   reconstruction inutile coûte du temps, un mesh périmé à l'écran ment. La signature
   couvre donc TOUT ce que la disposition transporte, pas seulement les trois réglages
   qui ont révélé le défaut.

   STABILITÉ — l'autre moitié du contrat. Une signature qui varierait d'un rendu à
   l'autre SANS changement reconstruirait la scène à chaque événement d'affichage et
   ferait ramer l'application : ce serait pire que le bug corrigé. D'où deux exigences
   tenues ici :
   - la signature se dérive UNIQUEMENT des valeurs reçues (aucune horloge, aucun
     compteur, aucune identité d'objet) — deux calculs successifs de la même disposition
     rendent la MÊME chaîne, y compris pour des objets fraîchement reconstruits ;
   - l'ORDRE des collections est conservé tel quel : il est déjà déterministe en amont
     (`FloorLayout.multiLayout` trie ses bâtiments et ses niveaux). On ne re-trie pas,
     sinon on masquerait un vrai changement d'ordre d'émission.
   `JSON.stringify` sérialise l'ensemble : les chaînes y sont échappées, donc aucun
   libellé de bâtiment contenant un séparateur ne peut produire une collision.
   ============================================================================= */
import type { FloorDecor, FloorLabelDesc, RoomDesc } from "./DcThreeBase";

/** Ce qu'il faut faire du graphe de scène face à une nouvelle disposition.
    - `keep`      : rien de structurel n'a bougé (le diff d'OPTIONS peut suivre son cours) ;
    - `roomDelta` : seul l'ENSEMBLE des salles change → chemin incrémental (`applyRoomDelta`) ;
    - `rebuild`   : reconstruction COMPLÈTE (`build`). */
export type LayoutAction = "keep" | "roomDelta" | "rebuild";

/** État de disposition comparé : `ids` = ensemble ORDONNÉ des salles, `layout` = signature géométrique. */
export interface LayoutState { ids: string; layout: string; }

/** Contexte de la décision : la scène existe-t-elle, et le chemin incrémental est-il applicable ? */
export interface LayoutContext {
  hasContent: boolean;     // un graphe de scène est déjà construit (sinon : rien à diffuser)
  deltaEligible: boolean;  // multi→multi, salles non vides, aucune option d'affichage touchée par ailleurs
}

export class SceneLayoutSignature {

  /** Signature d'une disposition = salles POSÉES + décor d'étage. Deux dispositions rendant la même
      chaîne sont interchangeables À L'ÉCRAN : rien à reconstruire. */
  static of(rooms: ReadonlyArray<RoomDesc>, decor: FloorDecor | null): string {
    return JSON.stringify([
      (rooms || []).map((r) => SceneLayoutSignature.roomTuple(r)),
      decor ? SceneLayoutSignature.decorTuple(decor) : null,
    ]);
  }

  /** Signature de l'ABSENCE de disposition — la vue n'en a poussé aucune (contexte sans `multi`).
      Les deux côtés de la comparaison doivent alors retomber sur la MÊME valeur, sinon un contexte
      dégénéré reconstruirait la scène à chaque rendu. */
  static none(): string { return SceneLayoutSignature.of([], null); }

  /** Une salle posée : identité + repère (origine, orientation) + emprise + vide technique.
      L'emprise et `underfloorMm` en font partie parce qu'ils DESSINENT (sol, grille, dalle technique). */
  private static roomTuple(r: RoomDesc): unknown[] {
    return [r.dcId, r.ox, r.oy, r.oz, r.o, r.w, r.d, r.underfloorMm == null ? null : r.underfloorMm];
  }

  /** Décor d'étage : plans (emprise, ancrage, cellules bloquées), OOB posés, équipements d'étage,
      étiquettes de niveau et de bâtiment (séparateur compris), et les bornes du monde. */
  private static decorTuple(d: FloorDecor): unknown[] {
    return [
      d.planes.map((p) => [p.loc, p.floor, p.W, p.D, p.cell, p.ox, p.oy, p.z, p.blocked]),
      d.oobs.map((o) => [o.id, o.x, o.y, o.z, o.baseZ]),
      d.equips.map((e) => [e.id, e.x, e.y, e.baseZ]),
      d.levels.map((l) => SceneLayoutSignature.labelTuple(l)),
      d.buildings.map((b) => SceneLayoutSignature.labelTuple(b)),
      d.maxD, d.topZ,
    ];
  }

  private static labelTuple(l: FloorLabelDesc): unknown[] {
    return [l.label, l.x, l.y, l.z, l.sepX == null ? null : l.sepX];
  }

  /** DÉCISION d'invalidation. L'ordre des tests EST la doctrine :
      1. pas de scène → reconstruction (rien à diffuser) ;
      2. l'ENSEMBLE des salles change → chemin incrémental s'il est applicable, sinon reconstruction ;
      3. même ensemble mais disposition DIFFÉRENTE (échelle, repère, décor d'étage…) → reconstruction ;
      4. disposition identique → on ne touche à rien, le diff d'options prend le relais.
      Le point 3 est le correctif : c'est le cas qui ne faisait RIEN et n'apparaissait qu'au
      rechargement. Le point 4 est le garde-fou inverse — sans lui, chaque rendu reconstruirait. */
  static action(current: LayoutState, next: LayoutState, ctx: LayoutContext): LayoutAction {
    if (!ctx.hasContent) return "rebuild";
    if (current.ids !== next.ids) return ctx.deltaEligible ? "roomDelta" : "rebuild";
    return current.layout === next.layout ? "keep" : "rebuild";
  }
}
