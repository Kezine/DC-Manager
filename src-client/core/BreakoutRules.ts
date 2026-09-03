/* =============================================================================
   BreakoutRules — « ce port peut-il être ÉCLATÉ en lanes, ce breakout peut-il
   être DÉFAIT, comment se nomment les lanes, et dans quel ordre se lisent
   trunk et lanes ? »

   Classe PURE : aucun DOM, aucun store, aucun modèle (patron
   `core/PortCompatibility`). Elle reçoit une DESCRIPTION minimale de la
   situation et rend un VERDICT en codes — jamais une phrase : la traduction se
   fait AU RENDU (`views/forms/EquipmentForms`). Un module pur qui produirait du
   français serait intraduisible et intestable. Documentation d'architecture :
   docs/breakout.md.

   ---------------------------------------------------------------------------
   POURQUOI CE MODULE (retour terrain T2, cadrage du 2026-09-03). Le MODÈLE du
   breakout est complet depuis longtemps — `Port.parent_port_id` + `Port.lane`,
   cascade déclarative, règle T2 « lane et trunk au même équipement » — mais il
   n'existait qu'UN geste : créer un trunk NEUF avec ses lanes. Ce qui manquait :
     • ÉCLATER un port EXISTANT — déjà saisi, déjà posé sur la façade — qui
       DEVIENT trunk sans changer d'identité (clause C5 du contrat breakout ⇄
       terminaison : mêmes id, nom, type, position de façade) ;
     • DÉFAIRE un breakout — le trunk REDEVIENT un port ordinaire, les lanes
       disparaissent (arbitrage Q2.4 : rétrogradage, pas cascade).
   Les deux gestes ont des REFUS, et ces refus doivent être NOMMÉS au moment du
   geste (item de menu grisé + raison en infobulle), jamais découverts à
   l'enregistrement. Ce module est l'endroit UNIQUE où ils se décident : le
   formulaire ne fait que les traduire et les appliquer.

   ---------------------------------------------------------------------------
   LES RÈGLES (arbitrages du 2026-09-03 — à relire dans docs/breakout.md, pas
   à rouvrir ici) :
     • éclater n'est offert qu'à un port de DONNÉES (kind `data` — le PoE en
       est, un port d'ÉNERGIE n'a pas de lanes), qui n'est NI une lane NI déjà
       un trunk : pas de breakout IMBRIQUÉ par l'UI. Le modèle et la cascade le
       supportent (une sous-lane est emportée par récursion), l'UI v1 ne
       l'offre pas — personne n'a ce montage sur le terrain ;
     • éclater un port qui PORTE UN CÂBLE est REFUSÉ : le trunk éclaté est
       incâblable par doctrine (clause C4 — ce sont les lanes qui portent les
       câbles), un câble resté sur lui serait un orphelin de doctrine. Le
       symétrique exact du refus de « défaire » ;
     • DÉFAIRE est refusé si UNE lane porte un câble : supprimer la lane
       supprimerait le câble en cascade, silencieusement. Le verdict NOMME les
       lanes en cause pour que l'utilisateur sache QUOI décâbler.

   ORDRE DES VERDICTS de `canSplit` — du plus STRUCTUREL au plus CIRCONSTANCIEL.
   « C'est une lane » ou « c'est déjà un trunk » sont des propriétés de l'objet ;
   « pas un port de données » tient à son rôle ; « câblé » à son état du moment.
   Une lane câblée est d'abord une lane : le message doit dire ce qui ne
   changera pas, avant ce qui pourrait changer.

   ⚠ CE MODULE NE LIT PAS LE STORE. « Porte-t-il un câble ? » est une question
   d'ÉTAT que l'appelant pose au Store (`Store.cableOnPort`) et transmet en
   booléen. Conséquence VOULUE : un port BROUILLON jamais enregistré n'a pas de
   câble, et l'appelant n'a rien de spécial à faire pour le savoir.
   ============================================================================= */

/** Verdict d'ÉCLATEMENT d'un port. Codes — la traduction se fait au rendu. */
export type BreakoutSplitVerdict =
  /** Le port peut être éclaté. */
  | "ok"
  /** Le port n'est pas un port de DONNÉES (énergie) : un breakout n'a pas de sens. */
  | "not-data"
  /** Le port est déjà une LANE d'un breakout : pas de breakout imbriqué par l'UI. */
  | "is-lane"
  /** Le port est déjà un TRUNK éclaté. */
  | "is-trunk"
  /** Le port porte un câble : un trunk est incâblable, il faut décâbler d'abord. */
  | "cabled";

/** Description MINIMALE d'un port candidat à l'éclatement — le strict nécessaire au verdict.
    Interface étroite VOLONTAIRE : elle documente la dépendance exacte au modèle (le rôle via son
    `kind`, la structure via deux booléens, l'état via un troisième) et permet de tester sans
    construire un `Port`. */
export interface BreakoutSplitInput {
  /** Genre du rôle du port (`PortRoles.kind`) ; `null` = inconnu — on ne déduit rien d'une absence. */
  kind: "data" | "power" | null;
  /** Le port est une lane (il a un `parent_port_id`). */
  isLane: boolean;
  /** Le port est un trunk (au moins une lane le désigne comme parent). */
  isTrunk: boolean;
  /** Le port porte un câble (`Store.cableOnPort`). */
  hasCable: boolean;
}

