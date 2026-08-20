/* =============================================================================
   NavModel — MODÈLE PUR de la navigation à DEUX NIVEAUX (domaines ▸ vues).
   -----------------------------------------------------------------------------
   Re-design du menu (maquette `design-system/briefs/menu-app-redesign-maquette.html`) :
   les 11 onglets primaires historiques + leurs sous-vues deviennent les VUES de
   CINQ DOMAINES. Un domaine est un REGROUPEMENT, pas une vue : ni section, ni
   corps, ni hash (même piège ① que l'ancien `kind:"group"`, qui disparaît).

     niveau 1 — DOMAINE  : Inventaire · Implantation · Réseau · Exploitation · Paramètres
     niveau 2 — VUE      : toutes les vues du domaine, dans une barre de pastilles

   Ce module ne connaît NI le DOM NI le Shell : il reçoit des déclarations et un
   prédicat de visibilité, et rend la structure RÉSOLUE à afficher. Le Shell se
   contente de la peindre. C'est ce qui le rend testable en isolation (le Shell,
   lui, ne l'est pas — cf. la même raison d'être que `ShellNav`, qui garde les
   helpers de hash/ancêtres).

   ─────────────────────────────────────────────────────────────────────────────
   🚨 RÈGLE (A) — LES COMPTEURS NE VIVENT QUE SUR LES ENTRÉES TERMINALES.
   Décision UTILISATEUR du 2026-08-20, qui TRANCHE CONTRE la maquette (sa note
   « 4 · Badges qui remontent » proposait d'agréger sur le domaine et sur le
   burger). Un badge de comptage n'appartient QU'À une entrée SANS ENFANT :
     · une VUE (niveau 2)                    → badge autorisé ;
     · un DOMAINE (niveau 1)                 → JAMAIS, il a des enfants ;
     · l'en-tête d'accordéon du tiroir mobile → JAMAIS (c'est un domaine) ;
     · le bouton burger                       → JAMAIS (il ne représente rien de terminal).
   La règle est portée par `allowsBadge()` et appliquée à la CONSTRUCTION de la
   structure résolue : une entrée à enfants sort avec `badge:false` même si sa
   déclaration porte un `count()`. Elle n'est donc pas une convention de câblage
   qu'un futur appelant pourrait oublier — elle est vérifiable, et vérifiée
   (cf. `Tests/modules/test-nav-model.js`).

   ⚠ Conséquence ASSUMÉE, à connaître : une alerte (interventions critiques,
   certificats expirants) n'est visible que lorsque la barre de vues de son
   domaine est affichée — donc pas depuis un autre domaine, ni tiroir fermé en
   mobile. C'est en tension avec la douleur n°4 du carton (« l'alerte doit rester
   visible dans TOUT régime »). La règle (A) prime ; la remontée d'alerte devra,
   si elle est voulue, passer par un porteur HORS MENU (cloche de notification),
   jamais par un badge sur un parent.
   ============================================================================= */

/** Déclaration d'un DOMAINE (niveau 1). `views` = noms de vues, dans l'ordre d'affichage. */
export interface NavDomainDecl {
  name: string;
  /** Clé i18n du libellé (résolue par l'appelant — ce module ne traduit pas). */
  label: string;
  /** Constante SVG du registre `ui/Icons`. */
  icon?: string;
  views: string[];
  /** Noms de vues devant être PRÉCÉDÉES d'un séparateur dans la barre (regroupement visuel interne). */
  separatorsBefore?: string[];
}

/** Ce que le modèle a besoin de savoir d'une VUE (sous-ensemble de `ShellView`). */
export interface NavViewDecl {
  name: string;
  label: string;
  icon?: string;
  /** La vue déclare-t-elle un `count()` ? (la VALEUR est lue par le Shell, pas ici) */
  hasCount?: boolean;
}

/** Une vue telle que RÉSOLUE pour l'affichage. */
export interface ResolvedNavView {
  name: string;
  label: string;
  icon?: string;
  /** Un séparateur précède-t-il cette pastille ? (jamais en tête de barre — normalisé ici) */
  separatorBefore: boolean;
  /** Badge de comptage autorisé sur cette entrée — règle (A). */
  badge: boolean;
}

