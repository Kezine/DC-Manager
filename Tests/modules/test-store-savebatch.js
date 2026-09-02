/* Tests modules — LOT MIXTE du Store (`Store.saveBatch`, chantier T9).
   ----------------------------------------------------------------------------
   CE QUE CES SECTIONS PROUVENT, et pourquoi ça mérite un fichier à soi.

   Le défaut d'origine : « Enregistrer » un switch 24 ports depuis le formulaire
   d'équipement enchaînait 27 écritures unitaires awaitées — 27 transactions, donc
   27 révisions serveur, 27 événements SSE réveillant tous les autres clients, et
   27 pas d'undo en mode fichier. Le contrat de `DataAdapter` dit pourtant « 1
   action logique de l'UI = 1 transact() ».

   Toutes les assertions comptent donc des APPELS ADAPTATEUR (espion posé sur
   `transact`), jamais un état final : c'est le NOMBRE d'écritures qui est le
   sujet, autant que leur contenu. Harnais et assertions : harness.js.
   ============================================================================ */
"use strict";
const { ck, section, Store, BrowserStorageAdapter } = require("./harness.js");

/** Store neuf + ESPION sur `transact` — l'espion est posé APRÈS l'amorçage, pour ne compter
    que les écritures du lot sous test (patron de test-vm-purge.js). */
async function storeEspionne() {
  const adapter = new BrowserStorageAdapter({ persistent: false });
  const store = new Store(adapter);
  await store.init();
  await store.newDocument();
  const espion = { count: 0, last: null, all: [] };
  const start = () => {
    const reel = adapter.transact.bind(adapter);
    adapter.transact = async (tx) => { espion.count++; espion.last = tx; espion.all.push(tx); return reel(tx); };
  };
  return { store, adapter, espion, start };
}

/** Nombre d'opérations d'une transaction (les trois familles confondues). */
const opsDe = (tx) => ((tx && tx.creates) || []).length + ((tx && tx.updates) || []).length + ((tx && tx.deletes) || []).length;

