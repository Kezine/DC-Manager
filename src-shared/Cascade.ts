/* ============================================================================
   CASCADE DE SUPPRESSION — code PARTAGÉ front ⇄ back (intégrité référentielle en SUPPRESSION).

   Quand une entité est supprimée, certaines entités liées doivent l'être aussi (delete) et
   d'autres voir leur FK nettoyée (detach). Sans ça, supprimer naïvement (ex. `DELETE /racks/x`)
   laisserait des FK pendantes. Cette logique vit ICI pour être appliquée des DEUX côtés :
     - mode FICHIER : le `Store` l'applique avant d'écrire (cf. Store.remove) ;
     - mode API : le serveur l'applique sur `DELETE` (le serveur devient autorité).

   Le plan est RÉCURSIF (cf. docs/placement.md §6.16) : la règle d'une entité marquée pour
   suppression est REJOUÉE sur elle, jusqu'au point fixe. Une chaîne (équipement → ports → lanes
   de breakout → câbles) se propage donc jusqu'au bout SANS que chaque maillon ait à réécrire à la
   main la transitivité du maillon suivant. Trois garanties portées par le moteur, donc valables
   pour TOUTE règle présente ou future :
     - ANTI-CYCLE / DÉDUPLICATION : un couple (collection, id) n'est traité qu'UNE fois — les cibles
       elles-mêmes sont marquées d'entrée, donc un cycle de références (ports.parent_port_id) termine
       et ne peut pas se ré-supprimer ;
     - un DÉTACHEMENT visant une entité que le plan SUPPRIME est ÉCARTÉ : inutile en mode fichier,
       DANGEREUX en mode API (`Repository.transact` applique les deletes PUIS les updates → un
       update sur une ligne supprimée la RESSUSCITE par upsert ; c'est déjà la garde d'ApiRules) ;
     - les détachements sont RÉDUITS à un par (collection, id, clé) — la DERNIÈRE valeur gagne,
       exactement comme les deux exécuteurs qui les appliquent en séquence.

   Le moteur est MULTI-RACINES (`planMany`, cf. docs/placement.md §6.17) : un LOT de suppressions se
   calcule en UN SEUL plan, pas un plan par entité. C'est une exigence de CORRECTION, pas une
   optimisation : les garanties ci-dessus sont portées par des accumulateurs (`seen`, les détachements
   planifiés) qui ne valent QUE dans la portée d'un appel. Deux appels séparés ne composent pas — deux
   waypoints d'une même route, supprimés dans le même lot, produiraient deux valeurs ABSOLUES de
   `waypoint_ids` calculées chacune sur la route d'ORIGINE, et la dernière écraserait la première (un
   seul des deux retiré). `plan()` n'est plus qu'une enveloppe à une racine.

   Capacités INJECTÉES (mêmes que la validation V5b/V6) :
     - `find(collection, field, value)` → enregistrements dont `field` vaut `value` (index/where) ;
     - `fetch(collection, id)` → un enregistrement (pour lire un champ, ex. le nom).
   Ce fichier n'importe rien (aucune dépendance) — l'auto-suffisance de `src-shared/` n'est plus
   une contrainte de build (cf. CLAUDE.md « Code partagé »), c'est ici un simple constat.

   AJOUTER UNE RELATION = AJOUTER UNE ENTRÉE dans `SPEC` (déclaratif), ou un `custom` pour les
   cas non réductibles à une FK simple (multi-réseaux, câbles branchés par DEUX champs, routes de
   waypoints). ⚠ Un `custom` ne doit PLUS servir à rattraper la transitivité d'une règle voisine :
   c'est le travail du moteur.
   ============================================================================ */

/** Capacité de recherche par champ (= `RecordFinder` de la validation). */
type Find = (collection: string, field: string, value: string) => Array<Record<string, any>>;
/** Capacité de lecture d'une entité (= `EntityFetcher` de la validation). */
type Fetch = (collection: string, id: string) => Record<string, any> | null;

/** Entité à SUPPRIMER (effet de cascade). */
export interface CascadeDelete { c: string; id: string; }
/** Entité dont l'appelant DEMANDE la suppression (racine d'un plan). Champ `collection` en toutes lettres —
    même vocabulaire que `plan(collection, id, …)` et que les lots `/transact` du serveur, dont la liste de
    suppressions se passe telle quelle à `planMany`. La forme terse `{ c, id }` reste réservée aux EFFETS. */
