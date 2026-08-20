/* =============================================================================
   ShellNav — LOGIQUE PURE de navigation entre vues du Shell (sans DOM).
   -----------------------------------------------------------------------------
   Extraite du Shell pour être TESTABLE en isolation (le Shell, lui, manipule le
   DOM et n'est pas testable headless). Ce qu'il reste ici depuis le re-design du
   menu à DEUX NIVEAUX (cf. `app/NavModel` et docs/navigation.md) — la STRUCTURE du
   menu, elle, vit désormais dans `NavModel` :

     · `activeTab`    — vue de rattachement HISTORIQUE d'une (sous-)vue. Elle ne
                        commande plus le surlignage (c'est le DOMAINE qui le fait) :
                        elle sert de REPLI quand une vue n'est rattachée à aucun
                        domaine — anomalie que le verrou d'exhaustivité interdit,
                        mais que le rendu doit traverser sans planter ;
     · `isNavigable`  — une entrée est-elle une VUE (donc navigable) ? Un DOMAINE
                        ne navigue jamais (piège ① : il n'a ni section, ni corps,
                        ni hash — exactement comme l'ancien `kind:"group"`, qu'il
                        remplace) ; un nom inconnu non plus ;
     · `resolveHash`  — un fragment d'URL (#nom) → NOM DE VUE navigable, en
                        EXCLUANT les domaines. Les deep-links des vues sont
                        INCHANGÉS par le re-design (contrainte dure du carton),
                        y compris pour les sous-vues (piège ⑤ : #contacts ouvre
                        bien la sous-page).
   ============================================================================= */

/** Carte `nom → { parent, kind }`, pour raisonner sur les entrées sans le DOM.
    ⚠ `kind: "domain"` n'est PAS un `ShellView.kind` : c'est le type que le Shell attribue aux entrées
    de `NAV_DOMAINS` quand il fabrique cette carte, précisément pour que `resolveHash` les REFUSE. */
export type ShellNavLookup = Record<string, { parent?: string; kind?: string }>;

export class ShellNav {
  /** Vue de rattachement HISTORIQUE : le parent (sous-vue) sinon le nom lui-même.
      NB : ce n'est PLUS ce qui décide du surlignage — depuis le menu à deux niveaux, c'est le DOMAINE
      de la vue active qui est mis en avant (`NavModel.activeDomain`). Cette fonction reste le REPLI du
      Shell : si la vue active n'appartient à aucun domaine visible, il cherche le domaine de son
      parent déclaré plutôt que de laisser la barre sans repère. */
  static activeTab(view: { name: string; parent?: string }): string {
    return view.parent || view.name;
  }

  /** Une entrée `name` est-elle une VUE NAVIGABLE (enregistrée ET pas un domaine) ? Un domaine est un
      REGROUPEMENT : cliquer dessus active sa première vue, mais il ne s'atteint pas par une URL
      (piège ①). Un nom inconnu n'est pas navigable non plus. */
  static isNavigable(name: string, lookup: ShellNavLookup): boolean {
    const d = lookup[name];
    return !!d && d.kind !== "domain";
  }

  /** Résout un fragment d'URL (#nom, éventuellement encodé) en NOM DE VUE navigable, ou null. Utilisé au boot
      (deep-link) et sur `hashchange` : #contacts ouvre la sous-page (piège ⑤) ; #<domaine> est ignoré (piège ①). */
  static resolveHash(rawHash: string, lookup: ShellNavLookup): string | null {
    const v = decodeURIComponent((rawHash || "").replace(/^#/, ""));
    return v && ShellNav.isNavigable(v, lookup) ? v : null;
  }
}
