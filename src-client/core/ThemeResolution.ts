/* =============================================================================
   ThemeResolution — PRÉFÉRENCE de thème (clair / auto / sombre) → thème EFFECTIF.
   -----------------------------------------------------------------------------
   Module PUR : ni DOM, ni `matchMedia`, ni `Prefs`. L'appelant (`app/main.ts`) LIT
   l'état du système — `matchMedia("(prefers-color-scheme: dark)")` — et le passe
   ici en paramètre ; la DÉCISION, elle, se teste sans navigateur.

   POURQUOI DEUX TYPES. `ThemePreference` est ce que l'utilisateur CHOISIT (et qu'on
   persiste) ; `ThemeName` est ce qu'on APPLIQUE au document. Les confondre ferait
   écrire `data-theme="auto"` dans le DOM — un thème qui n'existe dans aucune feuille
   de style. C'est exactement la distinction que fait déjà `I18n` entre sa
   `preference` (« auto » compris) et sa locale effective, cf. docs/i18n.md.

   ⚠ Le DÉFAUT reste `dark` — l'absence d'attribut `data-theme` EST le thème sombre
   dans `dc-manager.css`. Passer le défaut à « auto » changerait le thème des
   nouveaux postes selon leur OS : c'est une décision de produit, pas un effet de
   bord de l'ajout du mode auto. Un utilisateur qui veut suivre son système le
   choisit explicitement (et sa préférence est alors persistée comme les autres).
   ============================================================================= */

/** Thème EFFECTIVEMENT appliqué au document (`data-theme`). */
export type ThemeName = "dark" | "light";
/** Ce que l'utilisateur CHOISIT dans les réglages — « auto » suit le système. */
export type ThemePreference = ThemeName | "auto";

export class ThemeResolution {
  /** Préférence par défaut (aucun réglage persisté) — cf. l'avertissement de l'en-tête. */
  static readonly DEFAULT: ThemePreference = "dark";

  /** Les trois choix, DANS L'ORDRE DU TOGGLE (clair ← auto → sombre). Cet ordre est la source
      unique : le contrôle à trois positions le lit, il ne le redéclare pas. La position du milieu
      est « auto » — c'est la demande, et c'est aussi le seul placement qui garde le glissement
      clair → sombre monotone de gauche à droite. */
  static readonly OPTIONS: readonly ThemePreference[] = ["light", "auto", "dark"];

  /** Une valeur STOCKÉE (ou reçue) est-elle une préférence valable ? Renvoie `null` sinon — l'appelant
      garde alors sa valeur courante plutôt que d'écraser un réglage par un défaut arbitraire.
      Accepte « auto » DEPUIS l'ajout du mode : les préférences écrites par les versions antérieures ne
      contiennent que `light`/`dark` et restent lues telles quelles (aucune migration à écrire). */
  static normalize(raw: unknown): ThemePreference | null {
    return (raw === "light" || raw === "dark" || raw === "auto") ? raw : null;
  }

  /** Thème à APPLIQUER. `systemDark` = ce que le système répond à `prefers-color-scheme: dark`.
      Un choix EXPLICITE l'emporte toujours sur le système : « auto » est le seul cas où l'on regarde
      `systemDark` — sans quoi une bascule nuit de l'OS écraserait un thème choisi à la main. */
  static effective(pref: ThemePreference, systemDark: boolean): ThemeName {
    if (pref === "light" || pref === "dark") return pref;
    return systemDark ? "dark" : "light";
  }

  /** Préférence à poser pour BASCULER depuis l'affichage courant (action « Basculer le thème » de la
      palette). Depuis « auto », on ÉPINGLE l'inverse de ce qui est affiché : l'utilisateur demande un
      changement visible, pas un aller-retour vers la valeur que le système impose déjà. */
  static toggled(pref: ThemePreference, systemDark: boolean): ThemePreference {
    return ThemeResolution.effective(pref, systemDark) === "light" ? "dark" : "light";
  }
}