export interface CascadeTarget { collection: string; id: string; }
/** Champ à NETTOYER sur une entité conservée (FK détachée). */
export interface CascadeDetach { c: string; id: string; key: string; value: any; }
/** Plan complet d'une suppression : suppressions enfants + détachements de FK. */
export interface CascadePlan { deletes: CascadeDelete[]; detaches: CascadeDetach[]; }

interface CascadeRule {
  delete?: { coll: string; fk: string }[];
  detach?: { coll: string; fk: string; set?: Record<string, any> }[];
  custom?: (find: Find, fetch: Fetch, id: string, deletes: CascadeDelete[], detaches: CascadeDetach[]) => void;
}

export class Cascade {
  /** Séparateur de clé composite (collection + id [+ champ]) : caractère de contrôle ASCII écrit en
      SÉQUENCE D'ÉCHAPPEMENT — un séparateur exotique tapé en clair est ressorti en NUL brut dans du JS
      compilé par le passé (cf. `FloorLayout`), piège que cette forme évite. */
  private static readonly KEY_SEP = "\u001f";
  private static key(collection: string, id: string): string { return collection + Cascade.KEY_SEP + id; }

  /** Câbles branchés sur un port (extrémité `from` OU `to`), dédupliqués. */
  private static cablesOnPort(find: Find, portId: string): Array<Record<string, any>> {
    const seen = new Set<string>(); const out: Array<Record<string, any>> = [];
    for (const c of [...find("cables", "from_port_id", portId), ...find("cables", "to_port_id", portId)]) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    return out;
  }
  /** Câbles portant un réseau (principal OU dans `network_ids`), dédupliqués. */
  private static cablesOnNetwork(find: Find, networkId: string): Array<Record<string, any>> {
    const seen = new Set<string>(); const out: Array<Record<string, any>> = [];
    for (const c of [...find("cables", "network_id", networkId), ...find("cables", "network_ids", networkId)]) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    return out;
  }
  /** Enregistrements d'une COLLECTION portant un groupe (primaire `group_id` OU dans `group_ids`), dédupliqués.
      PARAMÉTRÉ par la collection : equipments ET vms portent le MÊME modèle multi-groupes (parité voulue, cf. Vm.ts).
      Cherche les DEUX champs pour couvrir aussi les enregistrements LEGACY (mode API : `group_id` seul,
      `group_ids` pas encore réécrit). */
  private static groupMembers(find: Find, collection: string, groupId: string): Array<Record<string, any>> {
    const seen = new Set<string>(); const out: Array<Record<string, any>> = [];
    for (const e of [...find(collection, "group_id", groupId), ...find(collection, "group_ids", groupId)]) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
    return out;
  }

  /** Valeur COURANTE d'un champ en cours de détachement : la dernière valeur déjà PLANIFIÉE pour
      (collection, id, clé), sinon `fallback` (la valeur de l'enregistrement).
      INDISPENSABLE dès qu'un détachement RETIRE un élément d'une LISTE : la même liste peut être amputée
      plusieurs fois dans un seul plan, pour DEUX raisons cumulables — la RÉCURSION (supprimer une baie
      supprime ses N brosses, donc rejoue N fois la règle `waypoints` sur la MÊME route) et le LOT
      (`planMany` : deux waypoints, deux groupes ou deux réseaux supprimés ensemble touchent le même
      porteur). Chaque valeur étant ABSOLUE et le dernier écrit gagnant chez les deux exécuteurs, calculer
      chaque retrait sur l'enregistrement ORIGINAL ne retirerait qu'UN seul élément — les autres
      réapparaîtraient, en référence à une entité pourtant supprimée. On compose donc sur le planifié. */
  private static pendingValue(detaches: CascadeDetach[], collection: string, id: string, key: string, fallback: any): any {
    for (let i = detaches.length - 1; i >= 0; i--) {
      const d = detaches[i];
      if (d.key === key && d.id === id && d.c === collection) return d.value;
    }
    return fallback;
  }

