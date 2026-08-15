/* Tests modules — veilleur de GARANTIES serveur (module amovible `lifecycle/`, cadrage
   garantie-alerte 2026-08-15). Le veilleur est PUR (source/rapporteur/état de balayage/
   horloge INJECTÉS) : on l'éprouve avec des stubs — paliers (frontières PARTAGÉES
   src-shared/Lifecycle, jamais re-dérivées), clé stable UNE-par-équipement (amendement
   au § 4.4), anti-bruit du PREMIER balayage (raises silencieux + markSwept), escalade
   warn → err sur la MÊME clé, resolve différentiel, prune des documents supprimés.
   La persistance réelle du marqueur (LifecycleDb) est testée avec better-sqlite3 RÉEL.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, SERVER, SHARED } = require("./harness.js");

module.exports = async () => {
  await section("Serveur : WarrantyExpiryWatcher — paliers partagés, silencieux 1er balayage, escalade UNE clé, resolve différentiel, prune", async () => {
    const { WarrantyExpiryWatcher } = SERVER("lifecycle/WarrantyExpiryWatcher.js");
    const { Lifecycle } = SHARED("src-shared/Lifecycle.js");
    const DAY = 86400000;
    // Horloge CONTRÔLÉE, mutable (l'escalade warn → err se teste en AVANÇANT le temps).
    let nowMs = Date.parse("2026-08-15T12:00:00.000Z");
    const clock = () => new Date(nowMs);
    // Échéance ISO COURTE à J+n de l'horloge courante (même granularité « date seule » que warranty_end).
    const at = (days) => new Date(nowMs + days * DAY).toISOString().slice(0, 10);

    // Rapporteur stub : journal des appels (opts du raise CAPTURÉ — c'est lui qui porte le silencieux).
    const calls = [];
    const reporter = {
      raise: (key, event, opts) => calls.push({ op: "raise", key, event, opts }),
      resolve: (key) => calls.push({ op: "resolve", key }),
    };
    // États FACTICES en mémoire (contrats SweptState + RaisedState — la vraie persistance,
    // LifecycleDb, est testée dans la section suivante avec better-sqlite3 réel). PARTAGÉS
    // entre instances de veilleur : c'est ce qui permet de simuler un REDÉMARRAGE plus bas.
    const sweptSet = new Set();
    const swept = {
      isSwept: (id) => sweptSet.has(id),
      markSwept: (id) => sweptSet.add(id),
      prune: (ids) => { for (const id of [...sweptSet]) if (!ids.includes(id)) sweptSet.delete(id); },
    };
    const raisedSet = new Set();
    const raisedState = { all: () => [...raisedSet], add: (k) => raisedSet.add(k), remove: (k) => raisedSet.delete(k) };
    // Source stub : documents + parc mutables.
    const docIds = ["doc-A", "doc-B"];
    const parc = [];
    const source = { documentIds: () => docIds.slice(), sweep: () => parc.slice() };
    const watcher = new WarrantyExpiryWatcher(source, reporter, swept, raisedState, clock);

    // -- Clé stable : UNE par équipement (amendement au § 4.4 — JAMAIS de suffixe palier). --
    ck.eq(WarrantyExpiryWatcher.keyFor("doc-A", "equipments", "e1"), "warranty:doc-A:equipments:e1", "clé stable warranty:<docId>:<collection>:<id> (une clé par équipement, pas par palier)");
    ck.eq(WarrantyExpiryWatcher.keyFor("doc-A", "subEquipments", "s1"), "warranty:doc-A:subEquipments:s1", "…la collection distingue équipement et sous-équipement (ids indépendants)");

    // -- PREMIER balayage (aucun document encore balayé) : paliers + TOUT en silencieux. --
    parc.push(
      { doc_id: "doc-A", collection: "equipments", id: "loin", label: "Serveur neuf", warranty_end: at(91) },      // 91 j → ok → resolve
      { doc_id: "doc-A", collection: "equipments", id: "j90", label: "Switch J-90", warranty_end: at(90) },        // 90 j pile → warn (borne INCLUSIVE)
      { doc_id: "doc-A", collection: "equipments", id: "j0", label: "Routeur J-0", warranty_end: at(0) },          // jour même → warn (encore couvert)
      { doc_id: "doc-A", collection: "equipments", id: "mort", label: "NAS expiré", warranty_end: at(-1) },        // J-1 dépassé STRICT → err
      { doc_id: "doc-B", collection: "subEquipments", id: "drive", label: "Drive SAV", warranty_end: at(-400) },   // expiré de longue date → err
    );
    const bilan1 = watcher.scan();
    ck(bilan1.raised === 4 && bilan1.resolved === 1 && bilan1.silent === 4, "1re passe : 4 alertes levées (TOUTES silencieuses — aucun doc balayé), 1 clôture (hors seuil)  (obtenu " + JSON.stringify(bilan1) + ")");
    const byId = (id) => calls.find((c) => c.op === "raise" && c.key.endsWith(":" + id));
    ck.eq(byId("j90").event.severity, "warning", "J-90 pile → warning (borne inclusive du seuil partagé)");
    ck.eq(byId("j90").event.event_type, "warranty-expiring", "…type warranty-expiring (préavis)");
    ck.eq(byId("j0").event.severity, "warning", "J-0 (expire aujourd'hui) → warning, PAS error (la garantie couvre la journée — frontière partagée)");
    ck.eq(byId("mort").event.severity, "error", "J-1 dépassé strict → error");
    ck.eq(byId("mort").event.event_type, "warranty-expired", "…type warranty-expired (dépassement)");
    ck(/^Garantie expirée — NAS expiré$/.test(byId("mort").event.title), "titre expiré : « Garantie expirée — <nom> »");
    ck(/^Échéance de garantie — Switch J-90 \(J-90\)$/.test(byId("j90").event.title), "titre préavis : « Échéance de garantie — <nom> (J-n) »");
    ck(/de l'équipement « NAS expiré »/.test(byId("mort").event.body) && /a expiré le \d{4}-\d{2}-\d{2}/.test(byId("mort").event.body), "corps expiré : collection lisible + date AAAA-MM-JJ");
    ck(/du sous-équipement « Drive SAV »/.test(byId("drive").event.body), "corps : « sous-équipement » pour la collection subEquipments");
    ck(/depuis 400 jour/.test(byId("drive").event.body), "corps expiré : durée de dépassement en jours");
    ck.eq(byId("mort").event.doc_id, "doc-A", "doc_id porté sur l'événement");
    ck(calls.filter((c) => c.op === "raise").every((c) => c.opts && c.opts.silent === true), "1er balayage → TOUS les raise portent { silent: true } (anti-bruit § 4.6)");
    ck(calls.some((c) => c.op === "resolve" && c.key === "warranty:doc-A:equipments:loin"), "hors seuil (91 j) → resolve (no-op moteur si jamais levée)");
    ck(sweptSet.has("doc-A") && sweptSet.has("doc-B"), "fin de passe : les documents balayés sont MARQUÉS (doc-B aussi, même sans item equipments)");

    // -- Cohérence avec la règle PARTAGÉE : le veilleur décide comme l'affichage client. --
    const NOW = clock();
    ck.eq(Lifecycle.warrantyStatus(at(90), NOW), "warn", "verrou : Lifecycle.warrantyStatus(90 j) = warn — la frontière que le veilleur vient d'appliquer");
    ck.eq(Lifecycle.warrantyStatus(at(91), NOW), "ok", "verrou : 91 j = ok (le veilleur a résolu)");

    // -- Passe SUIVANTE (documents balayés) : mêmes items → raises NON silencieux. --
    calls.length = 0;
    const bilan2 = watcher.scan();
    ck(bilan2.raised === 4 && bilan2.silent === 0, "2e passe : raise re-signalés (idempotents côté moteur), plus AUCUN silencieux");
    ck(calls.filter((c) => c.op === "raise").every((c) => c.opts === undefined), "…docs balayés → aucun raise ne porte l'option silent");

    // -- NOUVELLE expiration sur un document DÉJÀ balayé : alerte SONORE (l'anti-bruit ne vaut que pour le 1er balayage). --
    calls.length = 0;
    parc.push({ doc_id: "doc-A", collection: "equipments", id: "nouveau", label: "Firewall", warranty_end: at(-3) });
    watcher.scan();
    const fresh = byId("nouveau");
    ck(fresh && fresh.opts === undefined && fresh.event.event_type === "warranty-expired", "nouvelle expiration sur un doc déjà balayé → raise NON silencieux (le moteur enverra immédiatement)");

    // -- ESCALADE warn → err : MÊME clé, jamais de resolve intermédiaire (amendement une-clé). --
    calls.length = 0;
    parc.push({ doc_id: "doc-A", collection: "equipments", id: "bascule", label: "Baie onduleur", warranty_end: at(1) });   // J+1 → warn
    watcher.scan();
    ck(byId("bascule").event.event_type === "warranty-expiring" && byId("bascule").event.severity === "warning", "veille de l'échéance (J+1) → préavis warning");
    const keyBascule = byId("bascule").key;
    calls.length = 0;
    nowMs += 2 * DAY;   // deux jours plus tard : l'échéance est STRICTEMENT dépassée
    watcher.scan();
    const escalated = byId("bascule");
    ck(escalated.key === keyBascule && escalated.event.event_type === "warranty-expired" && escalated.event.severity === "error", "escalade warn → err : MÊME clé, type et gravité rafraîchis sur la MÊME alerte");
    ck(!calls.some((c) => c.op === "resolve" && c.key === keyBascule), "…JAMAIS de resolve intermédiaire à l'escalade (une clé par palier aurait envoyé un « rétabli » mensonger)");

    // -- Garantie PROLONGÉE (date repoussée hors seuil) → resolve. --
    calls.length = 0;
    parc.find((c) => c.id === "bascule").warranty_end = at(400);
    watcher.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === keyBascule), "garantie prolongée (échéance repoussée) → alerte close");

    // -- Garantie RETIRÉE (champ vidé — statut null) → resolve, même si l'item reste au parc. --
    calls.length = 0;
    parc.find((c) => c.id === "mort").warranty_end = "";
    watcher.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === "warranty:doc-A:equipments:mort"), "garantie retirée (date vidée/illisible) → alerte close");
    parc.find((c) => c.id === "mort").warranty_end = at(-1);   // restaurée pour la suite

    // -- ÉQUIPEMENT DISPARU (supprimé → sort du balayage) : resolve via le jeu mémoire, UNE fois. --
    calls.length = 0;
    parc.splice(parc.findIndex((c) => c.id === "nouveau"), 1);
    watcher.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === "warranty:doc-A:equipments:nouveau"), "équipement disparu → alerte close (resolve différentiel des clés levées)");
    calls.length = 0;
    watcher.scan();
    ck.eq(calls.filter((c) => c.op === "resolve" && c.key === "warranty:doc-A:equipments:nouveau").length, 0, "…une seule fois (clé oubliée après clôture)");

    // -- DOCUMENT SUPPRIMÉ : resolve différentiel de ses clés + prune de son marqueur. --
    calls.length = 0;
    docIds.splice(docIds.indexOf("doc-B"), 1);
    parc.splice(parc.findIndex((c) => c.id === "drive"), 1);
    watcher.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === "warranty:doc-B:subEquipments:drive"), "document supprimé → ses alertes closes (différentiel)");
    ck(!sweptSet.has("doc-B") && sweptSet.has("doc-A"), "…et son marqueur « balayé » PURGÉ (prune) — doc-A conservé");

    // -- MIROIR PERSISTANT : l'état RaisedState reflète exactement les clés encore levées. --
    ck(raisedSet.has("warranty:doc-A:equipments:mort") && !raisedSet.has("warranty:doc-B:subEquipments:drive") && !raisedSet.has("warranty:doc-A:equipments:bascule"),
      "état persistant : les clés levées y sont, les clôturées (différentiel, prolongée) n'y sont plus");

    // -- REDÉMARRAGE simulé (le trou que la persistance colmate) : un item supprimé PENDANT
    //    L'EXTINCTION doit être résolu au premier scan du NOUVEAU processus. Un veilleur n°2,
    //    construit sur le MÊME état persistant (semence raisedState.all()), hérite des clés
    //    levées par le n°1 — sans cette semence, l'alerte de « mort » serait un ZOMBIE
    //    (active côté notify, jamais résolue, rappelée toutes les 12 h à vie). --
    parc.splice(parc.findIndex((c) => c.id === "mort"), 1);   // suppression « serveur éteint »
    calls.length = 0;
    const watcher2 = new WarrantyExpiryWatcher(source, reporter, swept, raisedState, clock);
    watcher2.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === "warranty:doc-A:equipments:mort"), "redémarrage : item supprimé serveur ÉTEINT → résolu au 1er scan du nouveau processus (semence persistante)");
    ck(!raisedSet.has("warranty:doc-A:equipments:mort"), "…et la clé quitte l'état persistant (clôture miroitée)");
    ck(calls.filter((c) => c.op === "raise").every((c) => c.opts === undefined), "…les items restants re-signalent en SONORE (documents déjà balayés — l'anti-bruit ne rejoue pas)");
  });

  await section("Serveur : LifecycleDb — états PERSISTANTS « document déjà balayé » (isSwept/markSwept/prune) + clés levées (all/add/remove), redémarrage", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section LifecycleDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { LifecycleDb } = SERVER("lifecycle/LifecycleDb.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-lifecycle-"));
    try {
      const db = new LifecycleDb(dir, Sqlite);   // Logger "error" par défaut → silencieux
      ck(fs.existsSync(path.join(dir, "lifecycle.db")), "lifecycle.db matérialisé dans le dossier injecté");

      ck.eq(db.isSwept("doc-A"), false, "isSwept avant tout balayage → false");
      db.markSwept("doc-A");
      db.markSwept("doc-B");
      ck.eq(db.isSwept("doc-A"), true, "markSwept → isSwept true");
      // Idempotence : re-marquer ne réécrit PAS first_swept_at (date du PREMIER balayage, jamais réécrite).
      const raw = new Sqlite(path.join(dir, "lifecycle.db"));
      const firstSeen = raw.prepare("SELECT first_swept_at FROM swept_docs WHERE doc_id='doc-A'").get().first_swept_at;
      db.markSwept("doc-A");
      ck.eq(raw.prepare("SELECT first_swept_at FROM swept_docs WHERE doc_id='doc-A'").get().first_swept_at, firstSeen, "markSwept idempotent : first_swept_at conservé (OR IGNORE)");
      raw.close();

      db.prune(["doc-A"]);
      ck(db.isSwept("doc-A") === true && db.isSwept("doc-B") === false, "prune : marqueur du document supprimé purgé, l'existant conservé");
      db.prune([]);
      ck.eq(db.isSwept("doc-A"), false, "prune([]) : plus aucun document connu → plus aucun marqueur");

      // -- RaisedState (raised_keys) : le jeu du resolve différentiel, persistant lui aussi. --
      ck.eq(db.all().length, 0, "raised_keys : vide au départ (all → [])");
      db.add("warranty:doc-A:equipments:e1");
      db.add("warranty:doc-A:subEquipments:s1");
      db.add("warranty:doc-A:equipments:e1");   // idempotent (OR IGNORE)
      ck.eq(db.all().sort().join("|"), "warranty:doc-A:equipments:e1|warranty:doc-A:subEquipments:s1", "add : clés mémorisées, ré-ajout idempotent (pas de doublon)");
      db.remove("warranty:doc-A:subEquipments:s1");
      ck.eq(db.all().join("|"), "warranty:doc-A:equipments:e1", "remove : clé clôturée oubliée");

      // PERSISTANCE : les DEUX états survivent à une réouverture (raison d'être de la base —
      // un redémarrage ne doit ni re-silencer un document déjà balayé, ni rater une expiration
      // serveur éteint, ni laisser une alerte ZOMBIE après une suppression serveur éteint).
      db.markSwept("doc-C");
      db.close();
      const db2 = new LifecycleDb(dir, Sqlite);
      ck.eq(db2.isSwept("doc-C"), true, "persistance : le marqueur « balayé » survit à la réouverture (redémarrage serveur)");
      ck.eq(db2.all().join("|"), "warranty:doc-A:equipments:e1", "persistance : les clés levées survivent aussi (semence du différentiel post-boot)");
      db2.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* nettoyage best-effort (Windows) */ }
    }
  });
};