/** Un domaine tel que RÉSOLU pour l'affichage (ne contient que ses vues VISIBLES). */
export interface ResolvedNavDomain {
  name: string;
  label: string;
  icon?: string;
  views: ResolvedNavView[];
  /** Domaine réduit à UNE vue visible → onglet DIRECT, pas de barre de vues (règle de dégradé). */
  direct: boolean;
  /** Badge autorisé ? DÉRIVÉ de la règle (A) appliquée aux enfants RÉELS du domaine — donc toujours
      `false`, puisqu'un domaine sans aucune vue a déjà disparu de la structure. Volontairement
      CALCULÉ et non codé en dur : la règle reste la seule source, et l'invariant « jamais de badge
      sur un domaine » est prouvé par le test plutôt qu'affirmé par le type. Le rendu, lui, se
      contente de lire ce booléen — il n'a aucune règle à ré-appliquer. */
  badge: boolean;
}

/** Structure complète à peindre. */
export interface ResolvedNav {
  domains: ResolvedNavDomain[];
  /** UN SEUL domaine visible → le niveau 1 s'efface, ses vues DEVIENNENT le niveau 1 (règle de dégradé).
      Le Shell peint alors `domains[0].views` dans la barre de niveau 1 et n'affiche pas de barre de vues. */
  flattened: boolean;
}

export class NavModel {
  /** 🚨 RÈGLE (A), forme atomique et réutilisable : une entrée porte un badge SI ET SEULEMENT SI elle
      est TERMINALE — c'est-à-dire SANS ENFANT. On passe les enfants EUX-MÊMES (absents pour une vue,
      la liste des vues pour un domaine) plutôt qu'un drapeau : la règle reste alors la seule chose à
      lire, et aucun appelant ne peut décider à sa place qu'il est « terminal ».
      Volontairement STRUCTURELLE — on lit la déclaration, pas l'état courant de visibilité : sinon un
      domaine dont les droits masquent tous les enfants sauf un verrait un badge APPARAÎTRE, et le
      même compte clignoterait d'un utilisateur à l'autre. */
  static allowsBadge(children?: readonly unknown[]): boolean {
    return !children || children.length === 0;
  }

  /** Domaine d'appartenance d'une vue (null si la vue n'est rattachée à aucun domaine — anomalie
      que le test d'exhaustivité interdit, mais que le rendu doit traverser sans planter). */
  static domainOf(viewName: string, domains: readonly NavDomainDecl[]): string | null {
    for (const d of domains) if (d.views.includes(viewName)) return d.name;
    return null;
  }

  /** Toutes les vues rattachées à un domaine, dans l'ordre déclaré (à plat, tous domaines confondus). */
  static declaredViews(domains: readonly NavDomainDecl[]): string[] {
    return domains.flatMap((d) => d.views);
  }

  /** Une entrée `name` est-elle un DOMAINE ? (un domaine ne navigue jamais — piège ①) */
  static isDomain(name: string, domains: readonly NavDomainDecl[]): boolean {
    return domains.some((d) => d.name === name);
  }

  /** STRUCTURE RÉSOLUE à afficher, pour un jeu de droits donné.
      `isVisible(viewName)` = prédicat de LECTURE de la vue (cf. `ShellView.visible`). Règles de dégradé
      reprises de la maquette (§ 04 « Droits partiels ») :
        · un domaine sans AUCUNE vue visible DISPARAÎT ;
        · un domaine réduit à UNE vue visible devient un onglet DIRECT (`direct:true`, pas de barre de vues) ;
        · s'il ne reste QU'UN domaine visible, le niveau 1 s'efface (`flattened:true`) et ses vues
          deviennent le niveau 1.
      Les badges suivent la règle (A) : autorisés sur les vues, refusés sur les domaines. */
  static resolve(
    domains: readonly NavDomainDecl[],
    views: readonly NavViewDecl[],
    isVisible: (viewName: string) => boolean,
  ): ResolvedNav {
    const byName = new Map(views.map((v) => [v.name, v] as const));
    const resolved: ResolvedNavDomain[] = [];

    for (const d of domains) {
      const seps = new Set(d.separatorsBefore || []);
      const kept: ResolvedNavView[] = [];
      for (const viewName of d.views) {
        const decl = byName.get(viewName);
        if (!decl) continue;                    // vue non enregistrée (module absent selon le mode) → omise
        if (!isVisible(viewName)) continue;     // droit de lecture refusé → omise
        kept.push({
          name: decl.name,
          label: decl.label,
          icon: decl.icon,
          // Un séparateur n'a de sens qu'ENTRE deux pastilles : jamais en tête de barre — sinon le
          // masquage par droits laisserait un trait orphelin au bord.
          separatorBefore: seps.has(viewName) && kept.length > 0,
          // Règle (A) : une VUE n'a pas d'enfant dans ce modèle à deux niveaux → appel SANS enfants.
          badge: !!decl.hasCount && NavModel.allowsBadge(),
        });
      }
      if (kept.length === 0) continue;          // domaine vide → il disparaît
      resolved.push({
        name: d.name, label: d.label, icon: d.icon,
        views: kept,
        direct: kept.length === 1,
        // Règle (A) appliquée aux enfants RÉELS : un domaine en a au moins un ici (`kept.length > 0`),
        // donc jamais de badge — même si ses vues en portent. Aucune agrégation, contre la maquette.
        badge: NavModel.allowsBadge(kept),
      });
    }

    return { domains: resolved, flattened: resolved.length === 1 };
  }