  /** DÉTACHE un groupe supprimé de tous ses porteurs dans UNE collection : retire l'id de `group_ids` et repointe
      le PRIMAIRE sur le premier groupe restant (ou null), sinon inchangé — même sémantique que le détachement
      multi-réseaux (networks/network_ids). Mutualisé equipments/vms (principe n°3) : dupliquer le bloc aurait
      laissé les deux copies diverger au premier ajustement.
      ⚠ COMPOSE sur le déjà planifié (`pendingValue`), liste ET primaire : aucune règle ne SUPPRIME de `groups`,
      mais un LOT `/transact` peut en supprimer PLUSIEURS, et `planMany` les développe dans le MÊME plan. Sans
      composition, deux groupes d'un même équipement retirés ensemble n'en retireraient qu'UN (dernier écrit
      gagnant) — l'autre resterait dans `group_ids`, en référence à un groupe supprimé. */
  private static detachGroupFromMembers(find: Find, collection: string, groupId: string, detaches: CascadeDetach[]): void {
    Cascade.groupMembers(find, collection, groupId).forEach((e) => {
      const declared = Array.isArray(e.group_ids) ? e.group_ids : (e.group_id ? [e.group_id] : []);
      const ids = Cascade.pendingValue(detaches, collection, e.id, "group_ids", declared);
      const gids = ids.filter((x: string) => x !== groupId);
      detaches.push({ c: collection, id: e.id, key: "group_ids", value: gids });
      // primaire supprimé → repointe sur le premier groupe restant (ou aucun), sinon inchangé.
      const primary = Cascade.pendingValue(detaches, collection, e.id, "group_id", e.group_id || null);
      const prim = (primary === groupId) ? (gids.length ? gids[0] : null) : (primary || null);
      detaches.push({ c: collection, id: e.id, key: "group_id", value: prim });
    });
  }

  /** Retire un ENSEMBLE de waypoints des ROUTES (`waypoint_ids`) des câbles ET faisceaux qui les référencent.
      UN SEUL détachement par câble/faisceau touché, retirant TOUS les ids d'un coup : plusieurs détachements
      sur le même `waypoint_ids` s'ÉCRASERAIENT (Store comme serveur fusionnent par clé — le dernier gagne)
      s'ils étaient chacun calculés sur la route ORIGINALE. On déduplique donc par câble, ET on compose sur la
      valeur DÉJÀ PLANIFIÉE (`pendingValue`) : sous cascade récursive, cette règle est rejouée une fois par
      brosse d'une même baie, sur les mêmes routes. */
  private static pruneWaypointsFromRoutes(find: Find, ids: Set<string>, detaches: CascadeDetach[]): void {
    const cables = new Map<string, Record<string, any>>();
    const bundles = new Map<string, Record<string, any>>();
    for (const id of ids) {
      for (const c of find("cables", "waypoint_ids", id)) cables.set(c.id, c);
      for (const b of find("cableBundles", "waypoint_ids", id)) bundles.set(b.id, b);
    }
    const prune = (coll: string, rec: Record<string, any>) => {
      const current = Cascade.pendingValue(detaches, coll, rec.id, "waypoint_ids", rec.waypoint_ids || []);
      detaches.push({ c: coll, id: rec.id, key: "waypoint_ids", value: (current || []).filter((x: string) => !ids.has(x)) });
    };
    for (const c of cables.values()) prune("cables", c);
    for (const b of bundles.values()) prune("cableBundles", b);
  }

