/* =============================================================================
   ModalStack — la PILE de modales et TOUTES ses règles, SANS DOM.

   Pourquoi un module à part (principe n°2) : `ui/Modal` n'est pas testable sans
   navigateur (il construit sa DOM au constructeur). Or la politique de la pile —
   « au plus UNE édition vivante », « la fermeture totale s'arrête sur l'édition »
   — est exactement ce qui doit être VÉRIFIÉ, pas ce qui doit être vu. On la sort
   donc ici, où elle se teste à blanc, et `Modal` ne garde que l'orchestration
   DOM/a11y. Cf. `.notes/toDos/pile-de-modales-cadrage-2026-07-30.md` (D9).

   MODÈLE — la pile contient TOUS les niveaux, le SOMMET étant celui qui est
   AFFICHÉ. Ce n'est pas un détail : `pushAllowed` doit voir le niveau courant
   (une édition affichée interdit d'en pousser une seconde), et `closeAllTarget`
   doit distinguer une édition AU SOMMET (l'utilisateur la voit — on ferme, il
   sait ce qu'il perd) d'une édition ENFOUIE sous des fiches (il ne la voit plus
   — on la lui redonne au lieu de la détruire en silence).

   ENTRÉE GÉNÉRIQUE : la pile ne connaît d'un niveau que sa NATURE (`kind`) et son
   LIBELLÉ (`title`) ; `Modal` y accroche tout son état DOM via le paramètre de
   type. Le module reste ainsi pur — aucun `HTMLElement` dans sa signature.
   ============================================================================= */

/** Nature d'un niveau. `edit` = le niveau porte une SAISIE (l'appelant a fourni un `onSave`) ;
    `info` = une fiche en lecture (pied masqué). C'est le seul discriminant des règles D9. */
export type ModalKind = "edit" | "info";

/** Ce que la pile exige de CHAQUE entrée. `title` est le libellé AFFICHABLE du niveau (titre,
    éventuellement complété du sous-titre par l'appelant) : il sert le toast « Vous éditez … »
    ET l'info-bulle du bouton ← Retour, qui doivent nommer la même chose. */
export interface ModalStackEntry {
  kind: ModalKind;
  title: string;
  /** Clé d'IDENTITÉ optionnelle du niveau (D5). Sa raison d'être : les BOUCLES de navigation. Une
      fiche A qui ouvre une fiche liée B, laquelle rouvre A, empilerait un SECOND A — et le ← Retour
      repasserait alors par B avant de retrouver le vieux A, une pile absurde. Munie d'une clé, la
      seconde visite de A REDESCEND jusqu'à la première au lieu d'empiler (cf. `indexOfKey`).
      SEULES LES FICHES en fournissent une : un FORMULAIRE ne doit JAMAIS être dédupliqué — écraser
      un niveau de saisie perdrait la frappe en cours. On ne déduplique donc que ce qui est
      reconstructible depuis le store (les fiches, via leur `onResume`). */
  stackKey?: string;
}

/** Verdict d'un PUSH (règle D9b). Le refus porte le libellé de l'édition qui BLOQUE — sans lui,
    le toast ne pourrait pas dire CE QUE l'utilisateur est en train d'éditer. */
export type ModalPushDecision =
  | { ok: true }
  | { ok: false; editingTitle: string };

/** Ce que doit faire une demande de FERMETURE TOTALE (✕ / Échap / clic hors modale, règle D9a) :
    - `closeAll` : détruire tous les niveaux (aucune édition, ou l'édition est AU SOMMET) ;
    - `popTo`    : dépiler jusqu'à l'entrée d'index `index` (une ÉDITION enfouie) et s'arrêter
                   dessus, en signalant `editingTitle` par un toast. */
export type ModalCloseAllTarget =
  | { action: "closeAll" }
  | { action: "popTo"; index: number; editingTitle: string };

export class ModalStack<E extends ModalStackEntry = ModalStackEntry> {
  /** Du BAS (index 0, le 1er ouvert) vers le SOMMET (dernier index, celui qui est affiché). */
  private readonly entries: E[] = [];

  /** Empile un niveau ; il devient le SOMMET (celui que `Modal` affiche). */
  push(entry: E): void { this.entries.push(entry); }

