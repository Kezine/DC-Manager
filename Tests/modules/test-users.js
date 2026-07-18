/* Tests modules — ANNUAIRE UTILISATEURS (service CORE serveur, src-server/src/users/).
   - UserProfiles : logique PURE (clé canonique String(id)|login, normalisation fromSsoUser,
     caviardage redactFor soi-même/autrui, parseIdList dédup/plafond/ordre) — testée sans SQLite ;
   - AuthCacheUserResolver : capture (remember) → résolution, inconnu → dummy, en MÉMOIRE seule (db null) ;
   - UsersDb + réhydratation : snapshot users.db (upsert « dernier vu » + loadAll, nouvelle instance sur
     la MÊME base → profils retrouvés) — testé avec better-sqlite3 RÉEL (driver injecté), comme les autres DB. */
"use strict";
const { ck, section, path, SERVER, D } = require("./harness.js");

module.exports = async () => {
  const { UserProfiles } = SERVER("users/UserProfiles.js");
  const { AuthCacheUserResolver } = SERVER("users/AuthCacheUserResolver.js");
  const { UserDirectory } = D("core/UserDirectory.js");   // annuaire CLIENT (règle d'affichage pure + coalescence batch)

  await section("Serveur : users — UserProfiles.canonicalId & fromSsoUser (normalisation, repli login, champs vides)", async () => {
    // -- canonicalId : String(id) si présent (0 compris), sinon login, sinon "". --
    ck.eq(UserProfiles.canonicalId({ id: 42, login: "amartin" }), "42", "canonicalId : id numérique → String(id) (prioritaire sur login)");
    ck.eq(UserProfiles.canonicalId({ login: "amartin" }), "amartin", "canonicalId : id absent → repli login");
    ck.eq(UserProfiles.canonicalId({ id: 0, login: "x" }), "0", "canonicalId : id 0 (numérique valide) → « 0 »");
    ck.eq(UserProfiles.canonicalId({ id: "  ", login: "y" }), "y", "canonicalId : id blanc → repli login");
    ck.eq(UserProfiles.canonicalId({}), "", "canonicalId : ni id ni login → chaîne vide");
    ck.eq(UserProfiles.canonicalId(null), "", "canonicalId : null → chaîne vide (pas de throw)");

    // -- fromSsoUser : id numérique → string ; mapping prenom/nom/eMail ; champs manquants → "". --
    const full = UserProfiles.fromSsoUser({ id: 42, login: "amartin", prenom: "Alice", nom: "Martin", eMail: "alice@corp.tld", domain: "corp" });
    ck.eq(full.id, "42", "fromSsoUser : id numérique → string");
    ck.eq(full.firstname, "Alice", "fromSsoUser : prenom → firstname");
    ck.eq(full.lastname, "Martin", "fromSsoUser : nom → lastname");
    ck.eq(full.email, "alice@corp.tld", "fromSsoUser : eMail → email");
    ck.eq(full.domain, "corp", "fromSsoUser : domain conservé");
    ck.eq(full.phone, "", "fromSsoUser : phone TOUJOURS vide en v1 (le SSO ne le fournit pas)");

    const loginOnly = UserProfiles.fromSsoUser({ login: "  bob  " });
    ck.eq(loginOnly.id, "bob", "fromSsoUser : sans id → id = login (trimé)");
    ck.eq(loginOnly.login, "bob", "fromSsoUser : login trimé");
    ck.eq(loginOnly.firstname, "", "fromSsoUser : champs manquants → chaîne vide (firstname)");
    ck.eq(loginOnly.email, "", "fromSsoUser : champs manquants → chaîne vide (email)");

    const empty = UserProfiles.fromSsoUser(null);
    ck(empty.id === "" && empty.login === "" && empty.lastname === "" && empty.phone === "", "fromSsoUser(null) → profil tout vide (pas de throw)");
  });

  await section("Serveur : users — UserProfiles.redactFor (soi-même complet / autrui caviardé) & parseIdList (dédup, plafond, ordre)", async () => {
    // -- redactFor : email/phone visibles UNIQUEMENT pour l'appelant (son propre id). --
    const alice = { id: "42", login: "amartin", domain: "corp", firstname: "Alice", lastname: "Martin", email: "alice@corp.tld", phone: "0600" };
    const self = UserProfiles.redactFor("42", alice);
    ck(self.email === "alice@corp.tld" && self.phone === "0600", "redactFor : soi-même → email/téléphone conservés");
    const other = UserProfiles.redactFor("99", alice);
    ck(other.email === "" && other.phone === "", "redactFor : autrui → email/téléphone VIDÉS");
    ck(other.firstname === "Alice" && other.lastname === "Martin" && other.login === "amartin", "redactFor : autrui → nom/prénom/login toujours visibles");
    const bothEmpty = UserProfiles.redactFor("", { id: "", login: "", domain: "", firstname: "", lastname: "", email: "x@y", phone: "1" });
    ck(bothEmpty.email === "" && bothEmpty.phone === "", "redactFor : id appelant vide ≠ « soi » d'un id vide (jamais de fuite)");

    // -- parseIdList : trim, ignore vides, DÉDUP, ORDRE de 1re apparition, PLAFOND. --
    ck.eq(UserProfiles.parseIdList(undefined, 200).length, 0, "parseIdList : absent → []");
    ck.eq(JSON.stringify(UserProfiles.parseIdList("a", 200)), JSON.stringify(["a"]), "parseIdList : chaîne unique → [a] (param répétable Express)");
    ck.eq(JSON.stringify(UserProfiles.parseIdList(["a", "b", "a", "", "  ", "c"], 200)), JSON.stringify(["a", "b", "c"]), "parseIdList : dédup + vides ignorés + ordre conservé");
    ck.eq(JSON.stringify(UserProfiles.parseIdList([" a ", "a"], 200)), JSON.stringify(["a"]), "parseIdList : trim AVANT dédup");
    ck.eq(JSON.stringify(UserProfiles.parseIdList(["c", "a", "b"], 200)), JSON.stringify(["c", "a", "b"]), "parseIdList : ORDRE de la requête préservé");
    ck.eq(JSON.stringify(UserProfiles.parseIdList(["a", "b", "c"], 2)), JSON.stringify(["a", "b"]), "parseIdList : plafond appliqué (cap 2)");
  });

  await section("Serveur : users — AuthCacheUserResolver capture→resolve, inconnu→dummy, ordre du batch (mémoire seule, sans SQLite)", async () => {
    const resolver = new AuthCacheUserResolver(null);   // db null → annuaire en mémoire seule (sans snapshot)

    // Capture d'un profil authentifié (comme le ferait Auth.remember) puis résolution.
    resolver.remember({ id: 42, login: "amartin", prenom: "Alice", nom: "Martin", eMail: "alice@corp.tld", domain: "corp" });
    const [alice] = await resolver.resolve(["42"]);
    ck(alice.id === "42" && alice.firstname === "Alice" && alice.email === "alice@corp.tld", "capture → resolve : profil restitué (clé = String(id))");

    // Id INCONNU → dummy (id conservé, champs vides).
    const [ghost] = await resolver.resolve(["999"]);
    ck(ghost.id === "999" && ghost.login === "" && ghost.firstname === "", "id inconnu → dummy (id conservé, champs vides)");

    // Batch : ORDRE préservé, correspondance positionnelle, connu + inconnu mélangés.
    const batch = await resolver.resolve(["999", "42"]);
    ck.eq(batch.map((u) => u.id).join(","), "999,42", "resolve batch : ordre de la requête préservé");
    ck(batch[0].firstname === "" && batch[1].firstname === "Alice", "resolve batch : dummy puis profil, aux bonnes positions");

    // Capture par LOGIN seul (mode basic/dev : pas d'id) → clé = login.
    resolver.remember({ login: "bob" });
    const [bob] = await resolver.resolve(["bob"]);
    ck(bob.id === "bob" && bob.login === "bob", "capture sans id → clé = login (mode basic/dev)");

    // Profil sans clé (ni id ni login) → IGNORÉ (rien à mémoriser, pas de throw).
    resolver.remember({});
    ck.eq((await resolver.resolve([""]))[0].id, "", "profil sans clé ignoré ; resolve('') → dummy id vide");

    // Dernier profil VU conservé (mise à jour en mémoire).
    resolver.remember({ id: 42, login: "amartin", prenom: "Alice", nom: "Martin-Dupont", eMail: "alice2@corp.tld", domain: "corp" });
    ck.eq((await resolver.resolve(["42"]))[0].lastname, "Martin-Dupont", "re-capture → dernier profil vu (mémoire) mis à jour");
  });

  await section("Serveur : users — snapshot UsersDb (upsert « dernier vu » + réhydratation) — better-sqlite3 RÉEL", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB serveur.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section snapshot users sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { UsersDb } = SERVER("users/UsersDb.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-users-"));
    try {
      // -- SCHÉMA : fichier matérialisé + table users_seen. --
      const db = new UsersDb(dir, Sqlite);   // Logger "error" par défaut → silencieux
      ck(fs.existsSync(path.join(dir, "users.db")), "users.db matérialisé dans le dossier injecté");
      const raw = new Sqlite(path.join(dir, "users.db"));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      ck(tables.includes("users_seen"), "schéma : table users_seen créée");
      raw.close();

      // -- UPSERT + loadAll : profils relus. --
      db.upsert({ id: "42", login: "amartin", domain: "corp", firstname: "Alice", lastname: "Martin", email: "alice@corp.tld", phone: "" });
      db.upsert({ id: "7", login: "bob", domain: "", firstname: "", lastname: "", email: "", phone: "" });
      const all = db.loadAll();
      ck.eq(all.length, 2, "loadAll : 2 profils enregistrés");
      const aliceRow = all.find((u) => u.id === "42");
      ck(aliceRow && aliceRow.firstname === "Alice" && aliceRow.email === "alice@corp.tld", "loadAll : profil complet relu");

      // -- UPSERT même id → « dernier profil vu » (pas de doublon). --
      db.upsert({ id: "42", login: "amartin", domain: "corp", firstname: "Alice", lastname: "Martin-Dupont", email: "alice2@corp.tld", phone: "" });
      const all2 = db.loadAll();
      ck.eq(all2.length, 2, "upsert même id → pas de doublon (PK id)");
      ck.eq(all2.find((u) => u.id === "42").lastname, "Martin-Dupont", "upsert même id → dernier profil vu conservé");
      db.close();

      // -- RÉHYDRATATION : nouvelle instance de resolver sur la MÊME base → profils retrouvés. --
      const db2 = new UsersDb(dir, Sqlite);
      const resolver = new AuthCacheUserResolver(db2);
      const [alice2] = await resolver.resolve(["42"]);
      ck.eq(alice2.lastname, "Martin-Dupont", "resolver réhydraté depuis le snapshot (profil retrouvé après « redémarrage »)");
      const [ghost] = await resolver.resolve(["inconnu"]);
      ck.eq(ghost.id, "inconnu", "resolver réhydraté : id absent du snapshot → dummy");

      // -- CAPTURE → persistance : un profil capturé survit à une NOUVELLE instance. --
      resolver.remember({ id: 100, login: "carol", prenom: "Carol", nom: "Nguyen", eMail: "carol@corp.tld", domain: "corp" });
      db2.close();
      const db3 = new UsersDb(dir, Sqlite);
      const carol = db3.loadAll().find((u) => u.id === "100");
      ck(carol && carol.firstname === "Carol" && carol.email === "carol@corp.tld", "capture via resolver → écrite dans le snapshot (relue par une nouvelle instance)");
      db3.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* handle SQLite éventuellement ouvert (dossier temp) */ }
    }
  });

  await section("Client : UserDirectory.displayOf — règle d'affichage PURE (Prénom Nom / login / id brut)", async () => {
    const mk = (o) => Object.assign({ id: "", login: "", domain: "", firstname: "", lastname: "", email: "", phone: "" }, o);
    // « Prénom Nom » prioritaire.
    ck.eq(UserDirectory.displayOf(mk({ firstname: "Alice", lastname: "Martin", login: "amartin" }), "42"), "Alice Martin", "displayOf : prénom + nom");
    ck.eq(UserDirectory.displayOf(mk({ firstname: "Alice", login: "amartin" }), "42"), "Alice", "displayOf : prénom seul (nom manquant)");
    ck.eq(UserDirectory.displayOf(mk({ lastname: "Martin", login: "amartin" }), "42"), "Martin", "displayOf : nom seul (prénom manquant)");
    // Repli login quand aucun nom.
    ck.eq(UserDirectory.displayOf(mk({ login: "amartin" }), "42"), "amartin", "displayOf : login en repli (aucun nom)");
    ck.eq(UserDirectory.displayOf(mk({ login: "  amartin  " }), "42"), "amartin", "displayOf : login trimé");
    // Repli id brut quand ni nom ni login (couvre le legacy « nom en clair » et l'inconnu).
    ck.eq(UserDirectory.displayOf(mk({}), "42"), "42", "displayOf : dummy → id brut");
    ck.eq(UserDirectory.displayOf(undefined, "Jean Legacy"), "Jean Legacy", "displayOf : profil absent → id brut (legacy nom en clair tel quel)");
    ck.eq(UserDirectory.displayOf(undefined, "42"), "42", "displayOf : inconnu → id brut");
  });

  await section("Client : UserDirectory.ensure — coalescence en UNE requête batch + cache (pas de re-requête)", async () => {
    const mk = (id, o) => Object.assign({ id, login: "", domain: "", firstname: "", lastname: "", email: "", phone: "" }, o || {});
    let calls = [];
    const stub = { resolveUsers: async (ids) => { calls.push(ids.slice()); return ids.map((id) => id === "u1" ? mk("u1", { firstname: "Jean", lastname: "Dupont" }) : mk(id)); } };
    const dir = new UserDirectory(stub);

    // display() AVANT résolution → id brut (cache vide).
    ck.eq(dir.display("u1"), "u1", "display avant ensure → id brut");
    ck.eq(dir.display(""), "", "display('') → chaîne vide");

    // Deux ensure() dans le MÊME tick → UNE seule requête batch (coalescence micro-tâche), union des ids.
    calls = [];
    await Promise.all([dir.ensure(["u1"]), dir.ensure(["u2"])]);
    ck.eq(calls.length, 1, "ensure ×2 (même tick) → UNE requête batch");
    ck.eq(calls[0].slice().sort().join(","), "u1,u2", "batch : union des ids demandés");
    ck.eq(dir.display("u1"), "Jean Dupont", "après ensure : u1 résolu (Prénom Nom)");
    ck.eq(dir.display("u2"), "u2", "après ensure : u2 sans nom ni login → id brut");
    ck.eq(dir.has("u1"), true, "has : u1 en cache");

    // Ids DÉJÀ en cache → aucune nouvelle requête.
    calls = [];
    await dir.ensure(["u1", "u2"]);
    ck.eq(calls.length, 0, "ensure d'ids déjà en cache → aucune requête");

    // ensure([]) / que des vides → no-op immédiat.
    calls = [];
    await dir.ensure(["", "  "]);
    ck.eq(calls.length, 0, "ensure d'ids vides → aucune requête");
  });

  await section("Client : UserDirectory — échec réseau non bloquant (id brut conservé, réessai possible)", async () => {
    let attempts = 0;
    const stub = { resolveUsers: async () => { attempts++; throw new Error("réseau"); } };
    const dir = new UserDirectory(stub);
    await dir.ensure(["u1"]);   // ne rejette PAS (badge/fiche non critiques)
    ck.eq(dir.display("u1"), "u1", "échec réseau → id brut conservé (pas de cache pourri)");
    ck.eq(dir.has("u1"), false, "échec réseau → id NON caché (réessai possible)");
    await dir.ensure(["u1"]);   // nouvelle tentative (l'id n'a pas été caché)
    ck.eq(attempts, 2, "échec → l'id reste redemandable (2e tentative effectuée)");
  });
};