  /** Règles de cascade par collection supprimée. */
  private static readonly SPEC: Record<string, CascadeRule> = {
    equipments: {
      delete: [{ coll: "ports", fk: "equipment_id" }, { coll: "aggregates", fk: "equipment_id" }],
      // détache aussi les 2 extrémités de faisceau qui pointaient cet équipement (patch supprimé → trunk demi-terminé).
      // détache aussi les VMs HÉBERGÉES par cet équipement (host_equipment_id → null) : le lien est LÉGER (la VM
      // survit, juste « sans hôte connu »), jamais une suppression.
      detach: [{ coll: "ipAddresses", fk: "equipment_id" }, { coll: "dhcpRanges", fk: "server_id" }, { coll: "ipNetworks", fk: "dhcp_server_id" },
        { coll: "cableBundles", fk: "endpoint_a_equipment_id" }, { coll: "cableBundles", fk: "endpoint_b_equipment_id" },
        { coll: "vms", fk: "host_equipment_id" }],
      // Les CÂBLES branchés sur les ports de l'équipement ne sont PLUS listés ici : la suppression des ports
      // (règle `delete` ci-dessus) rejoue la règle `ports`, qui les emporte — y compris ceux des lanes.
      custom: (find, fetch, id, _deletes, detaches) => {
        const eq = fetch("equipments", id);
        const name = (eq && eq.name) ? eq.name : "(équipement supprimé)";   // spares : on préserve l'attribution en texte libre
        find("spares", "assigned_equipment_id", id).forEach((sp) => {
          detaches.push({ c: "spares", id: sp.id, key: "assigned_free", value: sp.assigned_free || name });
          detaches.push({ c: "spares", id: sp.id, key: "assigned_equipment_id", value: null });
        });
      },
    },
    ports: {
      // Lanes de BREAKOUT : une FK simple, donc déclarative. Leurs propres câbles (et un éventuel breakout
      // imbriqué) suivent par récursion — c'est cette règle-ci, rejouée sur chaque lane.
      delete: [{ coll: "ports", fk: "parent_port_id" }],
      // Câbles branchés : NON réductible à une FK simple (deux champs d'extrémité, à dédupliquer).
      custom: (find, _fetch, id, deletes) => {
        Cascade.cablesOnPort(find, id).forEach((c) => deletes.push({ c: "cables", id: c.id }));
      },
    },
    aggregates: { detach: [{ coll: "ports", fk: "aggregate_id" }] },
    networks: {
      // multi-réseaux : retire l'id de network_ids et repointe le principal. S'applique aux CÂBLES (legacy, champs
      // dormants) ET aux PORTS terminaux (source unique actuelle du réseau) — même logique de détachement.
      // ⚠ COMPOSE sur le déjà planifié, pour la même raison que `detachGroupFromMembers` : un LOT peut supprimer
      // PLUSIEURS réseaux portés par le MÊME câble/port, et `planMany` les développe dans le même plan.
      custom: (find, _fetch, id, _deletes, detaches) => {
        const detachFrom = (coll: string, rows: any[]) => rows.forEach((r) => {
          const declared = Array.isArray(r.network_ids) ? r.network_ids : (r.network_id ? [r.network_id] : []);
          const ids = Cascade.pendingValue(detaches, coll, r.id, "network_ids", declared);
          if (!ids.includes(id)) return;
          const nids = ids.filter((x: string) => x !== id);
          detaches.push({ c: coll, id: r.id, key: "network_ids", value: nids });
          const primary = Cascade.pendingValue(detaches, coll, r.id, "network_id", r.network_id);
          const prim = (primary === id) ? (nids.length ? nids[0] : null) : primary;
          detaches.push({ c: coll, id: r.id, key: "network_id", value: prim });
        });
        detachFrom("cables", Cascade.cablesOnNetwork(find, id));
        // ports : union network_ids ∪ network_id (dédup par id).
        const seen = new Set<string>();
        const ports = [...find("ports", "network_ids", id), ...find("ports", "network_id", id)].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
        detachFrom("ports", ports);
      },
    },
    groups: {
      // multi-groupes : retire l'id de `group_ids` et repointe le groupe PRIMAIRE (modèle networks/network_ids),
      // sur les ÉQUIPEMENTS **ET** les VMS (même modèle de groupes — sans le second balayage, supprimer un
      // groupe laisserait des ids fantômes dans vms.group_ids/group_id).
      custom: (find, _fetch, id, _deletes, detaches) => {
        Cascade.detachGroupFromMembers(find, "equipments", id, detaches);
        Cascade.detachGroupFromMembers(find, "vms", id, detaches);
      },
    },
    racks: {
      // Les BROSSES (waypoints kind:"brush") sont MONTÉES dans la baie (`rack_id` obligatoire — invariant T1
      // « une brosse doit être montée dans une baie »). Supprimer la baie DOIT donc les supprimer AUSSI : sinon
      // `rack_id` pend (V2 ref_missing) et l'invariant interdit de simplement le nullifier → document invalide.
      // Les DEUX suppressions sont des FK simples ; ce qu'elles entraînent (équipements posés sur les étagères
      // détachés, routes de câbles/faisceaux nettoyées des brosses) est produit par la RÉCURSION sur les règles
      // `rackItems` et `waypoints` — plus rien à rattraper à la main ici.
      delete: [{ coll: "rackItems", fk: "rack_id" }, { coll: "waypoints", fk: "rack_id" }],
      detach: [{ coll: "equipments", fk: "rack_id", set: { rack_id: null, placement_mode: "manual" } }],
    },
    // Supprimer une ÉTAGÈRE (ou tout pseudo-élément) DÉTACHE les équipements posés dessus — on ne les
    // supprime jamais : ils redeviennent « non placés » (parité avec le détachement rack_id ci-dessus).
    rackItems: {
      custom: (find, _fetch, id, _deletes, detaches) => Cascade.detachTrayGuests(find, id, detaches),
    },
    portTypes: { detach: [{ coll: "ports", fk: "port_type_id" }] },
    cableTypes: { detach: [{ coll: "cables", fk: "cable_type_id" }, { coll: "cableBundles", fk: "cable_type_id" }] },
    // Supprimer un faisceau : détache les affectations de brins portées par les ports de patch
    // (bundle_id/strand_a/strand_b remis à zéro → ports redeviennent de simples ports).
    cableBundles: {
      detach: [
        { coll: "ports", fk: "bundle_id", set: { bundle_id: null, strand_a: null, strand_b: null } },
      ],
    },
    datacenters: {
      detach: [
        { coll: "racks", fk: "datacenter_id", set: { datacenter_id: null, dc_x: null, dc_y: null } },
        { coll: "equipments", fk: "dc_id", set: { dc_id: null, dc_x: null, dc_y: null, dc_z: 0 } },
        { coll: "waypoints", fk: "datacenter_id", set: { datacenter_id: null, dc_x: null, dc_y: null, dc_x2: null, dc_y2: null } },
      ],
    },
    ipNetworks: {
      delete: [{ coll: "ipAddresses", fk: "network_id" }, { coll: "dhcpRanges", fk: "network_id" }],
      detach: [{ coll: "networks", fk: "ip_network_id" }],
    },
    waypoints: {
      // retire l'id des routes (waypoint_ids) des câbles ET faisceaux (helper partagé avec la cascade `racks`,
      // qui l'atteint désormais par RÉCURSION — une fois par brosse de la baie).
      custom: (find, _fetch, id, _deletes, detaches) => Cascade.pruneWaypointsFromRoutes(find, new Set([id]), detaches),
    },
    // VM (collection AMOVIBLE) : supprimer une VM DÉTACHE ses adresses IP rattachées (vm_id → null), sans les
    // supprimer — le lien IPAM est LÉGER (parité stricte avec equipments.detach ipAddresses/equipment_id : l'adresse
    // survit, juste « non attribuée »), jamais une suppression. Reste sans `delete` (rien à supprimer en cascade).
    vms: { delete: [], detach: [{ coll: "ipAddresses", fk: "vm_id" }] },
  };

