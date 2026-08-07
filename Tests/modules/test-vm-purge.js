/* Tests modules — PURGE DE MASSE des VMs (lot A du cadrage 2026-08-07).

   Deux objets sous test, de nature très différente :

   1. `core/VmPurge` — la RÈGLE, pure : quels groupes sont proposables (orphelines d'un
      provider configuré / VMs FIGÉES d'un provider disparu / fusion en mode fichier), ce
      qu'est une VM « ENRICHIE » (chaque famille éprouvée SÉPARÉMENT) et les comptes exacts
      du récapitulatif, dérivés du PLAN de cascade et jamais estimés.

   2. `Store.removeMany` — la GARANTIE transactionnelle, sur des composants RÉELS : 60
      racines produisent UNE seule transaction (jamais une boucle sur `remove()`), donc UN
      seul pas d'undo côté fichier ; et cette MÊME transaction, rejouée par le pipeline du
      serveur sur un `DocumentStore` réel (better-sqlite3), ne consomme QU'UNE révision et
      ne publie QU'UN événement SSE. Les adresses IP rattachées sont DÉTACHÉES, jamais
      supprimées — et un unique « Annuler » restitue l'intégralité de la purge.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SERVER, Store, BrowserStorageAdapter, Validation, Cascade } = require("./harness.js");

module.exports = async () => {
  const { VmPurge } = D("core/VmPurge.js");

  /* Lecteurs injectés : par défaut « aucune IP rattachée » ; `ipsOf` permet d'en simuler. */
  const readers = (ipsOf = {}) => ({ attachedIpCount: (vmId) => ipsOf[vmId] || 0 });
  const vm = (over) => Object.assign({ id: "v", name: "vm", provider_id: "pve", orphan: false, notes: "", description: "", group_id: null, group_ids: [] }, over);

  /* ============ 1. LE CRITÈRE « ENRICHIE », FAMILLE PAR FAMILLE ============ */

  await section("VmPurge : critère « enrichie » — chaque famille éprouvée SÉPARÉMENT", async () => {
    const r = readers();
    ck.eq(VmPurge.isEnriched(vm({ id: "a" }), r), false, "VM nue (aucun champ local, aucune IP) → NON enrichie");
    ck.eq(VmPurge.isEnriched(vm({ id: "a", notes: "à garder" }), r), true, "famille NOTES seule → enrichie");
    ck.eq(VmPurge.isEnriched(vm({ id: "a", description: "prod" }), r), true, "famille DESCRIPTION seule → enrichie");
    ck.eq(VmPurge.isEnriched(vm({ id: "a", group_id: "g1" }), r), true, "famille GROUPES — primaire seul (legacy sans group_ids) → enrichie");
    ck.eq(VmPurge.isEnriched(vm({ id: "a", group_ids: ["g1"] }), r), true, "famille GROUPES — liste seule → enrichie");
    ck.eq(VmPurge.isEnriched(vm({ id: "a" }), readers({ a: 1 })), true, "famille IPs — 1 adresse rattachée → enrichie");
    // Ce qui NE compte PAS : blancs, listes vides, et surtout le texte venu du PROVIDER.
    ck.eq(VmPurge.isEnriched(vm({ id: "a", notes: "   ", description: "\t" }), r), false, "notes/description en BLANCS → pas un enrichissement");
    ck.eq(VmPurge.isEnriched(vm({ id: "a", group_ids: ["", null] }), r), false, "group_ids d'entrées vides → pas un enrichissement");
    ck.eq(VmPurge.isEnriched(vm({ id: "a", description_src: "front web (Proxmox)" }), r), false, "description_src (texte du PROVIDER) → PAS un enrichissement local");
    // Familles CUMULÉES, dans l'ordre canonique (c'est l'ordre d'affichage des raisons).
    const fams = VmPurge.enrichmentFamilies(vm({ id: "a", notes: "n", description: "d", group_ids: ["g"] }), readers({ a: 3 }));
    ck.eq(fams.join(","), "notes,description,groups,ips", "familles cumulées rendues dans l'ORDRE canonique");
  });

  /* ============ 2. LES GROUPES (mode API vs mode FICHIER) ============ */

  await section("VmPurge : groupes — provider CONFIGURÉ vs DISPARU (mode API)", async () => {
    const vms = [
      vm({ id: "v1", name: "b", provider_id: "pve-prod", orphan: true }),
      vm({ id: "v2", name: "a", provider_id: "pve-prod", orphan: true }),
      vm({ id: "v3", name: "c", provider_id: "pve-prod", orphan: false }),   // VIVANTE d'un provider configuré → jamais proposée
      vm({ id: "v4", name: "d", provider_id: "pve-old", orphan: false }),    // FIGÉE (provider disparu, sans pastille)
      vm({ id: "v5", name: "e", provider_id: "pve-old", orphan: true }),
    ];
    const groups = VmPurge.groups(vms, ["pve-prod"], readers());
    ck.eq(groups.length, 2, "deux groupes : orphelines du configuré + VMs du disparu");
    ck.eq(groups[0].kind, "orphans", "les ORPHELINES d'abord (ordre d'affichage)");
    ck.eq(groups[0].key, "orphans:pve-prod", "clé stable du groupe orphelines");
    ck.eq(groups[0].entries.map((e) => e.id).join(","), "v2,v1", "entrées triées par NOM (a avant b) — v3 vivante EXCLUE");
    ck.eq(groups[0].providerConfigKnown, true, "config des providers CONNUE (mode API)");
    ck.eq(groups[1].kind, "goneProvider", "puis le provider DISPARU");
    ck.eq(groups[1].entries.length, 2, "provider disparu → TOUTES ses VMs (orphelines ou non)");
    ck.eq(groups[1].entries.map((e) => e.id).sort().join(","), "v4,v5", "…dont la VM figée SANS pastille (v4), introuvable autrement");
    ck.eq(VmPurge.hasPurgeable(vms, ["pve-prod"]), true, "hasPurgeable : il y a matière");
  });

  await section("VmPurge : groupes — mode FICHIER (config INCONNUE) → fusion sur les seules orphelines", async () => {
    const vms = [
      vm({ id: "v1", provider_id: "pve-prod", orphan: true }),
      vm({ id: "v2", provider_id: "pve-old", orphan: false }),   // sans serveur, IMPOSSIBLE de savoir que le provider a disparu
      vm({ id: "v3", provider_id: "pve-old", orphan: true }),
    ];
    const groups = VmPurge.groups(vms, null, readers());
    ck.eq(groups.length, 2, "un groupe par provider_id porteur d'orphelines");
    ck(groups.every((g) => g.kind === "orphans"), "AUCUN groupe « provider disparu » : la config n'est pas lisible");
    ck(groups.every((g) => g.providerConfigKnown === false), "groupes marqués « config inconnue » (l'UI doit le dire)");
    ck.eq(groups.map((g) => g.providerId).join(","), "pve-old,pve-prod", "groupes triés par provider_id");
    ck.eq(groups.reduce((n, g) => n + g.entries.length, 0), 2, "seules les ORPHELINES sont proposées (v2 vivante-ou-figée épargnée)");
    // Sans orpheline et sans config, il n'y a RIEN à proposer — le bouton doit disparaître.
    const calm = [vm({ id: "v9", provider_id: "pve-prod", orphan: false })];
    ck.eq(VmPurge.groups(calm, null, readers()).length, 0, "aucune orpheline en mode fichier → aucun groupe");
    ck.eq(VmPurge.hasPurgeable(calm, null), false, "hasPurgeable : rien à purger");
  });

  await section("VmPurge : cas limites de groupage (provider vide, hasPurgeable ⇄ groups)", async () => {
    // provider_id VIDE : il n'y a pas de provider à avoir disparu → jamais rangé en « disparu ».
    const orphanNoProvider = [vm({ id: "v1", provider_id: "", orphan: true })];
    const g1 = VmPurge.groups(orphanNoProvider, ["pve-prod"], readers());
    ck.eq(g1.length + (g1[0] ? 0 : 99), 1, "orpheline SANS provider → un groupe");
    ck.eq(g1[0].kind, "orphans", "…de nature « orphelines », jamais « provider disparu »");
    ck.eq(g1[0].providerId, "", "…sur le provider vide (l'UI le libelle « sans provider »)");
    const liveNoProvider = [vm({ id: "v1", provider_id: "", orphan: false })];
    ck.eq(VmPurge.groups(liveNoProvider, ["pve-prod"], readers()).length, 0, "VM vivante sans provider → rien à purger");
    // INVARIANT : le prédicat BON MARCHÉ de visibilité doit dire exactement ce que dit la construction
    // complète des groupes — sinon le bouton s'affiche sur une modale vide (ou l'inverse).
    const corpus = [
      [[], null], [[], ["p"]],
      [orphanNoProvider, null], [orphanNoProvider, ["pve-prod"]],
      [liveNoProvider, null], [liveNoProvider, ["pve-prod"]],
      [[vm({ id: "x", provider_id: "gone", orphan: false })], ["pve-prod"]],
      [[vm({ id: "x", provider_id: "gone", orphan: false })], null],
      [[vm({ id: "x", provider_id: "pve-prod", orphan: true })], ["pve-prod"]],
    ];
    let ok = true;
    corpus.forEach(([list, configured]) => {
      if (VmPurge.hasPurgeable(list, configured) !== (VmPurge.groups(list, configured, readers()).length > 0)) ok = false;
    });
    ck(ok, "INVARIANT : hasPurgeable(...) ≡ groups(...).length > 0 sur tout le corpus de cas");
  });

  /* ============ 3. SÉLECTION + COMPTES DU RÉCAPITULATIF ============ */

  await section("VmPurge : sélection (enrichies opt-in) et comptes du récapitulatif", async () => {
    const vms = [
      vm({ id: "nue1", name: "n1", provider_id: "pve", orphan: true }),
      vm({ id: "nue2", name: "n2", provider_id: "pve", orphan: true }),
      vm({ id: "rich", name: "r1", provider_id: "pve", orphan: true, notes: "à garder" }),
      vm({ id: "gone", name: "g1", provider_id: "old", orphan: false }),
    ];
    const groups = VmPurge.groups(vms, ["pve"], readers({ rich: 2 }));
    const orphans = groups.find((g) => g.kind === "orphans");
    const goneGroup = groups.find((g) => g.kind === "goneProvider");
    ck.eq(orphans.plainCount, 2, "compteur des VMs nues du groupe");
    ck.eq(orphans.enrichedCount, 1, "compteur des enrichies du groupe");

    // Groupe coché, enrichies NON incluses (défaut V2) : la VM enrichie est épargnée.
    const s1 = VmPurge.select(groups, new Set([orphans.key]), false);
    ck.eq(s1.ids.sort().join(","), "nue1,nue2", "enrichies EXCLUES par défaut");
    ck.eq(s1.enrichedIds.length, 0, "…et aucune n'est comptée comme enrichie sélectionnée");
    // Inclusion explicite.
    const s2 = VmPurge.select(groups, new Set([orphans.key]), true);
    ck.eq(s2.ids.sort().join(","), "nue1,nue2,rich", "« inclure les enrichies » les ajoute");
    ck.eq(s2.enrichedIds.join(","), "rich", "…et le récapitulatif sait lesquelles");
    // Groupe NON coché → rien, même en incluant les enrichies.
    ck.eq(VmPurge.select(groups, new Set(), true).ids.length, 0, "aucun groupe coché → sélection vide");
    ck.eq(VmPurge.select(groups, new Set([goneGroup.key]), false).ids.join(","), "gone", "le groupe « provider disparu » se coche indépendamment");

    // COMPTES : les IP détachées viennent du PLAN de cascade, pas d'une estimation.
    const plan = { detaches: [
      { c: "ipAddresses", id: "ip1", key: "vm_id" },
      { c: "ipAddresses", id: "ip2", key: "vm_id" },
      { c: "equipments", id: "e1", key: "rack_id" },   // détachement d'une AUTRE collection → non compté
    ] };
    const summary = VmPurge.summary(s2, plan);
    ck.eq(summary.vms, 3, "récapitulatif : nombre de VMs supprimées");
    ck.eq(summary.enriched, 1, "récapitulatif : dont enrichies");
    ck.eq(summary.detachedIps, 2, "récapitulatif : adresses IP détachées LUES DANS LE PLAN");
    ck.eq(VmPurge.detachedIpCount(null), 0, "plan absent → 0 (aucune estimation de repli)");
    ck.eq(VmPurge.detachedIpCount({ detaches: [{ c: "ipAddresses", id: "ip1", key: "vm_id" }, { c: "ipAddresses", id: "ip1", key: "autre" }] }), 1,
      "adresses DISTINCTES : deux détachements sur la même IP ne la comptent qu'une fois");
  });

  /* ============ 4. Store.removeMany — UNE transaction, UN pas d'undo ============ */

  /* Partagé avec la section serveur : la transaction RÉELLEMENT produite par le client et l'état
     du document AVANT purge (null si la section 4 a échoué → la section 5 se saute proprement). */
  let clientPurge = null;

  await section("Store.removeMany : 60 racines ⇒ UNE transaction, IP détachées, UN seul undo", async () => {
    const adapter = new BrowserStorageAdapter({ persistent: false });
    const store = new Store(adapter);
    await store.init();
    await store.newDocument();

    // 60 VMs orphelines d'un provider disparu (le volume EXACT de l'incident qui a motivé la feature),
    // dont 20 portent une adresse IP rattachée.
    const VM_COUNT = 60, IP_COUNT = 20;
    for (let i = 0; i < VM_COUNT; i++) {
      await store.create("vms", { id: "vm-" + i, name: "vm" + i, provider_id: "pve-old", ext_id: "old/" + (100 + i), orphan: true });
    }
    for (let i = 0; i < IP_COUNT; i++) {
      await store.create("ipAddresses", { id: "ip-" + i, address: "10.1." + i + ".5", hostname: "vm" + i, vm_id: "vm-" + i });
    }
    ck.eq(store.all("vms").length, VM_COUNT, "jeu de départ : 60 VMs");
    ck.eq(store.all("ipAddresses").filter((a) => a.vm_id).length, IP_COUNT, "…dont 20 avec une adresse IP rattachée");
    const beforeVms = store.all("vms").map((v) => v.toJSON());
    const beforeIps = store.all("ipAddresses").map((a) => a.toJSON());

    // ESPION posé APRÈS l'amorçage : on ne compte que les écritures de la purge.
    const realTransact = adapter.transact.bind(adapter);
    let txCount = 0, lastTx = null;
    adapter.transact = async (tx) => { txCount++; lastTx = tx; return realTransact(tx); };

    // Garde-fous AVANT la purge : rien à supprimer ⇒ AUCUNE écriture (pas de rev/SSE/undo à vide).
    ck.eq(await store.removeMany("vms", []), 0, "lot vide → 0 supprimée");
    ck.eq(await store.removeMany("vms", ["inconnue-1", "inconnue-2"]), 0, "ids inconnus → 0 supprimée");
    ck.eq(txCount, 0, "…et AUCUNE transaction émise pour un lot sans effet");

    // Aperçu de la cascade AVANT d'agir : c'est lui qui alimente le récapitulatif de la modale.
    const ids = store.all("vms").map((v) => v.id);
    const preview = store.cascadePreview("vms", ids);
    ck.eq(VmPurge.detachedIpCount(preview), IP_COUNT, "cascadePreview : 20 adresses IP annoncées comme détachées");
    ck.eq(preview.deletes.length, 0, "cascadePreview : la règle `vms` n'entraîne AUCUNE suppression enfant");

    // LA PURGE : les ids sont volontairement passés avec un DOUBLON et un inconnu (l'UI n'est pas un contrat).
    const purged = await store.removeMany("vms", [...ids, ids[0], "vm-inexistante"]);
    ck.eq(purged, VM_COUNT, "60 racines supprimées (doublon et id inconnu écartés)");
    ck.eq(txCount, 1, "🚨 UNE SEULE transaction pour 60 racines (jamais une boucle sur remove())");
    ck.eq(lastTx.deletes.length, VM_COUNT, "…portant les 60 suppressions");
    ck.eq(lastTx.updates.length, IP_COUNT, "…et les 20 détachements d'IP DANS LA MÊME transaction");
    ck.eq(store.all("vms").length, 0, "plus aucune VM dans le document");
    ck.eq(store.all("ipAddresses").length, IP_COUNT, "les adresses IP SURVIVENT (jamais supprimées)");
    ck(store.all("ipAddresses").every((a) => a.vm_id === null), "…elles sont simplement DÉTACHÉES (vm_id null)");

    // UN SEUL undo restitue TOUT le lot — c'est le critère, pas un espoir.
    ck(store.canUndo(), "la purge a laissé un pas d'undo");
    ck.eq(await store.undo(), true, "undo appliqué");
    ck.eq(store.all("vms").length, VM_COUNT, "UN seul undo restaure les 60 VMs");
    ck.eq(store.all("ipAddresses").filter((a) => a.vm_id).length, IP_COUNT, "…et re-rattache les 20 adresses IP");
    ck.eq(store.all("vms").filter((v) => v.orphan === true).length, VM_COUNT, "…dans leur état d'origine (orphan conservé)");

    clientPurge = { tx: lastTx, beforeVms, beforeIps, vmCount: VM_COUNT, ipCount: IP_COUNT };
  });

  /* ============ 5. La MÊME transaction côté SERVEUR : 1 révision, 1 SSE ============ */

  await section("Store.removeMany : la transaction du client sur un DocumentStore RÉEL — 1 révision, 1 SSE", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections serveur.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probeDb = new Candidate(":memory:"); probeDb.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section sautée"); return; }
    if (!clientPurge) { ck(false, "transaction cliente indisponible (section précédente en échec)"); return; }

    const fs = require("fs"), os = require("os");
    const { DocumentStore } = SERVER("documents.js");
    const { ApiRules } = SERVER("ApiRules.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmpurge-"));
    try {
      const docs = new DocumentStore(dir, Sqlite);
      const doc = docs.create("infra-purge");
      const repo = docs.repo(doc.id);
      // Le document serveur part de l'état PRÉ-purge du client (enregistrements déjà normalisés).
      repo.transact({ creates: [
        ...clientPurge.beforeVms.map((r) => ({ collection: "vms", record: r })),
        ...clientPurge.beforeIps.map((r) => ({ collection: "ipAddresses", record: r })),
      ] }, docs.markChanged(doc.id));
      ck.eq(repo.findBy("vms", "provider_id", "pve-old").length, clientPurge.vmCount, "document serveur amorcé : 60 VMs");

      const revBefore = docs.getRev(doc.id);
      const live = { events: [], publish(docId, data) { this.events.push({ docId, data }); } };

      // --- PIPELINE `POST /transact` d'api.ts, rejoué à l'identique (l'Express, lui, n'est pas chargeable ici) :
      //     UNE requête = UNE `markChanged` (resolveRepo), la cascade RÉSIDUELLE fusionnée au lot, UNE écriture
      //     atomique, puis UNE publication SSE au `finish` de la réponse.
      const body = { creates: [], updates: clientPurge.tx.updates, deletes: clientPurge.tx.deletes };
      const rev = docs.markChanged(doc.id);
      const changeset = ApiRules.buildChangeset(body, undefined, "/transact");
      const fetchBatch = Validation.DataValidator.buildBatchFetcher((c, id) => repo.getOne(c, id), body);
      const findBatch = Validation.DataValidator.buildBatchChildFinder((c, f, v) => repo.findBy(c, f, v), body);
      const residual = ApiRules.residualCascade(body.deletes, findBatch, fetchBatch);
      ck.eq(residual.deletes.length + residual.updates.length, 0, "cascade RÉSIDUELLE vide : le client a envoyé un plan COMPLET");
      repo.transact({ ...body, deletes: [...body.deletes, ...residual.deletes], updates: [...body.updates, ...residual.updates] }, rev);
      live.publish(doc.id, { rev, changeset });
      // --- fin du pipeline.

      ck.eq(docs.getRev(doc.id) - revBefore, 1, "🚨 UNE SEULE révision consommée pour la purge des 60 VMs");
      ck.eq(live.events.length, 1, "🚨 UN SEUL événement SSE publié (les autres clients ne sont réveillés qu'une fois)");
      const collections = live.events[0].data.changeset.collections.slice().sort().join(",");
      ck.eq(collections, "ipAddresses,vms", "changeset ciblé sur les DEUX collections touchées (rechargement granulaire)");
      ck.eq(live.events[0].data.changeset.full, false, "…et jamais un rechargement COMPLET");

      ck.eq(repo.findBy("vms", "provider_id", "pve-old").length, 0, "les 60 VMs ont disparu du document serveur");
      ck.eq(repo.findBy("ipAddresses", "vm_id", "vm-0").length, 0, "l'adresse IP n'est plus rattachée à sa VM");
      const ip0 = repo.getOne("ipAddresses", "ip-0");
      ck(!!ip0 && ip0.address === "10.1.0.5" && !ip0.vm_id, "…mais elle EXISTE toujours, simplement détachée");
      let survivors = 0;
      for (let i = 0; i < clientPurge.ipCount; i++) if (repo.getOne("ipAddresses", "ip-" + i)) survivors++;
      ck.eq(survivors, clientPurge.ipCount, "les 20 adresses IP survivent toutes à la purge");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* nettoyage best effort (Windows) */ }
    }
  });

  /* ============ 6. VERROU : la règle de cascade dont dépend toute la purge ============ */

  await section("VmPurge : la cascade `vms` DÉTACHE les IP (verrou de la règle partagée)", async () => {
    // Tout le récapitulatif (« Z adresses IP seront détachées ») repose sur cette règle de
    // `src-shared/Cascade`. Si elle passait un jour en `delete`, la purge deviendrait destructrice
    // pour l'IPAM sans que rien d'autre ne rougisse — d'où ce verrou explicite, ici.
    const data = { vms: [{ id: "v1" }], ipAddresses: [{ id: "ip1", vm_id: "v1" }, { id: "ip2", vm_id: "v1" }] };
    const find = (c, f, v) => (data[c] || []).filter((r) => (Array.isArray(r[f]) ? r[f].includes(v) : r[f] === v));
    const fetch = (c, id) => (data[c] || []).find((r) => r.id === id) || null;
    const plan = Cascade.planMany([{ collection: "vms", id: "v1" }], find, fetch);
    ck.eq(plan.deletes.length, 0, "supprimer une VM n'entraîne AUCUNE suppression en cascade");
    ck.eq(plan.detaches.length, 2, "…mais DEUX détachements (une par adresse rattachée)");
    ck(plan.detaches.every((d) => d.c === "ipAddresses" && d.key === "vm_id" && d.value === null), "…qui remettent `ipAddresses.vm_id` à null");
    ck.eq(VmPurge.detachedIpCount(plan), 2, "le compteur du récapitulatif lit BIEN ce plan");
  });
};