  /** Dépile le SOMMET et le rend (null si la pile est vide) — au reste de décider de son sort. */
  pop(): E | null { return this.entries.pop() || null; }

  /** Niveau AFFICHÉ (null si aucune modale n'est ouverte). */
  top(): E | null { return this.entries.length ? this.entries[this.entries.length - 1] : null; }

  /** Niveau d'index `index` en partant du BAS (null hors bornes) — sert le libellé du niveau
      PRÉCÉDENT (info-bulle du ← Retour) et la cible d'un `popTo`. */
  at(index: number): E | null {
    return (index >= 0 && index < this.entries.length) ? this.entries[index] : null;
  }

  /** Nombre de niveaux vivants, SOMMET COMPRIS. 0 = plus rien d'ouvert (fermeture réelle). */
  depth(): number { return this.entries.length; }

  /** Vide la pile et rend les niveaux DU SOMMET VERS LE BAS — l'ordre dans lequel une fermeture
      totale doit les détruire (on démonte ce qu'on voit avant ce qui est dessous). */
  clear(): E[] {
    const removed = this.entries.slice().reverse();
    this.entries.length = 0;
    return removed;
  }

  /** D5 — index (0 = BAS de la pile) de l'entrée portant la clé `key`, ou -1 si aucune ne la porte.
      Sert la dédup des boucles : au push d'une fiche déjà présente, `Modal` REDESCEND jusqu'à cet
      index au lieu d'empiler un doublon.
      Une entrée SANS `stackKey` n'est JAMAIS reconnue (les formulaires, dépourvus de clé, restent
      donc hors dédup — le garde `!== undefined` le rend explicite, `key` étant toujours une chaîne).
      Si — cas qui ne devrait pas survenir — deux entrées portaient la même clé, on rend la PLUS
      HAUTE : c'est jusqu'à la visite la plus récente qu'il faut redescendre, pas jusqu'à un vieux
      doublon enfoui. D'où le parcours du SOMMET vers le bas. */
  indexOfKey(key: string): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].stackKey !== undefined && this.entries[i].stackKey === key) return i;
    }
    return -1;
  }

  /** L'ÉDITION vivante de la pile, à n'importe quel niveau (null si aucune). L'invariant D9b —
      au plus une — est garanti par `pushAllowed` ; on rend donc la PLUS HAUTE, ce qui reste juste
      même si un jour l'invariant venait à être assoupli. */
  editionAlive(): E | null {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].kind === "edit") return this.entries[i];
    return null;
  }

  /** D9b — peut-on empiler un niveau de nature `kind` ?
      Une ÉDITION est REFUSÉE tant qu'une édition vit dans la pile : deux saisies concurrentes
      rendraient le toast « Vous éditez … » ambigu, et surtout la fermeture totale n'aurait plus
      un seul point d'arrêt. Une FICHE (`info`) passe toujours — c'est le flux courant
      (fiche → fiche liée, intervention → cible…). */
  pushAllowed(kind: ModalKind): ModalPushDecision {
    if (kind !== "edit") return { ok: true };
    const editing = this.editionAlive();
    return editing ? { ok: false, editingTitle: editing.title } : { ok: true };
  }

  /** D9a — que doit faire ✕ / Échap / un clic hors modale ?
      GARDE : s'il existe une édition STRICTEMENT SOUS le sommet, la fermeture n'est PAS une
      fermeture — elle dépile les fiches posées par-dessus et REND l'édition à l'utilisateur (qui
      l'a perdue de vue), toast à l'appui. Un second ✕ fermera alors normalement, garde « modifié »
      du niveau comprise.
      Si l'édition est AU SOMMET (ou qu'il n'y en a aucune), on ferme TOUT : l'utilisateur VOIT ce
      qu'il ferme, et le garde-fou par niveau suffit — d'où l'absence de toast dans ce cas. */
  closeAllTarget(): ModalCloseAllTarget {
    for (let i = this.entries.length - 2; i >= 0; i--) {   // −2 : le sommet est exclu, par définition de la garde
      if (this.entries[i].kind === "edit") return { action: "popTo", index: i, editingTitle: this.entries[i].title };
    }
    return { action: "closeAll" };
  }
}