  /** DÉTACHE les équipements POSÉS sur l'étagère `trayId` (placement_mode "tray") : retour « non placé »
      (tray_item_id/tray_x/tray_y nettoyés). Atteint pour une suppression DIRECTE d'un rackItem comme,
      par RÉCURSION, pour la suppression de sa baie (qui supprime ses rackItems). */
  private static detachTrayGuests(find: Find, trayId: string, detaches: CascadeDetach[]): void {
    find("equipments", "tray_item_id", trayId).forEach((e) => {
      detaches.push({ c: "equipments", id: e.id, key: "tray_item_id", value: null });
      detaches.push({ c: "equipments", id: e.id, key: "tray_x", value: null });
      detaches.push({ c: "equipments", id: e.id, key: "tray_y", value: null });
      detaches.push({ c: "equipments", id: e.id, key: "placement_mode", value: "manual" });
    });
  }

  /** Calcule le plan de cascade pour supprimer `id` de `collection`. Enveloppe à UNE racine de `planMany` :
      c'est là que vivent la récursion, les garanties et leur commentaire. Signature et résultat INCHANGÉS —
      ses appelants (mode fichier `Store.remove`, mode API `Api.remove`) suppriment une seule entité. */
  static plan(collection: string, id: string, find: Find, fetch: Fetch): CascadePlan {
    return Cascade.planMany([{ collection, id }], find, fetch);
  }

