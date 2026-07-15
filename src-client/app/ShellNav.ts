/* =============================================================================
   ShellNav — LOGIQUE PURE de navigation entre onglets du Shell (sans DOM).
   -----------------------------------------------------------------------------
   Extraite du Shell pour être TESTABLE en isolation (le Shell, lui, manipule le
   DOM et n'est pas testable headless). Trois responsabilités, toutes déclaratives :

     · `activeTab`      — quel onglet PRINCIPAL surligner pour une (sous-)vue active
                          (le parent d'une sous-vue, sinon la vue elle-même) ;
     · `ancestorGroup`  — le GROUPE (kind:"group") ancêtre de la vue active, pour
                          surligner le bouton du groupe (piège ① : le groupe n'est
                          pas une vue, son état « actif » = un de ses enfants l'est) ;
     · `resolveHash`    — un fragment d'URL (#nom) → NOM DE VUE navigable, en
                          EXCLUANT les groupes (piège ① : le groupe n'a pas de hash
                          propre ; ses enfants gardent le leur — piège ⑤) ;
     · `responsiveMenu` — la structure APLATIE du menu déroulant responsive : les
                          primaires + chaque groupe (en-tête) suivi de ses enfants
                          indentés (piège ② : sinon les sous-pages d'un groupe
                          deviennent inaccessibles en mobile).
   ============================================================================= */

/** Déclaration MINIMALE d'une vue/d'un groupe telle que vue par la navigation (sous-ensemble de ShellView). */
export interface ShellNavView {
  name: string;
  label: string;
  kind?: "primary" | "secondary" | "group";
  parent?: string;
  /** Pour kind:"group" : noms des sous-vues déroulées. */
  children?: string[];
}

/** Carte `nom → { parent, kind }` (parent chain + type), pour remonter aux ancêtres sans le DOM. */
export type ShellNavLookup = Record<string, { parent?: string; kind?: string }>;

/** Une entrée du menu responsive : un item cliquable (avec profondeur d'indentation) ou l'en-tête d'un groupe. */
export type ResponsiveMenuEntry =
  | { role: "item"; name: string; label: string; depth: number }
  | { role: "group"; name: string; label: string };

export class ShellNav {
  /** Onglet PRINCIPAL à surligner pour la vue active : le parent (sous-vue) sinon le nom lui-même.
      NB : pour un enfant de groupe, `parent` est le NOM DU GROUPE — qui n'a pas de bouton d'onglet dans la
      barre des primaires ; le surlignage du groupe passe alors par `ancestorGroup` (cf. Shell.switchView). */
  static activeTab(view: { name: string; parent?: string }): string {
    return view.parent || view.name;
  }

  /** Remonte la chaîne des parents depuis `name` et renvoie le premier ANCÊTRE de kind:"group" (null sinon).
      Robuste aux sous-vues profondes (un enfant de groupe pourrait à son tour être parent) et aux cycles. */
  static ancestorGroup(name: string, lookup: ShellNavLookup): string | null {
    let cur = lookup[name];
    const seen = new Set<string>();
    while (cur && cur.parent && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      const parent = lookup[cur.parent];
      if (parent && parent.kind === "group") return cur.parent;
      cur = parent;
    }
    return null;
  }

  /** Une entrée `name` est-elle une VUE NAVIGABLE (enregistrée ET pas un groupe) ? Un groupe se déroule, il
      ne navigue jamais (piège ①) ; un nom inconnu n'est pas navigable non plus. */
  static isNavigable(name: string, lookup: ShellNavLookup): boolean {
    const d = lookup[name];
    return !!d && d.kind !== "group";
  }

  /** Résout un fragment d'URL (#nom, éventuellement encodé) en NOM DE VUE navigable, ou null. Utilisé au boot
      (deep-link) et sur `hashchange` : #contacts ouvre la sous-page (piège ⑤) ; #<groupe> est ignoré (piège ①). */
  static resolveHash(rawHash: string, lookup: ShellNavLookup): string | null {
    const v = decodeURIComponent((rawHash || "").replace(/^#/, ""));
    return v && ShellNav.isNavigable(v, lookup) ? v : null;
  }

  /** Structure APLATIE du menu déroulant responsive, dans l'ordre d'enregistrement (piège ②) :
        · une vue primaire  → un item (depth 0) ;
        · un groupe         → une entrée d'en-tête, puis un item indenté (depth 1) par ENFANT existant ;
        · une sous-vue de PRIMAIRE (kind:"secondary" hors groupe) → OMISE (atteinte par un lien d'en-tête).
      Le Shell mappe ensuite chaque item vers un bouton `.tabs-dd-item` (badge de comptage recollé par nom). */
  static responsiveMenu(views: ShellNavView[]): ResponsiveMenuEntry[] {
    const byName = new Map(views.map((v) => [v.name, v] as const));
    const out: ResponsiveMenuEntry[] = [];
    for (const v of views) {
      if (v.kind === "group") {
        out.push({ role: "group", name: v.name, label: v.label });
        for (const childName of v.children || []) {
          const child = byName.get(childName);
          if (child) out.push({ role: "item", name: child.name, label: child.label, depth: 1 });
        }
      } else if (v.kind !== "secondary") {
        out.push({ role: "item", name: v.name, label: v.label, depth: 0 });
      }
    }
    return out;
  }
}
