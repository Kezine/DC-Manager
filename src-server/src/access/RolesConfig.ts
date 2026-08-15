import { Permissions } from "../../../src-shared/Permissions.js";   // catalogue PARTAGÉ : contrôle de cohérence des grants custom

/* =============================================================================
   CONFIGURATION DE POLITIQUE (`roles.json`) — ANALYSE PURE.

   Extrait du provider fichier (principe n°2) : ici, AUCUN accès disque, aucune
   horloge, aucun `Logger` — juste « un JSON déjà lu → une politique
   exploitable + une liste d'avertissements ». C'est ce découpage qui rend
   testable la partie où se logent les vraies erreurs : la TOLÉRANCE (que
   fait-on d'une clé inconnue, d'une valeur qui n'est pas un tableau, d'un
   grant mal orthographié ?).

   ── Doctrine : TOLÉRANT en forme, STRICT en droit ─────────────────────────
   Un fichier de politique est écrit à la main par un exploitant. Une clé
   inconnue (`groups`, qui arrivera avec le mapping IdP) ne doit PAS invalider
   tout le fichier et verrouiller l'équipe dehors : elle est IGNORÉE et
   SIGNALÉE. En revanche rien n'est deviné : une entrée illisible n'accorde
   RIEN (jamais de repli « au plus large »), et un grant hors catalogue est
   signalé comme la COQUILLE qu'il est presque toujours — il ne matchera
   aucune vérification, l'exploitant croirait avoir donné un droit.

   ⚠ Il n'existe PAS de bucket `default` : l'opt-in est strict. Un utilisateur
   absent du fichier n'a aucun rôle, donc aucune permission.
   ============================================================================= */

/** Politique ANALYSÉE : deux tables + ce qu'il faut dire à l'exploitant. Les tables sont des `Map`
    (pas des objets nus) : on y cherche par clé venue du réseau, et un objet nu exposerait
    `constructor`/`__proto__` comme des « rôles » trouvés. */
export interface ParsedRolesConfig {
  /** id canonique OU login → noms de rôles. */
  users: Map<string, string[]>;
  /** nom de rôle CUSTOM → grants bruts. */
  roles: Map<string, string[]>;
  /** Anomalies TOLÉRÉES, à journaliser : le fichier reste exploitable, mais quelque chose y cloche. */
  warnings: string[];
}

/** Analyse et normalisation d'un document de politique (méthodes statiques — cf. CLAUDE.md). */
export class RolesConfig {
  /** Clés de premier niveau RECONNUES. Toute autre est ignorée + signalée (cf. l'en-tête) — c'est
      ce qui permettra d'ajouter `groups` plus tard sans invalider les fichiers d'aujourd'hui,
      ni les fichiers de demain sur une version d'aujourd'hui. */
  static readonly KNOWN_KEYS: readonly string[] = ["users", "roles"];

  /** Politique VIDE — l'état fail-closed : personne n'a de rôle. C'est ce que rend un premier
      chargement raté, et jamais autre chose. */
  static empty(): ParsedRolesConfig {
    return { users: new Map(), roles: new Map(), warnings: [] };
  }

  /** Analyse un document déjà désérialisé. Ne jette JAMAIS : tout ce qui ne se lit pas devient un
      avertissement, et la politique rendue est la plus RESTRICTIVE compatible avec ce qui se lit. */
  static parse(document: unknown): ParsedRolesConfig {
    const parsed = RolesConfig.empty();
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      parsed.warnings.push("racine invalide (objet JSON attendu) — politique VIDE appliquée");
      return parsed;
    }
    const root = document as Record<string, unknown>;
    for (const key of Object.keys(root)) {
      if (!RolesConfig.KNOWN_KEYS.includes(key)) parsed.warnings.push("clé inconnue ignorée : « " + key + " »");
    }
    RolesConfig.readTable(root.users, "users", parsed.users, parsed.warnings);
    RolesConfig.readTable(root.roles, "roles", parsed.roles, parsed.warnings);
    // Cohérence des rôles CUSTOM : un grant hors catalogue n'accorde rien du tout. Le dire, sinon
    // l'exploitant lira son fichier et croira le droit posé (le pire des silences).
    for (const [role, grants] of parsed.roles) {
      for (const grant of grants) {
        if (!Permissions.isWellFormedGrant(grant)) parsed.warnings.push('rôle « ' + role + ' » : grant MALFORMÉ ignoré « ' + grant + ' » (attendu `domaine:action`, jokers admis)');
        else if (!Permissions.isCatalogedGrant(grant)) parsed.warnings.push('rôle « ' + role + ' » : grant hors catalogue « ' + grant + ' » — il ne correspondra à AUCUNE vérification');
      }
      if (Permissions.ROLE_PRESETS[role]) parsed.warnings.push('rôle « ' + role + ' » : la définition locale MASQUE le preset du même nom (le fichier fait autorité)');
    }
    return parsed;
  }

  /** Lecture d'une table `{ clé: string[] }`. Une valeur qui n'est pas un tableau de chaînes est
      ignorée (avec son avertissement) plutôt que coercée : « accorder ce qu'on a cru comprendre »
      est exactement ce qu'un contrôle d'accès ne doit jamais faire. */
  private static readTable(raw: unknown, label: string, into: Map<string, string[]>, warnings: string[]): void {
    if (raw === undefined || raw === null) return;
    if (typeof raw !== "object" || Array.isArray(raw)) { warnings.push("section « " + label + " » ignorée : objet JSON attendu"); return; }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const name = String(key).trim();
      if (name === "") { warnings.push("section « " + label + " » : clé VIDE ignorée"); continue; }
      if (!Array.isArray(value)) { warnings.push("section « " + label + " » : « " + name + " » ignoré (tableau de chaînes attendu)"); continue; }
      const entries = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
      if (entries.length !== value.length) warnings.push("section « " + label + " » : « " + name + " » — entrées non textuelles ignorées");
      into.set(name, [...new Set(entries)]);
    }
  }

  /** Rôles d'une identité : union de ce qui est déclaré pour son id CANONIQUE **et** pour son
      LOGIN. Union et non « le premier trouvé » : les deux clés désignent la même personne, et un
      exploitant qui a écrit les deux graphies (parce qu'il ne savait pas laquelle serait retenue)
      doit obtenir la somme, pas une moitié arbitraire.
      ⚠ Correspondance EXACTE, sensible à la casse — c'est prévisible et testable ; une
      normalisation implicite ferait accorder un droit à une graphie que l'exploitant n'a pas écrite. */
  static rolesFor(config: ParsedRolesConfig, id: string, login: string): string[] {
    const roles = new Set<string>();
    for (const key of [id, login]) {
      if (!key) continue;
      for (const role of config.users.get(key) || []) roles.add(role);
    }
    return [...roles];
  }
}