  /** Calcule EN UN SEUL PLAN la cascade d'un LOT de suppressions (`/transact`). PUR : toutes les résolutions
      inverses passent par `find`/`fetch`. Les cibles sont supposées bien formées (l'appelant les filtre).

      RÉCURSIF jusqu'au POINT FIXE : la règle de chaque entité marquée pour suppression est rejouée sur elle.
      Terminaison GARANTIE sans garde de profondeur arbitraire — l'ensemble `seen` n'accepte chaque couple
      (collection, id) qu'une fois, donc la file est bornée par le nombre d'entités du document, et un cycle de
      références (`ports.parent_port_id`) est coupé au deuxième passage. TOUTES les cibles y sont inscrites
      d'entrée : aucune ne peut réapparaître dans `deletes` (l'appelant les supprime lui-même) ni être
      « détachée » par la cascade d'une AUTRE cible du lot — la garde anti-résurrection vaut donc à l'échelle
      du LOT, et non plus seulement de la racine courante.

      UN SEUL accumulateur de détachements pour tout le lot : c'est ce qui fait composer `pendingValue` D'UNE
      CIBLE À L'AUTRE. Sans lui, deux waypoints d'une même route supprimés dans le même lot produiraient deux
      valeurs ABSOLUES de `waypoint_ids` calculées chacune sur la route d'ORIGINE, dont la dernière écraserait
      la première (cf. en-tête du fichier).

      Le plan rendu est un ENSEMBLE : `deletes` sans doublon, `detaches` réduits à un par (collection, id, clé)
      et privés de ceux qui viseraient une entité supprimée (cf. en-tête du fichier). */
  static planMany(targets: ReadonlyArray<CascadeTarget>, find: Find, fetch: Fetch): CascadePlan {
    const deletes: CascadeDelete[] = [];
    const planned: CascadeDetach[] = [];
    const seen = new Set<string>(targets.map((t) => Cascade.key(t.collection, t.id)));
    const queue: CascadeDelete[] = [];

    /** Joue la règle d'UNE entité : ses suppressions vont dans la file (après dédup), ses détachements au plan. */
    const expand = (c: string, entityId: string): void => {
      const rule = Cascade.SPEC[c];
      if (!rule) return;
      const found: CascadeDelete[] = [];
      (rule.delete || []).forEach((r) => find(r.coll, r.fk, entityId).forEach((o) => found.push({ c: r.coll, id: o.id })));
      (rule.detach || []).forEach((r) => {
        const set = r.set || { [r.fk]: null };
        find(r.coll, r.fk, entityId).forEach((o) => Object.keys(set).forEach((k) => planned.push({ c: r.coll, id: o.id, key: k, value: set[k] })));
      });
      if (rule.custom) rule.custom(find, fetch, entityId, found, planned);
      for (const d of found) {
        const k = Cascade.key(d.c, d.id);
        if (seen.has(k)) continue;   // déjà planifiée par un autre chemin, ou c'est la cible → anti-cycle + dédup
        seen.add(k);
        deletes.push(d);
        queue.push(d);
      }
    };

    // Toutes les racines sont développées AVANT le parcours : leurs règles se voient donc mutuellement
    // (composition des retraits de liste, garde anti-résurrection à l'échelle du lot).
    for (const t of targets) expand(t.collection, t.id);
    // Parcours EN LARGEUR par index (pas de `shift()` : coût linéaire, et la file ne grandit plus une fois
    // toutes les entités atteignables vues). `queue` s'allonge pendant l'itération — c'est voulu.
    for (let i = 0; i < queue.length; i++) expand(queue[i].c, queue[i].id);

    // RÉDUCTION des détachements : on écarte ceux qui visent une entité SUPPRIMÉE (inutiles en mode fichier,
    // RESSUSCITANTS en mode API), puis on ne garde qu'une entrée par (collection, id, clé) — celle de la
    // DERNIÈRE valeur, à la place de la première occurrence. C'est exactement ce que produisent les deux
    // exécuteurs, qui appliquent les détachements en séquence : la réduction ne change donc aucun résultat,
    // elle rend seulement le plan lisible et proportionné.
    const detaches: CascadeDetach[] = [];
    const slotOf = new Map<string, number>();
    for (const d of planned) {
      if (seen.has(Cascade.key(d.c, d.id))) continue;
      const k = Cascade.key(d.c, d.id) + Cascade.KEY_SEP + d.key;
      const slot = slotOf.get(k);
      if (slot === undefined) { slotOf.set(k, detaches.length); detaches.push(d); }
      else detaches[slot] = d;
    }
    return { deletes, detaches };
  }
}
