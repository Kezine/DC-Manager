/* =============================================================================
   CIBLES D'UN TICKET — clés composées « <famille>:<id> » (code PARTAGÉ front ⇄ back, TS pur).

   Le rattachement d'un ticket aux objets du modèle est MANUEL (arbitrage A4 du
   cadrage `.notes/toDos/remote-issue-tracker-jira-cadrage-2026-08-06.md`) : rien
   n'est dérivé d'une convention imposée aux utilisateurs du tracker (pas de label
   `dcm:*` à faire respecter côté Jira). Le champ `issues.targets` porte donc des
   clés SAISIES, de la forme « equipment:<id> » / « vm:<id> » / « spare:<id> » /
   « sub_equipment:<id> ».

   POURQUOI UN MODULE À PART (principe n°2 : une responsabilité = une classe = un
   fichier). Trois consommateurs — qui n'ont rien à voir entre eux — ont besoin de
   la MÊME règle de composition/décomposition, et ils la liraient sinon chacun à sa
   façon :
   - la VALIDATION (`DataValidation`, invariant de forme des `targets`) ;
   - la CASCADE (`Cascade`, les quatre `custom` qui retirent la clé d'un objet
     supprimé — la clé doit être RECOMPOSÉE à l'identique pour être retrouvée) ;
   - l'UI d'édition des liens (lot ultérieur), qui compose la clé au clic.
   Ce module n'appartient donc NI à la frontière de synchro (`IssueSync` — `targets`
   est un champ LOCAL, jamais écrasé par une passe), NI à la validation seule.

   ⚠ VOCABULAIRE VOLONTAIREMENT IDENTIQUE à celui des interventions
   (`INTERVENTION_TARGET_KINDS` côté serveur, `InterventionsFormat.TARGET_KIND_SLUGS`
   côté client) et à la composition de `src-client/core/TargetSearch.key` : un
   utilisateur qui lie « equipment:E1 » sur une intervention et sur un ticket écrit
   la MÊME chose, et l'éditeur de liens (SearchPop alimenté par `TargetSearch`) sert
   les deux sans conversion. C'est une CONVERGENCE de vocabulaire VÉRIFIÉE PAR TEST,
   PAS une dépendance de code : les deux modules restent AMOVIBLES indépendamment
   (décision D10 du cadrage — les faire s'importer casserait les deux amovibilités).

   Portée `src-shared/` : TS PUR (ni DOM ni Node), compilé des DEUX côtés — front
   (résolution *bundler*) et serveur (NodeNext). Ce fichier n'importe rien : c'est un
   CONSTAT, pas une contrainte (l'ISOLEMENT du dossier, lui, reste permanent — cf.
   `CLAUDE.md` § « Code partagé front/back »). Un import relatif vers un autre fichier
   partagé serait AUTORISÉ, à condition IMPÉRATIVE d'écrire le spécificateur avec
   l'extension `.js`.
   ============================================================================= */

/** Familles d'objets du modèle qu'un ticket peut cibler. Ensemble FERMÉ : une famille inconnue
    dans une clé rend la clé invalide (invariant de la spec `issues`), parce qu'une clé qu'aucune
    règle de cascade ne sait détacher deviendrait une référence pendante silencieuse. */
export const ISSUE_TARGET_KINDS = ["equipment", "vm", "spare", "sub_equipment"] as const;

/** Famille de cible (type littéral dérivé de la liste fermée ci-dessus). */
export type IssueTargetKind = (typeof ISSUE_TARGET_KINDS)[number];

/** Cible DÉCODÉE d'une clé composée. */
export interface IssueTargetRef { kind: string; id: string; }

export class IssueTargets {
  /** Séparateur de la clé composée — le même caractère que `TargetSearch.key` côté client. */
  static readonly SEPARATOR = ":";

  /** Les familles liables, sous forme de tableau de chaînes (vue « lisible par une boucle » de
      `ISSUE_TARGET_KINDS`, dont le type littéral sert, lui, au typage). */
  static readonly KINDS: readonly string[] = ISSUE_TARGET_KINDS;

  /** Famille → COLLECTION du document qui la porte. Table utilisée dans le SENS INVERSE par la
      cascade (une collection supprimée → la famille dont il faut retirer les clés) ; on la déclare
      dans ce sens-ci parce que c'est celui que lit un humain (« equipment, c'est equipments »). */
  static readonly COLLECTION_BY_KIND: Readonly<Record<string, string>> = {
    equipment: "equipments",
    vm: "vms",
    spare: "spares",
    sub_equipment: "subEquipments",
  };

  /** La famille est-elle connue ? (entrée non fiable : document importé, écriture API, saisie). */
  static isKind(kind: unknown): boolean {
    return typeof kind === "string" && IssueTargets.KINDS.includes(kind);
  }

  /** Compose la clé d'une cible. Inverse EXACT de `parse` — et réplique volontaire de
      `TargetSearch.key` (cf. l'en-tête : convergence de vocabulaire, pas d'import inter-modules). */
  static key(kind: string, id: string): string {
    return kind + IssueTargets.SEPARATOR + id;
  }

  /** Décode une clé « <famille>:<id> », ou `null` si la forme n'y est pas. Le séparateur est le
      PREMIER « : » : un id qui contiendrait lui-même des deux-points reste INTACT (l'inverse exact
      de `key`, exactement comme `TargetSearch.parse`). Aucune vérification de la famille ici —
      décoder et JUGER sont deux questions différentes (cf. `isValidKey`). */
  static parse(key: string): IssueTargetRef | null {
    // ⚠ Garde de TYPE et pas seulement de vérité : la valeur vient d'un document importé, d'une
    // écriture API ou d'un état persisté — un nombre y passerait la garde `key || ""` (il est
    // « truthy ») et ferait lever `indexOf is not a function`. Le décodeur ne doit JAMAIS jeter.
    const raw = typeof key === "string" ? key : "";
    const at = raw.indexOf(IssueTargets.SEPARATOR);
    if (at <= 0 || at === raw.length - 1) return null;   // pas de séparateur, famille vide, ou id vide
    return { kind: raw.slice(0, at), id: raw.slice(at + 1) };
  }

  /** La clé est-elle BIEN FORMÉE : famille connue + id non vide ? On valide la FORME, JAMAIS
      l'EXISTENCE de la cible — la cible peut être créée après le lien, et surtout la validation
      référentielle (V2) ne sait contrôler qu'un champ `ref` désignant UNE collection, ce qu'une clé
      polymorphe n'est pas. L'intégrité en SUPPRESSION, elle, est bien tenue : les quatre `custom` de
      `Cascade` retirent la clé quand l'objet disparaît (écart ASSUMÉ avec les interventions, qui
      TOLÈRENT les liens orphelins parce que leurs cibles vivent dans une AUTRE base). */
  static isValidKey(key: unknown): boolean {
    if (typeof key !== "string") return false;
    const ref = IssueTargets.parse(key);
    return !!ref && IssueTargets.isKind(ref.kind) && ref.id !== "";
  }
}