/** Une lane telle que la NOMME un refus : de quoi la désigner à l'utilisateur, rien de plus. */
export interface BreakoutLaneRef {
  id: string;
  name: string;
}

/** Une lane telle que l'appelant la DÉCRIT pour juger un « défaire » : sa référence + son état. */
export interface BreakoutLaneState extends BreakoutLaneRef {
  hasCable: boolean;
}

/** Verdict de DÉFAIRE : accepté, ou refusé EN NOMMANT les lanes câblées (jamais un simple `false` —
    l'utilisateur doit savoir quoi décâbler). */
export type BreakoutUnsplitVerdict =
  | { ok: true }
  | { ok: false; cabledLanes: BreakoutLaneRef[] };

/** Forme MINIMALE d'un port pour la structure trunk → lanes : identité + rattachement + n° de lane.
    Satisfaite par `Port`, par le brouillon `PortDraft` du formulaire et par un simple objet de test. */
export interface BreakoutPortShape {
  id: string;
  parent_port_id?: string | null;
  lane?: number | null;
}

/** Un port RACINE et ses lanes (vides pour un port ordinaire). */
export interface BreakoutGroup<T extends BreakoutPortShape> {
  port: T;
  lanes: T[];
}

export class BreakoutRules {
  /** Séparateur du schéma de nommage des lanes : « QSFP1/1 », « QSFP1/2 », … Exposé pour que le
      test le verrouille par son nom plutôt que par un littéral recopié. */
  static readonly LANE_SEPARATOR = "/";

  /** LE verdict d'éclatement — cf. l'ordre des vérifications en tête de fichier. */
  static canSplit(input: BreakoutSplitInput): BreakoutSplitVerdict {
    if (input.isLane) return "is-lane";
    if (input.isTrunk) return "is-trunk";
    if (input.kind !== "data") return "not-data";
    if (input.hasCable) return "cabled";
    return "ok";
  }

  /** LE verdict de défaire : refusé dès qu'UNE lane porte un câble, et le refus les NOMME toutes
      (dans l'ordre reçu — l'appelant passe les lanes triées par n°). Aucune lane ⇒ accepté : il
      n'y a rien à perdre. */
  static canUnsplit(lanes: readonly BreakoutLaneState[]): BreakoutUnsplitVerdict {
    const cabledLanes = lanes.filter((lane) => lane.hasCable).map((lane) => ({ id: lane.id, name: lane.name }));
    return cabledLanes.length ? { ok: false, cabledLanes } : { ok: true };
  }

  /** Noms des lanes d'un trunk : `<trunk>/1` … `<trunk>/N`. SEULE source du schéma de nommage — les
      deux chemins de création (trunk neuf, port éclaté) l'appellent. Nom de trunk trimé ; un compte
      non entier est plancher-isé, négatif ou non fini ⇒ aucune lane. Un nom VIDE produit « /1 »… :
      c'est à l'appelant d'exiger un nom AVANT (le dialogue le fait), ce module ne l'invente pas. */
  static laneNames(trunkName: string, count: number): string[] {
    const base = (trunkName || "").trim();
    const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const names: string[] = [];
    for (let index = 1; index <= total; index++) names.push(base + BreakoutRules.LANE_SEPARATOR + index);
    return names;
  }

  /** STRUCTURE trunk → lanes d'une liste de ports : chaque port RACINE (sans parent) dans l'ordre
      d'entrée, avec ses lanes TRIÉES par n° de lane (l'ordre de saisie des lanes ne compte pas). Une
      lane ORPHELINE — dont le parent n'est pas dans la liste (legacy hors règle T2, ou trunk d'un
      autre équipement) — est rendue comme une racine en FIN de liste : jamais perdue, jamais cachée.
      Consommée par le formulaire (un groupe par trunk) et, aplatie, par la fiche (`orderWithLanes`). */
  static groupByTrunk<T extends BreakoutPortShape>(ports: readonly T[]): BreakoutGroup<T>[] {
    const byParent = new Map<string, T[]>();
    const ids = new Set<string>();
    ports.forEach((port) => ids.add(port.id));
    ports.forEach((port) => {
      if (!port.parent_port_id || !ids.has(port.parent_port_id)) return;
      const siblings = byParent.get(port.parent_port_id);
      if (siblings) siblings.push(port); else byParent.set(port.parent_port_id, [port]);
    });
    const groups: BreakoutGroup<T>[] = [];
    const orphans: BreakoutGroup<T>[] = [];
    ports.forEach((port) => {
      if (port.parent_port_id && ids.has(port.parent_port_id)) return;   // rendue sous son trunk
      const lanes = (byParent.get(port.id) || []).slice().sort((a, b) => (a.lane || 0) - (b.lane || 0));
      (port.parent_port_id ? orphans : groups).push({ port, lanes });
    });
    return groups.concat(orphans);
  }

  /** Ordre APLATI « trunk, puis ses lanes » — pour un tableau qui liste tous les ports (fiche). */
  static orderWithLanes<T extends BreakoutPortShape>(ports: readonly T[]): T[] {
    const ordered: T[] = [];
    BreakoutRules.groupByTrunk(ports).forEach((group) => { ordered.push(group.port); group.lanes.forEach((lane) => ordered.push(lane)); });
    return ordered;
  }
}
