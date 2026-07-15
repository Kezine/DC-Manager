import { CertsFormat } from "./CertsFormat";

/* =============================================================================
   CertsSearch — logique PURE de la recherche de certificats (aucun DOM, aucun
   réseau) : mapping d'un item serveur vers un résultat de popover, et DÉCISION de
   navigation au clic (quelle vue ouvrir, sur quelle racine, quel élément cibler).

   Pourquoi une classe pure dédiée (principes n°2/n°7) : ces deux règles sont le
   cœur métier de la recherche (le reste, SearchPop, est du DOM) et se testent en
   isolation (Tests/modules/test-certs.js). La vue (CertsAdminView) ne fait
   qu'assembler : elle appelle `toResult` pour peupler le popover et `navTarget`
   pour router le clic vers la bonne page.
   ============================================================================= */

/** Entrée MINIMALE nécessaire à la recherche (sous-ensemble de `CertificatePageItem`) — on ne
    dépend pas du DTO complet du client REST pour rester pur et testable. */
export interface CertSearchItem {
  id: string;
  label: string;
  /** Famille de l'objet (root-ca / leaf-tls / ssh-ca / ssh-keypair / ssh-cert). */
  kind: string;
  /** Racine de l'arbre du certificat (null au PREMIER NIVEAU) — donné par le serveur (CTE d'ascendance). */
  root_id: string | null;
}

/** Un résultat de popover (forme structurellement compatible avec `SearchPopResult`) : `data`
    porte l'item d'origine, réutilisé au clic pour calculer la cible de navigation. */
export interface CertSearchResult {
  id: string;
  label: string;
  tag: string;
  data: CertSearchItem;
}

/** Cible de navigation calculée au clic sur un résultat (cadrage §4). */
export interface CertNavTarget {
  /** Vue à ouvrir : A « racines » (élément de premier niveau) ou B « sous-arbre d'une racine ». */
  view: "roots" | "certs";
  /** Racine à scoper en vue B (id) ; null en vue A. */
  rootId: string | null;
  /** Id de l'élément à mettre en évidence (paramètre `focus` serveur + surbrillance `.row-focus`). */
  focus: string;
}

export class CertsSearch {
  /** Mappe un item serveur en résultat de popover : `tag` = famille lisible (`CertsFormat.kindLabel`),
      `label` = libellé du certificat ; `data` conserve l'item pour la décision de navigation au clic. */
  static toResult(item: CertSearchItem): CertSearchResult {
    return { id: item.id, label: item.label, tag: CertsFormat.kindLabel(item.kind), data: item };
  }

  /** Décision de navigation (cadrage §4) au clic sur un résultat :
      - `root_id` NULL (élément de PREMIER NIVEAU) → vue A « Autorités & clés », focus sur l'élément ;
      - `root_id` POSÉ (dérivé) → vue B « Certificats de <racine> » scopée sur SA racine, focus sur l'élément.
      Dans les deux cas la ligne ciblée est `item.id` (jamais la racine, qui n'est cliquée que si elle-même
      est de premier niveau — auquel cas `root_id` est null). */
  static navTarget(item: CertSearchItem): CertNavTarget {
    if (!item.root_id) return { view: "roots", rootId: null, focus: item.id };
    return { view: "certs", rootId: item.root_id, focus: item.id };
  }
}