  /** ENTRÉES DU TIROIR RESPONSIVE : un accordéon par domaine VISIBLE, contenant TOUTES ses vues
      visibles — sous-vues comprises. C'est la correction du trou de l'ancien menu aplati, où les
      sous-vues d'une primaire (Groupes, Spares…) n'apparaissaient nulle part et n'étaient
      atteignables qu'en passant par leur parent.
      La structure est la MÊME que `resolve()` — le tiroir n'a pas de modèle à lui, il PEINT
      autrement la même vérité (donc les règles de dégradé et la règle (A) y valent à l'identique). */
  static drawer(nav: ResolvedNav): ResolvedNavDomain[] {
    return nav.domains;
  }

  /** Domaine à OUVRIR pour une vue active donnée (accordéon déplié / domaine surligné). Null si la
      vue n'appartient à aucun domaine visible — le Shell retombe alors sur le premier domaine. */
  static activeDomain(viewName: string, nav: ResolvedNav): string | null {
    for (const d of nav.domains) if (d.views.some((v) => v.name === viewName)) return d.name;
    return null;
  }

  /** Première vue visible dans l'ordre des domaines — cible du repli quand la vue courante devient
      inaccessible (droits retirés à chaud). Null si plus AUCUNE vue n'est visible. */
  static firstVisibleView(nav: ResolvedNav): string | null {
    for (const d of nav.domains) if (d.views.length) return d.views[0].name;
    return null;
  }
}

/* =============================================================================
   CATALOGUE DES DOMAINES — source UNIQUE du rattachement vue → domaine.
   -----------------------------------------------------------------------------
   Vit ICI (et pas dans `main.ts`) pour la même raison que `core/ViewAccess` :
   un test d'EXHAUSTIVITÉ peut alors relire les sources de `main.ts`, y trouver
   toute vue enregistrée, et échouer en la NOMMANT si elle n'est rattachée à
   aucun domaine. Une vue ajoutée demain ne peut donc pas disparaître
   silencieusement du menu — elle fait échouer la suite.

   ⚠ Les LIBELLÉS sont des CLÉS i18n (`I18n.t` est appelé par l'appelant, pas ici :
   ce module reste pur et sans dépendance).
   ============================================================================= */
export const NAV_DOMAINS: readonly NavDomainDecl[] = [
  {
    name: "inventaire", label: "nav.domain.inventaire", icon: "EQUIPMENT",
    views: ["equipements", "groupes", "spares", "sousequipements", "applications", "attachments", "faceimages",
            "vms", "clusters", "wifi"],
    separatorsBefore: ["vms", "wifi"],
  },
  {
    name: "implantation", label: "nav.domain.implantation", icon: "DATACENTER",
    views: ["racks", "datacenter", "sites", "salles", "etages"],
    separatorsBefore: ["datacenter"],
  },
  {
    name: "reseau", label: "nav.domain.reseau", icon: "NETWORK",
    views: ["cables", "faisceaux", "reseaux", "cabletypes", "porttypes",
            "ipam", "ipnetworks", "dhcpranges", "graph"],
    separatorsBefore: ["ipam", "graph"],
  },
  {
    name: "exploitation", label: "nav.domain.exploitation", icon: "INTERVENTION",
    views: ["interventions", "certificats"],
  },
  {
    name: "parametres", label: "nav.domain.parametres", icon: "SETTINGS",
    views: ["contacts", "notifications"],
  },
];