module.exports = async () => {

  await section("saveBatch : lot MIXTE heureux — 1 transaction, contenu exact (creates + updates + deletes)", async () => {
    const { store, espion, start } = await storeEspionne();
    // Décor : un switch, un agrégat, deux ports persistés.
    const eq = await store.create("equipments", { name: "sw-mixte", type: "switch" });
    const agg = await store.create("aggregates", { equipment_id: eq.id, name: "LAG1" });
    const p1 = await store.create("ports", { equipment_id: eq.id, name: "Gi1" });
    const p2 = await store.create("ports", { equipment_id: eq.id, name: "Gi2" });

    start();
    const res = await store.saveBatch({
      creates: [{ collection: "ports", record: { id: "port-neuf", equipment_id: eq.id, name: "Gi3" } }],
      updates: [
        { collection: "equipments", id: eq.id, patch: { name: "sw-mixte-2" } },
        { collection: "ports", id: p1.id, patch: { name: "Gi1/renommé" } },
      ],
      removes: [{ collection: "ports", id: p2.id }],
    });

    ck(res.ok, "lot accepté");
    ck.eq(espion.count, 1, "🚨 UNE SEULE transaction pour créer + modifier + supprimer (jamais 4 écritures unitaires)");
    ck.eq(res.written, 4, "verdict : 4 opérations écrites (1 création + 2 mises à jour + 1 suppression)");
    ck.eq(espion.last.creates.length, 1, "transaction : 1 création");
    ck.eq(espion.last.creates[0].record.id, "port-neuf", "…l'id PRÉ-GÉNÉRÉ par l'appelant est celui écrit");
    ck.eq(espion.last.updates.length, 2, "transaction : 2 mises à jour");
    ck.eq(espion.last.deletes.length, 1, "transaction : 1 suppression");
    ck.eq(espion.last.deletes[0].id, p2.id, "…celle demandée");
    // Le CACHE reflète le lot (aucune écriture n'est « en l'air »).
    ck.eq(store.get("equipments", eq.id).name, "sw-mixte-2", "cache : équipement renommé");
    ck.eq(store.get("ports", p1.id).name, "Gi1/renommé", "cache : port renommé");
    ck.eq(store.get("ports", p2.id), null, "cache : port supprimé");
    ck(!!store.get("ports", "port-neuf"), "cache : port créé, indexé par son id");
    ck.eq(store.portsOf(eq.id).length, 2, "cache : index FK à jour (2 ports restants)");
    ck.eq(store.get("aggregates", agg.id).name, "LAG1", "l'agrégat non visé par le lot est intact");
    // UN SEUL pas d'undo pour TOUT le lot — c'est le gain du mode fichier (principe n°15).
    ck.eq(await store.undo(), true, "undo appliqué");
    ck.eq(store.get("ports", "port-neuf"), null, "UN seul undo défait la création…");
    ck(!!store.get("ports", p2.id), "…la suppression…");
    ck.eq(store.get("equipments", eq.id).name, "sw-mixte", "…et les mises à jour");
  });

  await section("saveBatch : refus TOUT-OU-RIEN — rien n'est écrit, les erreurs DÉSIGNENT la ligne fautive", async () => {
    const { store, espion, start } = await storeEspionne();
    const eq = await store.create("equipments", { name: "sw-refus", type: "switch" });
    const p1 = await store.create("ports", { equipment_id: eq.id, name: "Gi1" });
    const bundle = await store.create("cableBundles", { name: "trunk-1", fiber_count: 12 });

    start();
    // Trois opérations dont UNE seule est illégale : T4c (les deux brins d'un port duplex doivent être
    // distincts). Le lot entier doit tomber.
    const res = await store.saveBatch({
      creates: [{ collection: "ports", record: { id: "port-jamais", equipment_id: eq.id, name: "Gi9" } }],
      updates: [
        { collection: "equipments", id: eq.id, patch: { name: "sw-refus-2" } },
        { collection: "ports", id: p1.id, patch: { bundle_id: bundle.id, strand_a: 3, strand_b: 3 } },
      ],
    });

    ck.eq(res.ok, false, "lot REFUSÉ");
    ck.eq(res.written, 0, "…0 opération écrite");
    ck.eq(espion.count, 0, "🚨 AUCUNE transaction émise (ni révision, ni SSE, ni pas d'undo)");
    ck(res.errors.length > 0, "le verdict porte les erreurs");
    const fautive = res.errors.find((e) => e.collection === "ports" && e.id === p1.id);
    ck(!!fautive, "🚨 l'erreur DÉSIGNE la ligne fautive (collection + id) — de quoi la surligner dans un formulaire");
    ck.eq(store.get("equipments", eq.id).name, "sw-refus", "rien n'est écrit : l'équipement garde son nom");
    ck.eq(store.get("ports", "port-jamais"), null, "rien n'est écrit : la création n'a pas eu lieu");
    ck.eq(store.get("ports", p1.id).strand_a, null, "rien n'est écrit : le port fautif est intact");

    // Le REFUS passe aussi par le toast global (`onInvalid`), en UNE fois pour tout le lot.
    let notifie = 0;
    store.onInvalid = () => { notifie++; };
    await store.saveBatch({ updates: [{ collection: "ports", id: p1.id, patch: { bundle_id: bundle.id, strand_a: 3, strand_b: 3 } }] });
    ck.eq(notifie, 1, "`onInvalid` notifié UNE fois pour le lot (pas une fois par ligne)");
  });

  await section("saveBatch : filtre NO-OP — un « Enregistrer » sans modification n'écrit RIEN", async () => {
    const { store, espion, start } = await storeEspionne();
    // Un équipement à 12 ports : c'est le cas qui motivait le filtre (un save à blanc réémettait
    // l'équipement ET chacun de ses ports).
    const eq = await store.create("equipments", { name: "sw-blanc", type: "switch" });
    const ports = [];
    for (let i = 1; i <= 12; i++) ports.push(await store.create("ports", { equipment_id: eq.id, name: "Gi" + i }));
    const dates = ports.map((p) => store.get("ports", p.id).updated_date);

    start();
    // Le lot RÉÉMET exactement les valeurs stockées — comme le fait un formulaire non modifié.
    const res = await store.saveBatch({
      updates: [{ collection: "equipments", id: eq.id, patch: { name: "sw-blanc", type: "switch" } }].concat(
        ports.map((p) => ({ collection: "ports", id: p.id, patch: { equipment_id: eq.id, name: p.name, role: "data" } }))),
    });
    ck(res.ok, "save à blanc : SUCCÈS (il n'y avait rien à refuser)");
    ck.eq(res.written, 0, "…0 écriture");
    ck.eq(espion.count, 0, "🚨 AUCUNE transaction pour un save à blanc de 13 enregistrements");
    ck(ports.every((p, i) => store.get("ports", p.id).updated_date === dates[i]), "…et aucun `touch()` sur updated_date");

    // PARITÉ `updateBatch` : c'est le MÊME chemin (cas particulier du lot), donc le même filtre.
    ck.eq(await store.updateBatch([{ collection: "equipments", id: eq.id, patch: { name: "sw-blanc" } }]), 0, "updateBatch : lot entièrement no-op → 0 écriture");
    ck.eq(espion.count, 0, "…et toujours aucune transaction");
    ck.eq(await store.updateBatch([]), 0, "updateBatch : lot VIDE → 0 (et aucune transaction)");
    ck.eq(espion.count, 0, "…confirmé");

    // Un lot MIXTE dont TOUTES les mises à jour sont no-op mais qui porte une vraie création écrit quand même.
    const mixte = await store.saveBatch({
      creates: [{ collection: "ports", record: { id: "gi-13", equipment_id: eq.id, name: "Gi13" } }],
      updates: [{ collection: "equipments", id: eq.id, patch: { name: "sw-blanc" } }],
    });
    ck.eq(mixte.written, 1, "lot mixte : seule la création survit au filtre no-op");
    ck.eq(espion.count, 1, "…en UNE transaction");
    ck.eq(opsDe(espion.last), 1, "…qui ne porte QUE la création (aucune mise à jour à l'identique)");
  });

  await section("saveBatch : fusion CASCADE ⇄ LOT par CHAMP — une seule écriture par ligne", async () => {
    /* Cas concret (Q9.6) : le lot SUPPRIME un agrégat — dont la cascade détache `aggregate_id` sur ses
       ports — ET met à jour ces MÊMES ports. Deux entrées `updates` sur la même ligne seraient un bug
       (la dernière écraserait la première, chez le Store comme chez le serveur). */
    {
      const { store, espion, start } = await storeEspionne();
      const eq = await store.create("equipments", { name: "sw-fusion", type: "switch" });
      const aggA = await store.create("aggregates", { equipment_id: eq.id, name: "LAG-A" });
      const aggB = await store.create("aggregates", { equipment_id: eq.id, name: "LAG-B" });
      const pNom = await store.create("ports", { equipment_id: eq.id, name: "Gi1", aggregate_id: aggA.id });
      const pRebranche = await store.create("ports", { equipment_id: eq.id, name: "Gi2", aggregate_id: aggA.id });

      start();
      const res = await store.saveBatch({
        updates: [
          // (i) le lot touche un AUTRE champ → le détachement de cascade doit SURVIVRE
          { collection: "ports", id: pNom.id, patch: { name: "Gi1/renommé" } },
          // (ii) le lot touche LE champ détaché → l'intention de l'utilisateur GAGNE
          { collection: "ports", id: pRebranche.id, patch: { aggregate_id: aggB.id } },
        ],
        removes: [{ collection: "aggregates", id: aggA.id }],
      });

      ck(res.ok, "lot accepté (le cas est NORMAL, jamais un motif de refus)");
      ck.eq(espion.count, 1, "UNE transaction");
      ck.eq(espion.last.updates.length, 2, "🚨 DEUX entrées d'updates pour DEUX lignes — jamais deux pour la même");
      const ids = espion.last.updates.map((u) => u.id).sort();
      ck.eq(JSON.stringify(ids), JSON.stringify([pNom.id, pRebranche.id].sort()), "…et ce sont bien les deux ports");
      ck.eq(store.get("ports", pNom.id).name, "Gi1/renommé", "(i) le patch explicite est appliqué…");
      ck.eq(store.get("ports", pNom.id).aggregate_id, null, "…(i) ET le détachement de cascade a survécu sur le champ que le lot ne touche pas");
      ck.eq(store.get("ports", pRebranche.id).aggregate_id, aggB.id, "🚨 (ii) sur le champ QU'ELLE touche, l'intention de l'utilisateur bat le détachement");
      ck.eq(store.get("aggregates", aggA.id), null, "l'agrégat racine est supprimé");
    }
    {
      /* Arête inverse : une ligne à la fois MISE À JOUR par le lot et SUPPRIMÉE par la cascade d'un
         retrait. La suppression gagne — la mettre à jour dans la même transaction serait absurde, et
         l'écrire la RESSUSCITERAIT côté serveur (les exécuteurs appliquent deletes PUIS updates). */
      const { store, espion, start } = await storeEspionne();
      const eq = await store.create("equipments", { name: "sw-trunk", type: "switch" });
      const trunk = await store.create("ports", { equipment_id: eq.id, name: "Trunk" });
      const lane = await store.create("ports", { equipment_id: eq.id, name: "Trunk/1", parent_port_id: trunk.id, lane: 1 });

      start();
      const res = await store.saveBatch({
        updates: [{ collection: "ports", id: lane.id, patch: { name: "Trunk/1/renommée" } }],
        removes: [{ collection: "ports", id: trunk.id }],   // cascade : la lane part avec son trunk
      });
      ck(res.ok, "lot accepté");
      ck.eq(espion.count, 1, "UNE transaction");
      ck.eq((espion.last.updates || []).length, 0, "🚨 AUCUNE mise à jour sur la ligne que la cascade supprime (sinon elle ressusciterait)");
      ck.eq(espion.last.deletes.length, 2, "…la transaction supprime le trunk ET sa lane");
      ck.eq(store.get("ports", lane.id), null, "la lane est bien supprimée");
    }
  });

  await section("saveBatch : retraits de ports en RACINES — lanes et trunk dans UN SEUL plan (l'ordre disparaît)", async () => {
    /* Avant T9, le formulaire d'équipement retirait les lanes AVANT leur trunk, une transaction chacune,
       « parce qu'un trunk supprimé cascade ses lanes ». Le plan MULTI-RACINES rend cet ordre sans objet :
       la dédup et la garde anti-résurrection valent à l'échelle du lot. */
    const { store, espion, start } = await storeEspionne();
    const eq = await store.create("equipments", { name: "sw-lanes", type: "switch" });
    const peer = await store.create("equipments", { name: "peer", type: "switch" });
    const far = await store.create("ports", { equipment_id: peer.id, name: "far" });
    const trunk = await store.create("ports", { equipment_id: eq.id, name: "Trunk" });
    const lanes = [];
    for (let i = 1; i <= 4; i++) lanes.push(await store.create("ports", { equipment_id: eq.id, name: "Trunk/" + i, parent_port_id: trunk.id, lane: i }));
    const cab = await store.create("cables", { from_port_id: lanes[0].id, to_port_id: far.id });

    start();
    // Les racines sont données dans le DÉSORDRE (trunk d'abord, doublon, id inconnu) : rien de tout cela
    // ne doit changer le résultat.
    const res = await store.saveBatch({
      removes: [{ collection: "ports", id: trunk.id }].concat(
        lanes.map((l) => ({ collection: "ports", id: l.id })),
        [{ collection: "ports", id: trunk.id }, { collection: "ports", id: "port-inconnu" }]),
    });
    ck(res.ok, "lot accepté");
    ck.eq(espion.count, 1, "🚨 UNE SEULE transaction pour le trunk et ses 4 lanes (au lieu de 5)");
    ck.eq(espion.last.deletes.length, 6, "…5 ports + le câble de la lane, en un plan (doublon et id inconnu écartés)");
    ck.eq(store.portsOf(eq.id).length, 0, "aucun port ne survit");
    ck.eq(store.get("cables", cab.id), null, "le câble de la lane est parti par cascade");
    ck(!!store.get("ports", far.id), "le port distant SURVIT (le rayon d'action reste borné)");
  });

  await section("saveBatch : re-typer en « patch_panel » ET vider le réseau de ses ports DANS LE MÊME LOT (T7)", async () => {
    /* La règle T7 refuse qu'un port d'équipement PATCH asserte un réseau, et la dépendance inverse
       equipments→ports la rejoue au changement de type. Écrit SÉQUENTIELLEMENT, le save était donc
       obligé d'une PRÉ-PASSE (vider les ports persistés avant l'update de l'équipement). Validé contre
       l'état POST-LOT, le lot unique passe — c'est ce que cette section prouve, et c'est ce qui autorise
       la suppression de la pré-passe dans `EquipmentForms`. */
    const { store, espion, start } = await storeEspionne();
    const net = await store.create("networks", { label: "VLAN 10" });
    const eq = await store.create("equipments", { name: "sw-vers-patch", type: "switch" });
    const p1 = await store.create("ports", { equipment_id: eq.id, name: "Gi1", network_id: net.id, network_ids: [net.id] });
    const p2 = await store.create("ports", { equipment_id: eq.id, name: "Gi2", network_id: net.id, network_ids: [net.id] });
    ck.eq(store.get("ports", p1.id).network_id, net.id, "décor : les ports PERSISTÉS assertent un réseau");

    // CONTRÔLE DE DISCRIMINATION : sans le vidage, le lot DOIT être refusé (sinon la section ne prouverait rien).
    const refus = await store.saveBatch({ updates: [{ collection: "equipments", id: eq.id, patch: { type: "patch_panel" } }] });
    ck.eq(refus.ok, false, "contrôle : re-typer en patch SANS vider les ports est bien REFUSÉ (T7 via V5b)");

    start();
    const res = await store.saveBatch({
      updates: [
        { collection: "equipments", id: eq.id, patch: { type: "patch_panel" } },
        { collection: "ports", id: p1.id, patch: { network_id: null, network_ids: [] } },
        { collection: "ports", id: p2.id, patch: { network_id: null, network_ids: [] } },
      ],
    });
    ck(res.ok, "🚨 le MÊME lot re-type l'équipement ET vide ses ports : accepté (état POST-lot)");
    ck.eq(espion.count, 1, "…en UNE transaction (la pré-passe séquentielle n'a plus lieu d'être)");
    ck.eq(store.get("equipments", eq.id).type, "patch_panel", "équipement re-typé");
    ck.eq(store.get("ports", p1.id).network_id, null, "port 1 sans réseau");
    ck.eq(JSON.stringify(store.get("ports", p2.id).network_ids), "[]", "port 2 sans réseau");
  });

  await section("saveBatch : couper `poe_device` ET rétrograder les ports PoE DANS LE MÊME LOT (T-POE1/T-POE2)", async () => {
    /* Miroir exact de la section précédente, côté PoE : T-POE1 exige un équipement « POE » sous un port de
       rôle « poe », et T-POE2 (portée) refuse de retirer la capacité tant qu'un tel port existe. Là encore,
       seule la validation CONSCIENTE DU LOT permet de faire les deux d'un geste — d'où la disparition de la
       seconde pré-passe du formulaire. */
    const { store, espion, start } = await storeEspionne();
    const eq = await store.create("equipments", { name: "sw-poe", type: "switch", poe_device: true, poe_budget_w: 370 });
    const pPoe = await store.create("ports", { equipment_id: eq.id, name: "Gi1", role: "poe", direction: "source", poe_budget_w: 30 });
    ck.eq(store.get("ports", pPoe.id).role, "poe", "décor : un port PoE PERSISTÉ");

    // CONTRÔLE DE DISCRIMINATION : couper la capacité sans rétrograder le port doit échouer.
    const refus = await store.saveBatch({ updates: [{ collection: "equipments", id: eq.id, patch: { poe_device: false } }] });
    ck.eq(refus.ok, false, "contrôle : couper poe_device avec un port PoE est bien REFUSÉ (T-POE2)");

    start();
    const res = await store.saveBatch({
      updates: [
        { collection: "equipments", id: eq.id, patch: { poe_device: false, poe_budget_w: null } },
        // direction VIDÉE et budget annulé : un rôle « data » interdit toute direction résiduelle (T12).
        { collection: "ports", id: pPoe.id, patch: { role: "data", direction: "", poe_budget_w: null } },
      ],
    });
    ck(res.ok, "🚨 le MÊME lot coupe la capacité PoE ET rétrograde le port : accepté");
    ck.eq(espion.count, 1, "…en UNE transaction");
    ck.eq(store.get("equipments", eq.id).poe_device, false, "capacité PoE retirée");
    ck.eq(store.get("ports", pPoe.id).role, "data", "port rétrogradé en données");
    ck.eq(store.get("ports", pPoe.id).direction, "", "…direction vidée (T12)");
  });

  await section("saveBatch : le SAVE COMPLET d'un équipement neuf à 24 ports — 1 transaction, pas 27", async () => {
    /* La mesure qui a motivé le chantier, reproduite au niveau du Store : créer un équipement, ses deux
       agrégats et ses 24 ports en UN geste. Les ids sont PRÉ-GÉNÉRÉS par l'appelant, sans quoi les ports
       ne sauraient pas quel `equipment_id` écrire. */
    const { store, espion, start } = await storeEspionne();
    const eqId = "eq-neuf";
    const creates = [{ collection: "equipments", record: { id: eqId, name: "sw-24", type: "switch" } },
      { collection: "aggregates", record: { id: "agg-1", equipment_id: eqId, name: "LAG1" } },
      { collection: "aggregates", record: { id: "agg-2", equipment_id: eqId, name: "LAG2" } }];
    for (let i = 1; i <= 24; i++) creates.push({ collection: "ports", record: { id: "p-" + i, equipment_id: eqId, name: "Gi" + i, aggregate_id: i <= 2 ? "agg-1" : null } });

    start();
    const res = await store.saveBatch({ creates });
    ck(res.ok, "lot accepté (les FK INTERNES au lot se résolvent : le port vise l'équipement créé avec lui)");
    ck.eq(espion.count, 1, "🚨 UNE transaction pour 27 enregistrements (c'était 27 transactions avant T9)");
    ck.eq(res.written, 27, "verdict : 27 opérations écrites");
    ck.eq(store.portsOf(eqId).length, 24, "les 24 ports sont au cache, indexés par FK");
    ck.eq(store.aggregatesOf(eqId).length, 2, "…et les 2 agrégats");
    ck.eq(store.portsOfAggregate("agg-1").length, 2, "…l'agrégat créé DANS le lot est bien référencé par ses ports");
    ck.eq(await store.undo(), true, "undo appliqué");
    ck.eq(store.get("equipments", eqId), null, "🚨 UN SEUL undo défait tout le save (c'était 27 Ctrl+Z)");
  });
};
