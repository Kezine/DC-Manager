/* =============================================================================
   GROUPES D'ANNUAIRE — NETTOYAGE (helper du dossier `auth/`, classe pure).

   Sorti de `ForwardHeaderAuthProvider` le jour où le mode `oidc` lui a donné un
   SECOND consommateur — exactement le geste, et pour exactement la raison, qui
   avait sorti `SecretCompare` de `BasicAuthProvider` quand le mode forward est
   arrivé. Tant qu'une règle n'a qu'un porteur, elle vit chez lui ; au deuxième,
   elle sort, sinon elle DIVERGE (principe n°3).

   Et elle divergerait ici de façon coûteuse : les groupes deviennent des RÔLES
   via la table `groups` de `roles.json` (cf. `access/RolesConfig`), dont la
   correspondance est EXACTE et SENSIBLE À LA CASSE. Deux nettoyages légèrement
   différents — l'un qui rognerait, l'autre pas — donneraient à un même
   utilisateur des droits différents selon le mode d'authentification, sans que
   rien ne l'affiche. C'est la classe de bug qu'une source unique supprime.

   ── Les DEUX formes acceptées, et pourquoi ────────────────────────────────
   - CHAÎNE À VIRGULES : la seule forme possible dans un en-tête HTTP, donc
     celle du mode forward (`Remote-Groups: infra,admins`).
   - TABLEAU : la forme naturelle d'une revendication JWT (`"groups": ["infra"]`),
     donc celle du mode OIDC. Certains OP sérialisent tout de même une chaîne à
     virgules dans cette revendication — d'où la tolérance croisée, qui ne coûte
     qu'une branche et évite un mode « groupes silencieusement vides ».

   ⚠ AUCUN TRI. L'ordre de la source est conservé : la politique n'en dépend pas,
   et le cache de permissions trie de son côté (c'est même un invariant qu'il
   porte — cf. docs/auth.md § 5).
   ============================================================================= */

export class GroupList {
  /** Groupes NORMALISÉS d'une source d'annuaire : valeurs rognées, vides écartées, doublons fondus,
      ordre d'origine conservé.

      Rend TOUJOURS un tableau (éventuellement vide) : « ce provider fournit des groupes, et l'IdP
      n'en a donné aucun » n'est pas la même information qu'un champ absent, et c'est l'appelant qui
      décide de poser ou non `groups` sur la session.

      Les valeurs non textuelles d'un tableau (un OP qui pousserait des objets, ou `null`) sont
      IGNORÉES plutôt que converties : un `"[object Object]"` dans une liste de rôles serait un
      faux groupe, silencieux et impossible à diagnostiquer. */
  static normalize(raw: string[] | string | null | undefined): string[] {
    const parts: string[] = [];
    if (Array.isArray(raw)) {
      // Un tableau peut lui-même contenir des chaînes à virgules (OP hésitants) : on redécoupe.
      for (const item of raw) if (typeof item === "string") parts.push(...GroupList.split(item));
    } else if (typeof raw === "string") {
      parts.push(...GroupList.split(raw));
    }
    return [...new Set(parts)];
  }

  /** Découpe sur la VIRGULE, rogne, écarte les vides — une liste séparée par des virgules se lit
      partout pareil dans ce dépôt (mêmes règles que `FileRoleProvider.parseBootstrap`). */
  private static split(raw: string): string[] {
    return raw.split(",").map((group) => group.trim()).filter((group) => group !== "");
  }
}
