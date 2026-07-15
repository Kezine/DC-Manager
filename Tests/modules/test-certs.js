/* Tests modules — CERTIFICATS (PKI zéro-connaissance) : crypto CLIENT pure
   (PkiCrypto : dérivation PBKDF2 + keycheck + chiffrement AES-GCM — WebCrypto,
   disponible dans Node ≥ 18) et coffre de session (PkiSession : verrouillage
   auto/manuel, timers injectés). Les sections serveur (CertsDb) vivent dans
   test-server.js ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  await section("Certs : CertsFormat — échéances colorées, arbre CA/dérivés, libellés de kind (logique PURE)", async () => {
  {
    const { CertsFormat } = D("core/CertsFormat.js");
    const DAY = 86400000;
    const now = Date.parse("2026-07-14T00:00:00Z");   // horloge INJECTÉE → tests déterministes
    const iso = (ms) => new Date(now + ms).toISOString();

    // -- daysUntil : plancher, expiré négatif, null si absent/illisible --
    ck.eq(CertsFormat.daysUntil(null, now), null, "daysUntil : pas de date → null");
    ck.eq(CertsFormat.daysUntil("", now), null, "daysUntil : chaîne vide → null");
    ck.eq(CertsFormat.daysUntil("pas-une-date", now), null, "daysUntil : date illisible → null");
    ck.eq(CertsFormat.daysUntil(iso(45 * DAY), now), 45, "daysUntil : +45 j → 45");
    ck.eq(CertsFormat.daysUntil(iso(-3 * DAY), now), -3, "daysUntil : expiré il y a 3 j → -3");
    ck.eq(CertsFormat.daysUntil(iso(12 * 3600000), now), 0, "daysUntil : dans 12 h → 0 (arrondi plancher)");

    // -- expiryClass : seuils 30/7 (cadrage §5) --
    ck.eq(CertsFormat.expiryClass(null, now), "none", "class : sans date → none");
    ck.eq(CertsFormat.expiryClass(iso(60 * DAY), now), "ok", "class : > 30 j → ok");
    ck.eq(CertsFormat.expiryClass(iso(31 * DAY), now), "ok", "class : 31 j → ok");
    ck.eq(CertsFormat.expiryClass(iso(30 * DAY), now), "warn", "class : 30 j → warn (seuil inclus)");
    ck.eq(CertsFormat.expiryClass(iso(8 * DAY), now), "warn", "class : 8 j → warn");
    ck.eq(CertsFormat.expiryClass(iso(7 * DAY), now), "err", "class : 7 j → err (seuil inclus)");
    ck.eq(CertsFormat.expiryClass(iso(-1 * DAY), now), "err", "class : expiré → err");
    ck.eq(CertsFormat.WARN_DAYS, 30, "seuil warn = 30 j");
    ck.eq(CertsFormat.CRIT_DAYS, 7, "seuil critique = 7 j");

    // -- expiryLabel : formulation française --
    ck.eq(CertsFormat.expiryLabel(null, now), "—", "label : sans date → —");
    ck.eq(CertsFormat.expiryLabel(iso(45 * DAY), now), "dans 45 jours", "label : futur (pluriel)");
    ck.eq(CertsFormat.expiryLabel(iso(1 * DAY), now), "dans 1 jour", "label : futur (singulier)");
    ck.eq(CertsFormat.expiryLabel(iso(12 * 3600000), now), "expire aujourd'hui", "label : ≤ 24 h → aujourd'hui");
    ck.eq(CertsFormat.expiryLabel(iso(-3 * DAY), now), "expiré (il y a 3 j)", "label : expiré");

    // -- kindLabel : libellés des familles + repli --
    ck.eq(CertsFormat.kindLabel("root-ca"), "CA racine X.509", "kind : root-ca");
    ck.eq(CertsFormat.kindLabel("leaf-tls"), "Certificat TLS", "kind : leaf-tls");
    ck.eq(CertsFormat.kindLabel("ssh-ca"), "CA SSH", "kind : ssh-ca");
    ck.eq(CertsFormat.kindLabel("ssh-keypair"), "Paire SSH", "kind : ssh-keypair");
    ck.eq(CertsFormat.kindLabel("ssh-cert"), "Certificat SSH", "kind : ssh-cert");
    ck.eq(CertsFormat.kindLabel("inconnu"), "inconnu", "kind : inconnu → valeur brute (repli)");

    // -- issuerLabel / shortId : libellé de l'émetteur RÉSOLU depuis les items de la page (colonne « Émetteur »
    //    de la vue B) ; repli sur l'id COURT si le parent n'est pas dans la page (listing paginé serveur). --
    const pageItems = [{ id: "root", label: "CA Racine exemple" }, { id: "leaf", label: "hote.exemple.test" }];
    ck.eq(CertsFormat.issuerLabel("root", pageItems), "CA Racine exemple", "issuerLabel : parent présent dans la page → son libellé");
    ck.eq(CertsFormat.issuerLabel(null, pageItems), "—", "issuerLabel : sans parent (null) → —");
    ck.eq(CertsFormat.issuerLabel("", pageItems), "—", "issuerLabel : parent vide → —");
    ck.eq(CertsFormat.issuerLabel("absent-de-la-page-xyz", pageItems), "absent-d…", "issuerLabel : parent hors page → id court (limite assumée)");
    ck.eq(CertsFormat.issuerLabel("root", []), "root", "issuerLabel : liste vide, id court → id tel quel (≤ 10 c)");
    ck.eq(CertsFormat.shortId("court"), "court", "shortId : id ≤ 10 c laissé tel quel");
    ck.eq(CertsFormat.shortId("0123456789abcdef"), "01234567…", "shortId : id long → 8 premiers + …");
    ck.eq(CertsFormat.shortId(""), "", "shortId : chaîne vide → vide (robustesse)");
  }
  });

  await section("Certs : CertsClient — construction de la query string de listing (kind répétable, encodage)", async () => {
  {
    const { CertsClient } = D("views/forms/CertsClient.js");
    ck.eq(CertsClient.buildQuery({}), "", "buildQuery : aucun paramètre → chaîne vide");
    ck.eq(CertsClient.buildQuery({ page: 2, pageSize: 25 }), "?page=2&pageSize=25", "buildQuery : page + pageSize");
    // kind RÉPÉTABLE : plusieurs paramètres `kind=` (JAMAIS « kind=a,b » — contrat serveur).
    ck.eq(CertsClient.buildQuery({ kinds: ["root-ca", "ssh-ca"] }), "?kind=root-ca&kind=ssh-ca", "buildQuery : kinds → kind répété (kind=a&kind=b)");
    ck.eq(CertsClient.buildQuery({ status: "active", sort: "not_after", dir: "desc" }), "?status=active&sort=not_after&dir=desc", "buildQuery : status/sort/dir");
    ck.eq(CertsClient.buildQuery({ root: "r1", kinds: [] }), "?root=r1", "buildQuery : kinds vide → aucun kind ; root présent");
    ck.eq(CertsClient.buildQuery({ focus: "c9" }), "?focus=c9", "buildQuery : focus (préparé pour la recherche L3)");
    // query encodée par URLSearchParams (espace → « + » ou « %20 » selon l'implémentation).
    const q = CertsClient.buildQuery({ query: "a b" });
    ck(q === "?query=a+b" || q === "?query=a%20b", "buildQuery : query encodée (espace échappé)");
  }
  });

  await section("Certs : CertsSearch — mapping d'un résultat + décision de navigation (logique PURE, L3)", async () => {
  {
    const { CertsSearch } = D("core/CertsSearch.js");

    // -- toResult : id/label conservés ; tag = famille LISIBLE (CertsFormat.kindLabel) ; data = item d'origine --
    const leaf = { id: "c1", label: "hote.exemple.test", kind: "leaf-tls", root_id: "root1" };
    const r = CertsSearch.toResult(leaf);
    ck.eq(r.id, "c1", "toResult : id conservé");
    ck.eq(r.label, "hote.exemple.test", "toResult : label conservé");
    ck.eq(r.tag, "Certificat TLS", "toResult : tag = kindLabel(leaf-tls)");
    ck.eq(r.data, leaf, "toResult : data = item d'origine (réutilisé au clic)");
    ck.eq(CertsSearch.toResult({ id: "x", label: "L", kind: "root-ca", root_id: null }).tag, "CA racine X.509", "toResult : tag d'une racine");
    ck.eq(CertsSearch.toResult({ id: "x", label: "L", kind: "inconnu", root_id: null }).tag, "inconnu", "toResult : tag repli sur le kind brut (inconnu)");

    // -- navTarget : PREMIER NIVEAU (root_id null) → vue A « racines », focus sur l'élément lui-même --
    const navRoot = CertsSearch.navTarget({ id: "r1", label: "CA", kind: "root-ca", root_id: null });
    ck.eq(navRoot.view, "roots", "navTarget : root_id null → vue A (racines)");
    ck.eq(navRoot.rootId, null, "navTarget : vue A → aucun scope racine");
    ck.eq(navRoot.focus, "r1", "navTarget : vue A → focus sur l'élément lui-même");

    // -- navTarget : DÉRIVÉ (root_id posé) → vue B scopée sur SA racine, focus sur le dérivé --
    const navLeaf = CertsSearch.navTarget(leaf);
    ck.eq(navLeaf.view, "certs", "navTarget : root_id posé → vue B (sous-arbre de la racine)");
    ck.eq(navLeaf.rootId, "root1", "navTarget : vue B → scope sur SA racine (root_id)");
    ck.eq(navLeaf.focus, "c1", "navTarget : vue B → focus sur le dérivé");

    // -- root_id vide ("") = absent (robustesse) → vue A --
    ck.eq(CertsSearch.navTarget({ id: "z", label: "Z", kind: "ssh-keypair", root_id: "" }).view, "roots", "navTarget : root_id vide → vue A (robustesse)");
  }
  });

  await section("Certs : CertDeployGuide — aide au déploiement de la confiance (blocs pré-remplis, logique PURE)", async () => {
  {
    const { CertDeployGuide } = D("core/CertDeployGuide.js");

    // -- CA racine X.509 : 3 sections Linux/Windows/Android + nom de fichier injecté dans les commandes --
    const FILE = "CA Racine interne.crt";
    const g = CertDeployGuide.forRootCa(FILE);
    ck.eq(g.sections.length, 3, "root-ca : 3 sections");
    ck.eq(g.sections.map((s) => s.title).join(","), "Linux,Windows,Android", "root-ca : sections Linux/Windows/Android dans l'ordre");
    const introText = g.intro.join(" ");
    ck(g.intro.length >= 1 && /clé privée/i.test(introText) && /public/i.test(introText), "root-ca : intro rappelle « public déployé / clé privée jamais »");

    const allCmds = g.sections.flatMap((s) => s.commands.map((c) => c.command));
    const cmdText = allCmds.join("\n");
    ck(allCmds.every((c) => typeof c === "string" && c !== "" && c.indexOf("\u0000") < 0), "root-ca : aucune commande vide ni octet NUL");
    ck(cmdText.indexOf("/usr/local/share/ca-certificates/") >= 0 && cmdText.indexOf("update-ca-certificates") >= 0, "root-ca : Debian cp + update-ca-certificates");
    ck(cmdText.indexOf("/etc/pki/ca-trust/source/anchors/") >= 0 && cmdText.indexOf("update-ca-trust") >= 0, "root-ca : RHEL cp + update-ca-trust");
    ck(cmdText.indexOf("certutil -addstore -f Root") >= 0, "root-ca : Windows certutil -addstore Root");
    ck(cmdText.indexOf("Cert:\\LocalMachine\\Root") >= 0, "root-ca : PowerShell Cert:\\LocalMachine\\Root (chemin exact, magasin machine)");
    ck(cmdText.indexOf("openssl verify -CAfile") >= 0, "root-ca : commande de vérification openssl");
    // nom de fichier injecté dans les commandes qui l'utilisent (cp Debian, cp RHEL, certutil, Import-Certificate)
    const usingFile = allCmds.filter((c) => c.indexOf(FILE) >= 0);
    ck(usingFile.length >= 4, "root-ca : le nom de fichier est injecté dans ≥ 4 commandes");

    // -- Caveats (notes) : Firefox/NSS + Java keytool + Node + Python + GPO --
    const notesText = g.sections.flatMap((s) => s.notes || []).join("\n");
    ck(/security\.enterprise_roots\.enabled/.test(notesText), "root-ca : caveat Firefox/NSS (enterprise_roots)");
    ck(/keytool -importcert/.test(notesText) && notesText.indexOf(FILE) >= 0, "root-ca : caveat Java keytool avec le fichier");
    ck(/NODE_EXTRA_CA_CERTS/.test(notesText), "root-ca : caveat Node NODE_EXTRA_CA_CERTS");
    ck(/REQUESTS_CA_BUNDLE/.test(notesText), "root-ca : caveat Python REQUESTS_CA_BUNDLE");
    ck(/GPO/.test(notesText), "root-ca : note GPO (parc en domaine)");

    // -- Android : purement graphique (aucune commande) mais caveat Android 7 (applis) présent --
    const android = g.sections.find((s) => s.title === "Android");
    ck.eq(android.commands.length, 0, "root-ca : Android sans bloc de commande (installation graphique)");
    ck(/Android 7/.test((android.notes || []).join("\n")), "root-ca : caveat Android 7 (applis ≠ CA utilisateur)");

    // -- CA SSH : variante courte, ligne publique injectée, domaine d'exemple fictif --
    const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI ca-ssh@interne";
    const s = CertDeployGuide.forSshCa(PUB);
    ck.eq(s.sections.length, 2, "ssh-ca : 2 sections (serveurs / clients)");
    const sshCmds = s.sections.flatMap((sec) => sec.commands.map((c) => c.command));
    const sshText = sshCmds.join("\n");
    ck(sshText.indexOf("TrustedUserCAKeys /etc/ssh/ca.pub") >= 0, "ssh-ca : sshd_config TrustedUserCAKeys (certificats utilisateur)");
    ck(sshText.indexOf("@cert-authority *.exemple.lan " + PUB) >= 0, "ssh-ca : known_hosts @cert-authority avec la ligne publique (certificats hôte)");
    ck(sshCmds.some((c) => c === PUB), "ssh-ca : bloc « contenu de ca.pub » = ligne publique de la CA");
    ck(sshText.indexOf("exemple.lan") >= 0 && !/example\.|exemple\.com/.test(sshText), "ssh-ca : domaine d'exemple fictif (exemple.lan)");
    // repli robuste : ligne publique vide → placeholder, jamais d'exception --
    ck.eq(CertDeployGuide.forSshCa("").sections.length, 2, "ssh-ca : ligne publique vide tolérée (placeholder)");
  }
  });

  await section("Certs : PkiCrypto — dérivation PBKDF2, keycheck, chiffrement AES-GCM (WebCrypto)", async () => {
  {
    const { PkiCrypto } = D("certs/PkiCrypto.js");
    // WebCrypto requis (Node ≥ 18) — sinon section sautée avec un constat explicite.
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section PkiCrypto sautée"); return; }

    // Contrats GRAVÉS (décision Q1) — le serveur valide le plancher, le client initialise à cette valeur.
    ck.eq(PkiCrypto.DEFAULT_ITERS, 600000, "itérations par défaut = 600000 (décision Q1)");
    ck.eq(PkiCrypto.KDF_VERSION, "v1", "schéma versionné « v1 » (rotation d'algo possible)");
    // Détection de disponibilité (contexte non sécurisé → crypto.subtle absent dans le navigateur) :
    // l'UI s'appuie dessus pour un bandeau actionnable ; ici WebCrypto est présent → true.
    ck.eq(PkiCrypto.available(), true, "available() : WebCrypto détecté (le cas absent = bandeau UI, non simulable proprement sous Node)");

    const salt = PkiCrypto.generateSaltB64();
    ck(/^[A-Za-z0-9+/]+={0,2}$/.test(salt) && atob(salt).length === 16, "sel : base64 de 16 octets");
    ck(PkiCrypto.generateSaltB64() !== salt, "sel aléatoire (deux tirages diffèrent)");

    // Itérations RÉDUITES en test : le plancher 600 000 est un contrat SERVEUR (validé côté
    // CertsValidate) ; la dérivation est identique quelle que soit la valeur — on ne fait pas
    // attendre la suite de tests pour rien.
    const ITERS = 10000;
    const key = await PkiCrypto.deriveKey("passphrase-maitre-de-test", salt, ITERS);
    ck.eq(key.extractable, false, "clé dérivée NON extractible (ne quitte jamais le moteur WebCrypto)");

    // Keycheck : bonne passphrase → true ; tout échec → false (JAMAIS de throw — même réponse UI).
    const keycheck = await PkiCrypto.makeKeycheck(key);
    ck(/^v1:/.test(keycheck), "keycheck au format v1:<iv>:<ct>");
    ck.eq(await PkiCrypto.verifyKeycheck(key, keycheck), true, "keycheck : bonne clé → true");
    const wrong = await PkiCrypto.deriveKey("mauvaise-passphrase", salt, ITERS);
    ck.eq(await PkiCrypto.verifyKeycheck(wrong, keycheck), false, "keycheck : mauvaise passphrase → false (détection immédiate, sans serveur)");
    ck.eq(await PkiCrypto.verifyKeycheck(key, "n-importe-quoi"), false, "keycheck : blob illisible → false (pas de throw)");
    // Même passphrase mais AUTRE sel → autre clé (le sel PAR document compartimente les PKI).
    const sameButOtherSalt = await PkiCrypto.deriveKey("passphrase-maitre-de-test", PkiCrypto.generateSaltB64(), ITERS);
    ck.eq(await PkiCrypto.verifyKeycheck(sameButOtherSalt, keycheck), false, "même passphrase, autre sel → autre clé (sel par document)");

    // Chiffrement des clés privées : aller-retour, IV aléatoire, refus explicites sans fuite.
    const pem = "-----BEGIN PRIVATE KEY-----exemple-----END PRIVATE KEY-----";
    const enc = await PkiCrypto.encryptSecret(key, pem);
    ck(/^v1:/.test(enc) && !enc.includes("exemple"), "chiffré au format v1:…, le clair n'apparaît pas");
    ck.eq(await PkiCrypto.decryptSecret(key, enc), pem, "déchiffrement → clair d'origine");
    ck((await PkiCrypto.encryptSecret(key, pem)) !== enc, "IV aléatoire → deux chiffrements du même clair diffèrent");
    let wrongKeyErr = null;
    try { await PkiCrypto.decryptSecret(wrong, enc); } catch (e) { wrongKeyErr = e.message; }
    ck(!!wrongKeyErr && /refusé/.test(wrongKeyErr) && !wrongKeyErr.includes("exemple"), "clé différente → erreur explicite, aucun contenu divulgué");
    const tampered = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
    let alt = false;
    try { await PkiCrypto.decryptSecret(key, tampered); } catch (_) { alt = true; }
    ck(alt, "blob altéré → déchiffrement refusé (GCM authentifié)");
    let badFmt = false;
    try { await PkiCrypto.decryptSecret(key, "v9:a:b"); } catch (_) { badFmt = true; }
    ck(badFmt, "format de version inconnue → erreur explicite");
    let emptyPass = false;
    try { await PkiCrypto.deriveKey("", salt, ITERS); } catch (_) { emptyPass = true; }
    ck(emptyPass, "passphrase vide → refusée");
  }
  });

  await section("Certs : PkiSession — coffre de session (auto-verrouillage 15 min, touch, lock manuel)", async () => {
  {
    const { PkiSession } = D("certs/PkiSession.js");
    // Timers SIMULÉS : on capture les planifications, on déclenche l'échéance à la main.
    const mkTimers = () => {
      const slots = new Map(); let seq = 0;
      return {
        schedule: (fn, ms) => { const id = ++seq; slots.set(id, { fn, ms }); return id; },
        cancel: (id) => { slots.delete(id); },
        fire: (id) => { const slot = slots.get(id); if (slot) { slots.delete(id); slot.fn(); } },
        slots,
        last: () => seq,
      };
    };
    const fakeKey = { type: "secret" }; // la session ne regarde JAMAIS dans la clé — un objet opaque suffit

    ck.eq(PkiSession.AUTO_LOCK_MS, 15 * 60 * 1000, "délai d'auto-verrouillage = 15 min (décision Q2)");

    {
      const timers = mkTimers(); const locks = [];
      const session = new PkiSession({ onLock: () => locks.push(1), schedule: timers.schedule, cancel: timers.cancel });
      ck.eq(session.unlocked, false, "état initial : verrouillée");
      let threw = false; try { void session.key; } catch (_) { threw = true; }
      ck(threw, "accès à la clé d'une session verrouillée → exception explicite");
      session.unlock(fakeKey);
      ck(session.unlocked && session.key === fakeKey, "unlock → clé accessible");
      const armed = timers.last();
      ck(timers.slots.has(armed) && timers.slots.get(armed).ms === 15 * 60 * 1000, "…compte à rebours d'inactivité armé à 15 min");
      // touch : l'ancien timer est annulé, un nouveau part (inactivité repartie de zéro).
      session.touch();
      ck(!timers.slots.has(armed) && timers.slots.has(timers.last()), "touch → timer ré-armé (activité utilisateur)");
      // Échéance atteinte → verrouillage AUTO + notification UI.
      timers.fire(timers.last());
      ck(session.unlocked === false && locks.length === 1, "échéance d'inactivité → session verrouillée + onLock notifié");
      session.touch();
      ck.eq(timers.slots.size, 0, "touch sur session verrouillée → aucun ré-armement fantôme");
    }
    {
      const timers = mkTimers(); const locks = [];
      const session = new PkiSession({ onLock: () => locks.push(1), schedule: timers.schedule, cancel: timers.cancel });
      session.unlock(fakeKey);
      session.lock();
      ck(session.unlocked === false && locks.length === 1 && timers.slots.size === 0, "lock manuel → clé oubliée, timer annulé, onLock notifié");
      session.lock();
      ck.eq(locks.length, 1, "lock répété → no-op (pas de double notification)");
      session.unlock(fakeKey);
      ck(session.unlocked && timers.slots.size === 1, "re-unlock après lock → session réutilisable, timer ré-armé");
    }
  }
  });

  await section("Certs : X509Factory — CA racine auto-signée + feuilles signées (@peculiar/x509)", async () => {
  {
    const { X509Factory } = D("certs/X509Factory.js");
    // WebCrypto requis (Node ≥ 18/20) — sinon section sautée, comme PkiCrypto.
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section X509Factory sautée"); return; }
    // @peculiar/x509 se require depuis node_modules racine ; c'est le MÊME singleton
    // (même résolution) que celui qu'utilise le module compilé — le provider crypto
    // que X509Factory enregistre à la première génération vaut donc aussi pour verify().
    const x509 = require("@peculiar/x509");
    const FP_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/; // SHA-256 = 32 octets → « AA:…:ZZ »
    const spanMs = (c) => Date.parse(c.notAfter) - Date.parse(c.notBefore);

    /* -------- Racine EC P-256 : forme, auto-signature, extensions -------- */
    const ca = await X509Factory.createRootCa({ commonName: "CA Racine exemple", organization: "Exemple SA", keyAlgo: "ec-p256", days: 365 });
    ck(/-----BEGIN CERTIFICATE-----/.test(ca.certPem) && /-----END CERTIFICATE-----/.test(ca.certPem), "racine : certificat PEM bien formé");
    ck(/-----BEGIN PRIVATE KEY-----/.test(ca.privateKeyPkcs8Pem), "racine : clé privée PKCS#8 PEM exportée");
    ck(FP_RE.test(ca.fingerprintSha256), "racine : empreinte SHA-256 « AA:BB:… » majuscule");
    ck(/^[0-9a-f]+$/i.test(ca.serial) && ca.serial.length >= 2, "racine : numéro de série hexadécimal");
    // Fenêtre ≈ 365 j + 5 min de tolérance d'horloge → on borne large (10 min).
    ck(Math.abs(spanMs(ca) - 365 * 86400000) <= 10 * 60000, "racine : validité ≈ days (notAfter − notBefore)");

    const caCert = new x509.X509Certificate(ca.certPem);
    ck.eq(await caCert.verify({ publicKey: caCert.publicKey, signatureOnly: true }), true, "racine : auto-signature vérifiée (sa propre clé publique)");
    const caBasic = caCert.getExtension(x509.BasicConstraintsExtension);
    ck(!!caBasic && caBasic.ca === true, "racine : BasicConstraints CA=true");
    const caKu = caCert.getExtension(x509.KeyUsagesExtension);
    ck(!!caKu && (caKu.usages & x509.KeyUsageFlags.keyCertSign) !== 0 && (caKu.usages & x509.KeyUsageFlags.cRLSign) !== 0, "racine : KeyUsage keyCertSign + cRLSign");
    const caSki = caCert.getExtension(x509.SubjectKeyIdentifierExtension);
    ck(!!caSki && typeof caSki.keyId === "string" && caSki.keyId.length > 0, "racine : SubjectKeyIdentifier présent");

    /* -------- Feuille EC signée par la CA : chaîne, extensions, SAN -------- */
    const leaf = await X509Factory.issueLeaf({
      caCertPem: ca.certPem, caPrivateKeyPkcs8Pem: ca.privateKeyPkcs8Pem,
      commonName: "hote.exemple.test", keyAlgo: "ec-p256", days: 90,
      sans: [{ san_type: "dns", value: "hote.exemple.test" }, { san_type: "ip", value: "10.0.0.5" }],
      usage: "server",
    });
    const leafCert = new x509.X509Certificate(leaf.certPem);
    ck.eq(await leafCert.verify({ publicKey: caCert.publicKey, signatureOnly: true }), true, "feuille : signée par la CA (vérifiée avec la clé publique CA)");
    const leafBasic = leafCert.getExtension(x509.BasicConstraintsExtension);
    ck(!!leafBasic && leafBasic.ca === false, "feuille : BasicConstraints CA=false");
    const leafEku = leafCert.getExtension(x509.ExtendedKeyUsageExtension);
    ck(!!leafEku && leafEku.usages.includes(x509.ExtendedKeyUsage.serverAuth), "feuille (server) : ExtendedKeyUsage serverAuth");
    const sanJson = leafCert.getExtension(x509.SubjectAlternativeNameExtension).names.toJSON();
    ck(sanJson.some((e) => e.type === "dns" && e.value === "hote.exemple.test"), "feuille : SAN dns présent");
    ck(sanJson.some((e) => e.type === "ip"), "feuille : SAN ip présent");
    const leafAki = leafCert.getExtension(x509.AuthorityKeyIdentifierExtension);
    ck(!!leafAki && leafAki.keyId === caSki.keyId, "feuille : AuthorityKeyIdentifier = SubjectKeyIdentifier de la CA");

    /* -------- Usages client / both -------- */
    const leafClient = await X509Factory.issueLeaf({
      caCertPem: ca.certPem, caPrivateKeyPkcs8Pem: ca.privateKeyPkcs8Pem,
      commonName: "client.exemple.test", keyAlgo: "ec-p256", days: 90,
      sans: [{ san_type: "email", value: "poste@exemple.test" }], usage: "client",
    });
    const ekuClient = new x509.X509Certificate(leafClient.certPem).getExtension(x509.ExtendedKeyUsageExtension).usages;
    ck(ekuClient.includes(x509.ExtendedKeyUsage.clientAuth) && !ekuClient.includes(x509.ExtendedKeyUsage.serverAuth), "usage « client » → clientAuth seul");
    const leafBoth = await X509Factory.issueLeaf({
      caCertPem: ca.certPem, caPrivateKeyPkcs8Pem: ca.privateKeyPkcs8Pem,
      commonName: "mixte.exemple.test", keyAlgo: "ec-p256", days: 90,
      sans: [{ san_type: "dns", value: "mixte.exemple.test" }], usage: "both",
    });
    const ekuBoth = new x509.X509Certificate(leafBoth.certPem).getExtension(x509.ExtendedKeyUsageExtension).usages;
    ck(ekuBoth.includes(x509.ExtendedKeyUsage.serverAuth) && ekuBoth.includes(x509.ExtendedKeyUsage.clientAuth), "usage « both » → serverAuth + clientAuth");

    /* -------- Roundtrip PKCS#8 : la clé privée PEM se ré-importe via WebCrypto -------- */
    const der = x509.PemConverter.decodeFirst(leaf.privateKeyPkcs8Pem);
    const reimported = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    ck.eq(reimported.type, "private", "PKCS#8 : clé privée ré-importable via WebCrypto (importKey)");

    /* -------- Passe RSA-2048 complète (plus lente, une seule) -------- */
    const rsaCa = await X509Factory.createRootCa({ commonName: "CA RSA exemple", keyAlgo: "rsa-2048", days: 365 });
    const rsaCaCert = new x509.X509Certificate(rsaCa.certPem);
    ck.eq(await rsaCaCert.verify({ publicKey: rsaCaCert.publicKey, signatureOnly: true }), true, "rsa-2048 : racine auto-signée vérifiée");
    const rsaLeaf = await X509Factory.issueLeaf({
      caCertPem: rsaCa.certPem, caPrivateKeyPkcs8Pem: rsaCa.privateKeyPkcs8Pem,
      commonName: "rsa.exemple.test", keyAlgo: "rsa-2048", days: 90,
      sans: [{ san_type: "dns", value: "rsa.exemple.test" }],
    });
    ck.eq(await new x509.X509Certificate(rsaLeaf.certPem).verify({ publicKey: rsaCaCert.publicKey, signatureOnly: true }), true, "rsa-2048 : feuille signée par la CA vérifiée");

    /* -------- Deux racines successives → séries différentes (aléa) -------- */
    const caBis = await X509Factory.createRootCa({ commonName: "CA Racine bis", keyAlgo: "ec-p256", days: 1 });
    ck(ca.serial !== caBis.serial, "deux racines successives → numéros de série différents");

    /* -------- Erreurs en français (garde-fous d'entrée) -------- */
    let daysErr = null;
    try { await X509Factory.createRootCa({ commonName: "X", keyAlgo: "ec-p256", days: 0 }); } catch (e) { daysErr = e.message; }
    ck(!!daysErr && /jours|positif/i.test(daysErr), "racine : durée ≤ 0 refusée (message français)");
    let cnErr = null;
    try { await X509Factory.createRootCa({ commonName: "   ", keyAlgo: "ec-p256", days: 30 }); } catch (e) { cnErr = e.message; }
    ck(!!cnErr && /requis/i.test(cnErr), "racine : nom commun vide refusé (message français)");
  }
  });

  /* ==========================================================================
     ENCODEUR OpenSSH (tâche C4) — SshWire / OpenSshEncoder / SshKeyMaterial.

     FIXTURES CROISÉES ssh-keygen (OpenSSH_9.0p1, client Windows intégré). Générées
     UNE FOIS avec des paramètres FIXES, embarquées ici avec les commandes exactes :

       ssh-keygen -t ed25519 -f ed25519_test -N "" -C "utilisateur-test@exemple.test"
       ssh-keygen -t rsa -b 2048 -f rsa_test -N "" -C "utilisateur-test@exemple.test"
       ssh-keygen -t ed25519 -f ca_test -N "" -C "ca@exemple.test"
       ssh-keygen -s ca_test -I test-identity -n utilisateur-test -z 12345 \
                  -V 20260101000000:20270101000000 ed25519_test.pub

     ed25519 étant DÉTERMINISTE, mêmes entrées + même nonce + même graine CA ⇒
     sortie BYTE-IDENTIQUE à ssh-keygen : la validation croisée la plus forte.
     Le mini-décodeur wire ci-dessous est LOCAL au test (le module livré est un
     ENCODEUR) ; il sert à extraire le matériau des fixtures pour le ré-encoder. */

  // --- Fixtures (lignes .pub complètes ; corps base64 des fichiers privés openssh-key-v1) ---
  const ED25519_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJM8zggc7vzTDOqkUX2RHns24/hQyhyuULOLKB8v7+8Y utilisateur-test@exemple.test";
  const RSA_PUB = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCz+nzd2dwMEOn1fBvhzRw/jGN9xvOr65vv60/g7RcN9tiwj5HWWxxrjlMoN8QrfvR9uk9h+iVeLYkaCbP4gC0OcpkO/g/j/WvZI+KBzBdIYIdw8rb2Ievkgu+eLgH1fjFvLT74TZNscMRQiu2YM5cCgj7RExTgKrSebju7MpD2e4M7SJCwsbjIBjgKu/sbMI7qGB9idA541YSlHhdB9p288zNcmUFKsNHiiWaoZtp+SsVzxd9Nnl9a3Z6M9WGtA0YZ62L1Td+dQhmDPHxsVyyKpyeMASIymC3HLoS3yvfa3LlLb/xwo8am18+JdhGdzbNis6+NPhLOx4GJE0AHZibb utilisateur-test@exemple.test";
  const CERT_LINE = "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIMSW9C/9h5w9EVtMb0NKxxyt8baO1sTszcy4HhiRci6yAAAAIJM8zggc7vzTDOqkUX2RHns24/hQyhyuULOLKB8v7+8YAAAAAAAAMDkAAAABAAAADXRlc3QtaWRlbnRpdHkAAAAUAAAAEHV0aWxpc2F0ZXVyLXRlc3QAAAAAaVWq8AAAAABrNt5wAAAAAAAAAIIAAAAVcGVybWl0LVgxMS1mb3J3YXJkaW5nAAAAAAAAABdwZXJtaXQtYWdlbnQtZm9yd2FyZGluZwAAAAAAAAAWcGVybWl0LXBvcnQtZm9yd2FyZGluZwAAAAAAAAAKcGVybWl0LXB0eQAAAAAAAAAOcGVybWl0LXVzZXItcmMAAAAAAAAAAAAAADMAAAALc3NoLWVkMjU1MTkAAAAgD9pmtepWHm9s9bs/kzDdVVLNhgw/JmdvIlVhtnzStQoAAABTAAAAC3NzaC1lZDI1NTE5AAAAQD6NlmMnv8i+JdIWVefyLO8v3iCyWg6XK9VXFUNNPzSoqTZ0lxTrikxhByqNkpF5KkzjWgugpZBppccOUFZF1QE= utilisateur-test@exemple.test";
  // Corps base64 (une seule ligne) des fichiers privés — l'encodeur reproduit l'emballage PEM (70 c/ligne).
  const ED25519_PRIV_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACCTPM4IHO780wzqpFF9kR57NuP4UMocrlCziygfL+/vGAAAAKAugzI3LoMyNwAAAAtzc2gtZWQyNTUxOQAAACCTPM4IHO780wzqpFF9kR57NuP4UMocrlCziygfL+/vGAAAAEBymvg9ImK5BLVyS0ox+Zr4lwSMGZ5m3fnVOC+cgEEh7JM8zggc7vzTDOqkUX2RHns24/hQyhyuULOLKB8v7+8YAAAAHXV0aWxpc2F0ZXVyLXRlc3RAZXhlbXBsZS50ZXN0";
  const CA_PRIV_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACAP2ma16lYeb2z1uz+TMN1VUs2GDD8mZ28iVWG2fNK1CgAAAJg/A37KPwN+ygAAAAtzc2gtZWQyNTUxOQAAACAP2ma16lYeb2z1uz+TMN1VUs2GDD8mZ28iVWG2fNK1CgAAAED9SGqW3FQ3GLcmCN6f4jZ9TvisoYxSdcIDGGLAXJW2Aw/aZrXqVh5vbPW7P5Mw3VVSzYYMPyZnbyJVYbZ80rUKAAAAD2NhQGV4ZW1wbGUudGVzdAECAwQFBg==";

  // --- Mini-décodeur wire LOCAL au test (Buffer autorisé DANS les tests) ---
  const b64Bytes = (b64) => Buffer.from(b64, "base64");
  const pemBytes = (pem) => Buffer.from(pem.split(/\r?\n/).filter((l) => l && !l.startsWith("-----")).join(""), "base64");
  const mkReader = (buf) => {
    let offset = 0;
    return {
      u32() { const v = buf.readUInt32BE(offset); offset += 4; return v; },
      u64() { const hi = buf.readUInt32BE(offset); const lo = buf.readUInt32BE(offset + 4); offset += 8; return hi * 4294967296 + lo; },
      str() { const n = this.u32(); const s = buf.subarray(offset, offset + n); offset += n; return s; },
      get done() { return offset >= buf.length; },
    };
  };
  const stripLead = (bytes) => { const u = Buffer.from(bytes); let i = 0; while (i < u.length && u[i] === 0) i++; return u.subarray(i); };
  // Reconstruit le PEM openssh-key-v1 attendu depuis le corps base64 (70 caractères/ligne, comme ssh-keygen).
  const wrapPem = (body) => {
    const lines = [];
    for (let i = 0; i < body.length; i += 70) lines.push(body.slice(i, i + 70));
    return "-----BEGIN OPENSSH PRIVATE KEY-----\n" + lines.join("\n") + "\n-----END OPENSSH PRIVATE KEY-----\n";
  };
  // Extrait checkint/graine/publique/commentaire d'un fichier privé openssh-key-v1 ed25519.
  const parseEd25519Priv = (body) => {
    const r = mkReader(b64Bytes(body).subarray(15)); // saute le magic (15 o = "openssh-key-v1" + NUL)
    r.str(); r.str(); r.str(); r.u32();              // ciphername, kdfname, kdfoptions, nkeys
    r.str();                                          // blob public
    const priv = mkReader(r.str());
    const checkint = priv.u32(); priv.u32();          // checkint1 == checkint2
    priv.str();                                       // "ssh-ed25519"
    const pub = priv.str();
    const sk = priv.str();                            // 64 o = graine(32) || publique(32)
    const comment = priv.str().toString("utf8");
    return { checkint, pub: new Uint8Array(pub), seed: new Uint8Array(sk.subarray(0, 32)), comment };
  };
  // Décode un certificat SSH ed25519 en ses champs.
  const parseCert = (b64) => {
    const blob = b64Bytes(b64);
    const r = mkReader(blob);
    const type = r.str().toString("utf8");
    const nonce = r.str();
    const subjectPub = r.str();
    const serial = r.u64();
    const typeCode = r.u32();
    const keyId = r.str().toString("utf8");
    const pr = mkReader(r.str()); const principals = [];
    while (!pr.done) principals.push(pr.str().toString("utf8"));
    const validAfter = r.u64(); const validBefore = r.u64();
    r.str();                                          // options critiques
    const er = mkReader(r.str()); const extensions = [];
    while (!er.done) { const name = er.str().toString("utf8"); er.str(); extensions.push(name); }
    r.str();                                          // reserved
    const sk = mkReader(r.str()); sk.str(); const caPub = sk.str();
    return { blob, type, nonce: new Uint8Array(nonce), subjectPub: new Uint8Array(subjectPub), serial, typeCode, keyId, principals, validAfter, validBefore, extensions, caPub: new Uint8Array(caPub) };
  };

  await section("Certs : SshWire — primitives wire SSH (uint32/uint64/string/mpint zéro de tête, base64)", async () => {
  {
    const { SshWire } = D("certs/SshWire.js");
    const eq = (bytes, expected, name) => ck(Buffer.from(bytes).equals(Buffer.from(expected)), name);

    eq(new SshWire().uint32(0x01020304).build(), [1, 2, 3, 4], "uint32 : gros-boutiste (0x01020304 → 01 02 03 04)");
    eq(new SshWire().uint64(1).build(), [0, 0, 0, 0, 0, 0, 0, 1], "uint64 : 1 → 8 octets gros-boutistes");
    eq(new SshWire().uint64(0x0102030405n).build(), [0, 0, 0, 1, 2, 3, 4, 5], "uint64 : accepte un bigint");
    eq(new SshWire().string(new Uint8Array([0xaa, 0xbb])).build(), [0, 0, 0, 2, 0xaa, 0xbb], "string : uint32 de longueur + octets");
    eq(new SshWire().cstring("abc").build(), [0, 0, 0, 3, 97, 98, 99], "cstring : texte UTF-8 préfixé de sa longueur");

    // mpint — règle du zéro de tête (entier SIGNÉ)
    eq(new SshWire().mpint(new Uint8Array([0x7f])).build(), [0, 0, 0, 1, 0x7f], "mpint : bit haut à 0 → pas de zéro de tête");
    eq(new SshWire().mpint(new Uint8Array([0x80])).build(), [0, 0, 0, 2, 0x00, 0x80], "mpint : bit haut à 1 → zéro de tête préfixé (reste positif)");
    eq(new SshWire().mpint(new Uint8Array([0x00, 0x00, 0x12])).build(), [0, 0, 0, 1, 0x12], "mpint : zéros de tête superflus retirés (minimal)");
    eq(new SshWire().mpint(new Uint8Array([0x00, 0x00])).build(), [0, 0, 0, 0], "mpint : valeur nulle → mpint vide");
    eq(new SshWire().mpint(new Uint8Array([0x00, 0xb3, 0x00])).build(), [0, 0, 0, 3, 0x00, 0xb3, 0x00], "mpint : module RSA (0x00 0xb3 …) → zéro de tête reposé");

    eq(SshWire.concat(new Uint8Array([1, 2]), new Uint8Array([3])), [1, 2, 3], "concat : plusieurs tampons en un");
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    eq(SshWire.fromBase64(SshWire.toBase64(bytes)), Array.from(bytes), "base64 : aller-retour toBase64/fromBase64");

    let err = null; try { new SshWire().uint32(-1); } catch (e) { err = e.message; }
    ck(!!err && /uint32|bornes/i.test(err), "uint32 hors bornes → erreur explicite");
  }
  });

  await section("Certs : OpenSshEncoder — clés publiques authorized_keys (fixtures croisées ssh-keygen)", async () => {
  {
    const { OpenSshEncoder } = D("certs/OpenSshEncoder.js");

    // ed25519 : décoder la .pub fixture (base64 → wire) puis RE-ENCODER → ligne IDENTIQUE.
    const er = mkReader(b64Bytes(ED25519_PUB.split(" ")[1])); er.str(); const edPub = new Uint8Array(er.str());
    ck.eq(OpenSshEncoder.ed25519PublicKeyLine(edPub, ED25519_PUB.split(" ")[2]), ED25519_PUB, "ed25519 : ligne authorized_keys IDENTIQUE à ssh-keygen");

    // rsa : décoder e/n (mpint) puis RE-ENCODER → ligne IDENTIQUE (règle du zéro de tête sur n).
    const rr = mkReader(b64Bytes(RSA_PUB.split(" ")[1])); rr.str(); const rsaE = new Uint8Array(rr.str()); const rsaN = new Uint8Array(rr.str());
    ck.eq(OpenSshEncoder.rsaPublicKeyLine(rsaN, rsaE, RSA_PUB.split(" ")[2]), RSA_PUB, "rsa : ligne authorized_keys IDENTIQUE à ssh-keygen");

    // Sans commentaire : pas d'espace superflu en fin.
    const noComment = OpenSshEncoder.ed25519PublicKeyLine(edPub);
    ck(noComment === "ssh-ed25519 " + ED25519_PUB.split(" ")[1] && !noComment.endsWith(" "), "ligne sans commentaire : aucun espace en fin");

    let lenErr = null; try { OpenSshEncoder.ed25519PublicKeyBlob(new Uint8Array(16)); } catch (e) { lenErr = e.message; }
    ck(!!lenErr && /32 octets/.test(lenErr), "clé publique ed25519 de mauvaise taille refusée (message français)");
  }
  });

  await section("Certs : OpenSshEncoder — clé privée openssh-key-v1 (fixtures croisées, byte-identiques)", async () => {
  {
    const { OpenSshEncoder } = D("certs/OpenSshEncoder.js");

    // Cas SANS padding (le bloc privé est déjà aligné) : PEM BYTE-IDENTIQUE.
    const edMat = parseEd25519Priv(ED25519_PRIV_BODY);
    const producedEd = OpenSshEncoder.ed25519PrivateKey({ seed: edMat.seed, publicKey: edMat.pub, comment: edMat.comment, checkint: edMat.checkint });
    ck.eq(producedEd, wrapPem(ED25519_PRIV_BODY), "clé privée ed25519 : PEM BYTE-IDENTIQUE à ssh-keygen (sans padding)");

    // Cas AVEC padding séquentiel 1..6 (CA) : valide l'alignement sur la taille de bloc.
    const caMat = parseEd25519Priv(CA_PRIV_BODY);
    const producedCa = OpenSshEncoder.ed25519PrivateKey({ seed: caMat.seed, publicKey: caMat.pub, comment: caMat.comment, checkint: caMat.checkint });
    ck.eq(producedCa, wrapPem(CA_PRIV_BODY), "clé privée ed25519 : PEM BYTE-IDENTIQUE (avec padding séquentiel 1..6)");

    // Le magic « openssh-key-v1 » est bien terminé par un OCTET NUL.
    const decoded = pemBytes(producedEd);
    ck(decoded[13] === 0x31 /* '1' */ && decoded[14] === 0x00, "magic openssh-key-v1 terminé par un octet NUL (jamais brut en source)");

    // checkint aléatoire par défaut → deux exports diffèrent (champ non déterministe).
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      const a = OpenSshEncoder.ed25519PrivateKey({ seed: edMat.seed, publicKey: edMat.pub, comment: edMat.comment });
      const b = OpenSshEncoder.ed25519PrivateKey({ seed: edMat.seed, publicKey: edMat.pub, comment: edMat.comment });
      ck(a !== b, "checkint aléatoire par défaut → deux exports diffèrent");
    }

    let seedErr = null; try { OpenSshEncoder.ed25519PrivateKey({ seed: new Uint8Array(10), publicKey: edMat.pub }); } catch (e) { seedErr = e.message; }
    ck(!!seedErr && /graine|32/i.test(seedErr), "graine de mauvaise taille refusée (message français)");
  }
  });

  await section("Certs : OpenSshEncoder — certificat SSH signé (fixture croisée, signature ed25519 déterministe)", async () => {
  {
    const { OpenSshEncoder } = D("certs/OpenSshEncoder.js");
    const { SshKeyMaterial } = D("certs/SshKeyMaterial.js");
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section certificat SSH sautée"); return; }

    // Décoder le cert fixture + extraire la graine de la CA, puis RE-ÉMETTRE avec les MÊMES champs.
    const cf = parseCert(CERT_LINE.split(" ")[1]);
    const caMat = parseEd25519Priv(CA_PRIV_BODY);
    const caKey = await SshKeyMaterial.importEd25519PrivateForSigning(caMat.seed);
    const base = {
      subjectPublicKey: cf.subjectPub, serial: cf.serial, type: "user", keyId: cf.keyId,
      principals: cf.principals, validAfter: cf.validAfter, validBefore: cf.validBefore,
      caPublicKey: cf.caPub, caPrivateKey: caKey,
    };
    const res = await OpenSshEncoder.certificate({ ...base, comment: CERT_LINE.split(" ")[2], nonce: cf.nonce });
    ck.eq(res.base64, CERT_LINE.split(" ")[1], "certificat : base64 IDENTIQUE à ssh-keygen (signature ed25519 déterministe)");
    ck.eq(res.line, CERT_LINE, "certificat : ligne complète IDENTIQUE à ssh-keygen");

    // Extensions user : les 5 permit-* en ordre CANONIQUE trié.
    const parsedUser = parseCert(res.base64);
    ck.eq(parsedUser.extensions.join(","), "permit-X11-forwarding,permit-agent-forwarding,permit-port-forwarding,permit-pty,permit-user-rc", "cert user : 5 extensions permit-* triées");
    ck.eq(parsedUser.typeCode, 1, "cert user : code type = 1");

    // Certificat HÔTE : aucune extension, code type 2.
    const hostRes = await OpenSshEncoder.certificate({ ...base, type: "host", keyId: "hote.exemple.test", principals: ["hote.exemple.test"], nonce: new Uint8Array(32) });
    const parsedHost = parseCert(hostRes.base64);
    ck.eq(parsedHost.typeCode, 2, "cert host : code type = 2");
    ck.eq(parsedHost.extensions.length, 0, "cert host : aucune extension");

    // Nonce INJECTABLE : même nonce → sortie identique ; nonce différent → sortie différente.
    const n1 = new Uint8Array(32).fill(1);
    const c1 = await OpenSshEncoder.certificate({ ...base, nonce: n1 });
    const c1bis = await OpenSshEncoder.certificate({ ...base, nonce: n1 });
    ck.eq(c1.base64, c1bis.base64, "cert : même nonce + même clé → sortie déterministe identique");
    const c2 = await OpenSshEncoder.certificate({ ...base, nonce: new Uint8Array(32).fill(2) });
    ck(c2.base64 !== c1.base64, "cert : nonce différent → sortie différente");

    let idErr = null; try { await OpenSshEncoder.certificate({ ...base, keyId: "  " }); } catch (e) { idErr = e.message; }
    ck(!!idErr && /keyId|identifiant/i.test(idErr), "cert : keyId vide refusé (message français)");
    let keyLenErr = null; try { await OpenSshEncoder.certificate({ ...base, subjectPublicKey: new Uint8Array(10) }); } catch (e) { keyLenErr = e.message; }
    ck(!!keyLenErr && /32 octets/.test(keyLenErr), "cert : clé sujet de mauvaise taille refusée (message français)");
  }
  });

  await section("Certs : SshKeyMaterial — interop WebCrypto (raw pub, graine ed25519, n/e RSA depuis JWK)", async () => {
  {
    const { SshKeyMaterial } = D("certs/SshKeyMaterial.js");
    const { OpenSshEncoder } = D("certs/OpenSshEncoder.js");
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section SshKeyMaterial sautée"); return; }

    // ed25519 : export raw (32 o) + extraction de graine (32 derniers octets du PKCS#8).
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const rawPub = await SshKeyMaterial.ed25519PublicRaw(kp.publicKey);
    ck.eq(rawPub.length, 32, "ed25519PublicRaw : 32 octets");
    const seed = await SshKeyMaterial.ed25519Seed(kp.privateKey);
    ck.eq(seed.length, 32, "ed25519Seed : 32 octets (32 derniers du PKCS#8)");

    // Aller-retour : graine → clé signable → signature VÉRIFIÉE par la publique d'origine.
    const signer = await SshKeyMaterial.importEd25519PrivateForSigning(seed);
    const msg = new TextEncoder().encode("message-de-test");
    const sig = await crypto.subtle.sign("Ed25519", signer, msg);
    ck.eq(await crypto.subtle.verify("Ed25519", kp.publicKey, sig, msg), true, "graine reconstruite → signature vérifiée par la clé publique d'origine");

    // RSA : n/e depuis JWK → ré-encodage wire ré-décodable et cohérent.
    const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const { modulus, exponent } = await SshKeyMaterial.rsaPublicParts(rsa.publicKey);
    ck(modulus.length >= 32 && exponent.length >= 1, "rsaPublicParts : module et exposant extraits du JWK");
    const rr = mkReader(Buffer.from(OpenSshEncoder.rsaPublicKeyBlob(modulus, exponent)));
    ck.eq(rr.str().toString("utf8"), "ssh-rsa", "rsaPublicKeyBlob : type wire ssh-rsa");
    const eDec = rr.str(); const nDec = rr.str();
    ck(stripLead(eDec).equals(stripLead(exponent)), "rsaPublicKeyBlob : exposant e conservé (au zéro de tête près)");
    ck(stripLead(nDec).equals(stripLead(modulus)), "rsaPublicKeyBlob : module n conservé (au zéro de tête près)");

    let seedErr = null; try { await SshKeyMaterial.importEd25519PrivateForSigning(new Uint8Array(10)); } catch (e) { seedErr = e.message; }
    ck(!!seedErr && /graine|32/i.test(seedErr), "importEd25519PrivateForSigning : graine invalide refusée (message français)");
  }
  });

  /* ==========================================================================
     EXPORTS CLIENT (tâche C5) — CertExports / Pkcs12Kdf / Pkcs12Builder.
     Assemblage PUR des artefacts d'export (PEM/fullchain/ca-chain, OpenSSH, PKCS#12)
     après déverrouillage : rien de déchiffré ne transite vers le serveur. Le PKCS#12
     est VALIDÉ CROISÉ avec openssl (section sautée proprement si le binaire manque). */

  await section("Certs : CertExports — chaîne d'émission, fullchain/ca-chain, PEM, révocation", async () => {
  {
    const { CertExports } = D("certs/CertExports.js");
    const mkCert = (id, parent, body, extra) => Object.assign(
      { id, label: id, parent_id: parent, public_pem: "-----BEGIN CERTIFICATE-----\n" + body + "\n-----END CERTIFICATE-----\n", revoked_at: null }, extra || {});

    // Arbre synthétique à 3 NIVEAUX : racine → intermédiaire → feuille (la résolution
    // doit marcher sur N niveaux, même si la v1 métier n'a que racine→feuilles).
    const root = mkCert("root", null, "ROOT", { label: "CA Racine exemple" });
    const inter = mkCert("inter", "root", "INTER", { label: "CA Intermediaire exemple" });
    // La feuille porte des CRLF pour éprouver la NORMALISATION LF.
    const leaf = { id: "leaf", label: "hote.exemple.test", parent_id: "inter",
      public_pem: "-----BEGIN CERTIFICATE-----\r\nLEAF\r\n-----END CERTIFICATE-----\r\n", revoked_at: null };
    const all = [root, inter, leaf];

    const chain = CertExports.resolveIssuerChain(leaf, all);
    ck.eq(chain.map((c) => c.id).join(","), "leaf,inter,root", "chaîne remontée feuille→intermédiaire→racine, ordonnée");

    const fc = CertExports.pemFullchain(leaf, all);
    ck.eq(fc.filename, "hote.exemple.test.fullchain.pem", "fullchain : nom de fichier dérivé du label");
    ck(fc.content.indexOf("LEAF") >= 0 && fc.content.indexOf("LEAF") < fc.content.indexOf("INTER") && fc.content.indexOf("INTER") < fc.content.indexOf("ROOT"),
      "fullchain : feuille puis intermédiaire puis racine (ordre remonté)");
    ck(!fc.content.includes("\r"), "fullchain : fins de ligne normalisées LF (aucun CR)");

    const ca = CertExports.pemCaChain(leaf, all);
    ck.eq(ca.filename, "hote.exemple.test.ca-chain.pem", "ca-chain : nom de fichier");
    ck(!ca.content.includes("LEAF") && ca.content.includes("INTER") && ca.content.includes("ROOT"), "ca-chain : émetteurs seuls (SANS la feuille)");

    let rootCaErr = null; try { CertExports.pemCaChain(root, all); } catch (e) { rootCaErr = e.message; }
    ck(!!rootCaErr && /(racine|émetteur)/i.test(rootCaErr), "ca-chain d'une racine → refus explicite (pas d'émetteur)");

    const pem = CertExports.pemCertificate(leaf);
    ck.eq(pem.filename, "hote.exemple.test.pem", "pemCertificate : nom de fichier <label>.pem");
    ck(!pem.content.includes("\r") && /BEGIN CERTIFICATE/.test(pem.content), "pemCertificate : PEM public normalisé LF");

    const key = CertExports.pemPrivateKey("hote.exemple.test", "-----BEGIN PRIVATE KEY-----\r\nAAAA\r\n-----END PRIVATE KEY-----");
    ck.eq(key.filename, "hote.exemple.test.key.pem", "pemPrivateKey : nom <label>.key.pem");
    ck(!key.content.includes("\r"), "pemPrivateKey : clé PKCS#8 normalisée LF");

    // Nom de fichier : caractères INTERDITS sous Windows remplacés par « _ ».
    const weird = { id: "w", label: 'a/b:c*d?"e<f>g|h', parent_id: null, public_pem: leaf.public_pem, revoked_at: null };
    ck.eq(CertExports.pemCertificate(weird).filename, "a_b_c_d_e_f_g_h.pem", "nom de fichier : caractères interdits (\\/:*?\"<>|) → _");

    // Parent manquant → erreur française explicite.
    const orphan = { id: "o", label: "orpheline", parent_id: "fantome", public_pem: leaf.public_pem, revoked_at: null };
    let missErr = null; try { CertExports.pemFullchain(orphan, [orphan]); } catch (e) { missErr = e.message; }
    ck(!!missErr && /introuvable/i.test(missErr), "chaîne : émetteur introuvable → erreur explicite");

    // Cycle de parent_id → erreur (jamais de boucle infinie).
    const a = { id: "a", label: "a", parent_id: "b", public_pem: leaf.public_pem, revoked_at: null };
    const b = { id: "b", label: "b", parent_id: "a", public_pem: leaf.public_pem, revoked_at: null };
    let cycleErr = null; try { CertExports.resolveIssuerChain(a, [a, b]); } catch (e) { cycleErr = e.message; }
    ck(!!cycleErr && /(boucle|circulaire)/i.test(cycleErr), "chaîne : cycle parent_id → erreur (pas de boucle infinie)");

    // Révoqué → toutes les fonctions d'export REFUSENT (décision Q4).
    const revoked = Object.assign({}, leaf, { revoked_at: "2026-07-01T00:00:00Z" });
    let revErr = null; try { CertExports.pemCertificate(revoked); } catch (e) { revErr = e.message; }
    ck(!!revErr && /révoqué/i.test(revErr), "révoqué : pemCertificate refuse (garde-fou Q4)");
    let revFc = false; try { CertExports.pemFullchain(revoked, [root, inter, revoked]); } catch (_) { revFc = true; }
    ck(revFc, "révoqué : pemFullchain refuse");
  }
  });

  await section("Certs : CertExports — artefacts OpenSSH (délégation selon kind)", async () => {
  {
    const { CertExports } = D("certs/CertExports.js");
    const { OpenSshEncoder } = D("certs/OpenSshEncoder.js");
    const { SshKeyMaterial } = D("certs/SshKeyMaterial.js");
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section exports OpenSSH sautée"); return; }

    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = await SshKeyMaterial.ed25519PublicRaw(kp.publicKey);
    const seed = await SshKeyMaterial.ed25519Seed(kp.privateKey);

    // ssh-keypair → 2 artefacts : clé privée openssh-key-v1 (<label>) + ligne authorized_keys (<label>.pub).
    const kpRec = { id: "k", label: "cle-ssh", parent_id: null, public_pem: null, revoked_at: null };
    const arts = CertExports.opensshArtifacts(kpRec, { kind: "ssh-keypair", seed, publicKey, comment: "poste@exemple.test" });
    ck.eq(arts.length, 2, "ssh-keypair : 2 artefacts (privé + public)");
    ck.eq(arts[0].filename, "cle-ssh", "ssh-keypair : clé privée nommée <label>");
    ck.eq(arts[1].filename, "cle-ssh.pub", "ssh-keypair : clé publique nommée <label>.pub");
    ck(/BEGIN OPENSSH PRIVATE KEY/.test(arts[0].content), "ssh-keypair : clé privée au format openssh-key-v1");
    ck.eq(arts[1].content.trim(), OpenSshEncoder.ed25519PublicKeyLine(publicKey, "poste@exemple.test"), "ssh-keypair : ligne publique = délégation à OpenSshEncoder");

    // ssh-cert → 1 artefact : le certificat SSH (.pub) déjà émis (stocké en public_pem).
    const certLine = "ssh-ed25519-cert-v01@openssh.com AAAAEXEMPLEB64 poste@exemple.test";
    const certRec = { id: "c", label: "cert-hote", parent_id: null, public_pem: certLine, revoked_at: null };
    const artsCert = CertExports.opensshArtifacts(certRec, { kind: "ssh-cert", certLine });
    ck.eq(artsCert.length, 1, "ssh-cert : 1 artefact");
    ck.eq(artsCert[0].filename, "cert-hote-cert.pub", "ssh-cert : nommé <label>-cert.pub");
    ck.eq(artsCert[0].content, certLine + "\n", "ssh-cert : contenu = ligne du certificat + LF final");

    // Objet révoqué → refus.
    const revoked = Object.assign({}, kpRec, { revoked_at: "2026-07-01T00:00:00Z" });
    let err = null; try { CertExports.opensshArtifacts(revoked, { kind: "ssh-keypair", seed, publicKey }); } catch (e) { err = e.message; }
    ck(!!err && /révoqué/i.test(err), "exports OpenSSH : objet révoqué refusé");
  }
  });

  await section("Certs : Pkcs12Kdf — KDF PKCS#12 App B.2 (fixture ancrée openssl : clé de MAC)", async () => {
  {
    const { Pkcs12Kdf } = D("certs/Pkcs12Kdf.js");
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section Pkcs12Kdf sautée"); return; }

    // BMPString : chaque unité UTF-16 en gros-boutiste, suivie du terminateur 0x0000.
    const bmp = Pkcs12Kdf.bmpString("AB");
    ck(bmp.length === 6 && bmp[0] === 0 && bmp[1] === 0x41 && bmp[2] === 0 && bmp[3] === 0x42 && bmp[4] === 0 && bmp[5] === 0,
      "bmpString : UTF-16BE + terminateur 0x0000");

    // Fixture ANCRÉE openssl : sel/itérations/passphrase d'un .p12 openssl RÉEL. La clé de MAC
    // dérivée ici, passée à HMAC-SHA-256 sur l'AuthenticatedSafe, reproduit le MAC d'openssl
    // (vérifié hors test). Une valeur byte-identique = KDF conforme à RFC 7292 §B.2/B.3.
    const salt = new Uint8Array([0xDA, 0x2A, 0xD1, 0xC6, 0xE9, 0xAC, 0xF6, 0xA2]);
    const macKey = await Pkcs12Kdf.derive(Pkcs12Kdf.ID_MAC, Pkcs12Kdf.bmpString("motdepasse-test"), salt, 2048, 32);
    const hex = Array.from(macKey).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    ck.eq(hex, "ce957418ff5ff986e46e93c88daa26998fd1ff727eee08b0a7ccc8c772c9b077", "derive(id=3, 2048 itér) : clé de MAC byte-identique à openssl");
    ck.eq(Pkcs12Kdf.ID_MAC, 3, "diversificateur MAC = 3 (RFC 7292 §B.3)");
  }
  });

  await section("Certs : PKCS#12 — structure @peculiar (asn1-pfx) + validation croisée openssl", async () => {
  {
    const { CertExports } = D("certs/CertExports.js");
    const { X509Factory } = D("certs/X509Factory.js");
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section PKCS#12 sautée"); return; }

    // Vraie feuille signée par une CA (X509Factory) — noms d'exemple neutres.
    const ca = await X509Factory.createRootCa({ commonName: "CA Racine exemple", keyAlgo: "ec-p256", days: 365 });
    const leaf = await X509Factory.issueLeaf({
      caCertPem: ca.certPem, caPrivateKeyPkcs8Pem: ca.privateKeyPkcs8Pem,
      commonName: "hote.exemple.test", keyAlgo: "ec-p256", days: 90,
      sans: [{ san_type: "dns", value: "hote.exemple.test" }],
    });
    const caRec = { id: "ca", label: "CA Racine exemple", parent_id: null, public_pem: ca.certPem, revoked_at: null };
    const leafRec = { id: "leaf", label: "hote.exemple.test", parent_id: "ca", public_pem: leaf.certPem, revoked_at: null };
    const all = [caRec, leafRec];

    const PASS = "motdepasse-test";
    const artifact = await CertExports.pkcs12(leafRec, all, { passphrase: PASS, privateKeyPkcs8Pem: leaf.privateKeyPkcs8Pem, pbkdf2Iterations: 100000 });
    ck.eq(artifact.filename, "hote.exemple.test.p12", "pkcs12 : nom de fichier <label>.p12");
    ck.eq(artifact.mime, "application/x-pkcs12", "pkcs12 : type MIME application/x-pkcs12");
    ck(artifact.content instanceof Uint8Array && artifact.content.length > 200, "pkcs12 : contenu binaire non vide");

    // -- Test STRUCTUREL (sans openssl) : parse via @peculiar/asn1-pfx. --
    const { AsnConvert, OctetString } = require("@peculiar/asn1-schema");
    const asn1pfx = require("@peculiar/asn1-pfx");
    const pfx = AsnConvert.parse(artifact.content, asn1pfx.PFX);
    ck.eq(pfx.version, 3, "PFX : version 3");
    ck(!!pfx.macData && !!pfx.macData.mac, "PFX : MacData présent (intégrité)");
    ck.eq(pfx.macData.mac.digestAlgorithm.algorithm, "2.16.840.1.101.3.4.2.1", "PFX : MAC = SHA-256");
    ck(new Uint8Array(pfx.macData.macSalt.buffer).length === 8 && pfx.macData.iterations >= 1, "PFX : macSalt 8 octets + itérations");
    // authSafe (pkcs7-data) → OCTET STRING → AuthenticatedSafe : 2 ContentInfo (certs chiffrés + clé).
    ck.eq(pfx.authSafe.contentType, "1.2.840.113549.1.7.1", "PFX : authSafe = pkcs7-data");
    const asOctet = AsnConvert.parse(pfx.authSafe.content, OctetString);
    const authSafe = AsnConvert.parse(asOctet.buffer, asn1pfx.AuthenticatedSafe);
    ck.eq(authSafe.length, 2, "AuthenticatedSafe : 2 SafeBags/ContentInfo (certificats + clé)");
    const types = authSafe.map((ci) => ci.contentType).sort();
    ck(types.indexOf("1.2.840.113549.1.7.1") >= 0 && types.indexOf("1.2.840.113549.1.7.6") >= 0,
      "AuthenticatedSafe : pkcs7-data (clé) + pkcs7-encryptedData (certs chiffrés)");

    // -- Validation croisée openssl (sautée proprement si le binaire manque — pattern better-sqlite3). --
    let execSync = null;
    try { execSync = require("child_process").execSync; execSync("openssl version", { stdio: ["ignore", "pipe", "ignore"] }); }
    catch (_) { execSync = null; }
    if (!execSync) { ck(true, "openssl indisponible → validation croisée p12 sautée"); return; }

    const fs = require("fs"); const os = require("os"); const path2 = require("path");
    const stamp = String(Date.now()) + "-" + String(Math.floor(Math.random() * 1e6));
    const p12Path = path2.join(os.tmpdir(), "dcmanager-p12-" + stamp + ".p12");
    const leafCertPath = path2.join(os.tmpdir(), "dcmanager-p12-" + stamp + "-leaf.pem");
    const p12CertPath = path2.join(os.tmpdir(), "dcmanager-p12-" + stamp + "-p12.pem");
    try {
      fs.writeFileSync(p12Path, Buffer.from(artifact.content));
      fs.writeFileSync(leafCertPath, leaf.certPem);
      // -info -nodes déchiffre TOUT (échoue si le MAC ou PBES2 est incorrect) et liste cert + clé.
      const info = execSync("openssl pkcs12 -info -in \"" + p12Path + "\" -passin pass:" + PASS + " -nodes 2>&1", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      ck(/BEGIN CERTIFICATE/.test(info), "openssl : certificat listé dans le .p12");
      ck(/BEGIN PRIVATE KEY/.test(info), "openssl : clé privée listée dans le .p12");
      ck(/hote\.exemple\.test/.test(info), "openssl : CN hote.exemple.test présent (friendlyName/subject)");
      ck(/AES-256-CBC/i.test(info) && /PBKDF2/i.test(info), "openssl : chiffrement PBES2/PBKDF2/AES-256-CBC");
      // Clé publique : le cert extrait du .p12 == la feuille générée (modulus/point identiques).
      execSync("openssl pkcs12 -in \"" + p12Path + "\" -passin pass:" + PASS + " -nokeys -clcerts -out \"" + p12CertPath + "\"", { stdio: ["ignore", "ignore", "pipe"] });
      const leafPub = execSync("openssl x509 -in \"" + leafCertPath + "\" -pubkey -noout", { encoding: "utf8" });
      const p12Pub = execSync("openssl x509 -in \"" + p12CertPath + "\" -pubkey -noout", { encoding: "utf8" });
      ck(leafPub.indexOf("PUBLIC KEY") >= 0 && leafPub.trim() === p12Pub.trim(), "openssl : clé publique du .p12 identique à la feuille générée");
    } finally {
      for (const f of [p12Path, leafCertPath, p12CertPath]) { try { fs.unlinkSync(f); } catch (_) { /* nettoyage best-effort */ } }
    }
  }
  });

  /* ==========================================================================
     OPÉRATIONS GROUPÉES (tâche L4) — BulkActions (intersection d'actions PURE) et
     CertZip (bundles par kind + emballage ZIP fflate). Le VRAI zip est vérifié par
     aller-retour zipSync → unzipSync (structure de dossiers + contenus intacts). */

  await section("Certs : BulkActions — intersection d'actions communes (verrouillé/déverrouillé, révoqués)", async () => {
  {
    const { BulkActions } = D("certs/BulkActions.js");
    const snap = (kind, has_key, revoked) => ({ kind, label: kind, has_key, revoked_at: revoked ? "2026-07-01T00:00:00Z" : null });

    // Sélection VIDE → aucune action.
    const none = BulkActions.commonActions([], true);
    ck.eq(none.canExport, false, "vide : export indisponible");
    ck.eq(none.canRevoke, false, "vide : révoquer indisponible");
    ck.eq(none.canDelete, false, "vide : supprimer indisponible");

    // DÉVERROUILLÉ, aucun révoqué → tout dispo, libellé complet, clés incluses.
    const active = [snap("leaf-tls", true, false), snap("root-ca", true, false)];
    const a = BulkActions.commonActions(active, true);
    ck.eq(a.canExport, true, "déverrouillé : export disponible");
    ck.eq(a.exportLabel, "Exporter (ZIP)", "déverrouillé : libellé « Exporter (ZIP) »");
    ck.eq(a.withPrivateKeys, true, "déverrouillé : clés privées incluses");
    ck.eq(a.canRevoke, true, "déverrouillé + aucun révoqué : révoquer disponible");
    ck.eq(a.canDelete, true, "déverrouillé : supprimer disponible");

    // DÉVERROUILLÉ mais UN révoqué → révoquer INDISPONIBLE (rien de commun), supprimer/export OK.
    const mixed = [snap("leaf-tls", true, false), snap("leaf-tls", true, true)];
    const b = BulkActions.commonActions(mixed, true);
    ck.eq(b.canRevoke, false, "un révoqué dans la sélection → révoquer indisponible");
    ck.eq(b.canDelete, true, "un révoqué → supprimer reste disponible");
    ck.eq(b.canExport, true, "un révoqué → export reste disponible (le révoqué sera exclu du ZIP)");

    // VERROUILLÉ → l'export tombe aux PUBLICS, mais révoquer/supprimer restent OFFERTS : ce sont des
    // opérations de MÉTADONNÉES (aucun secret déchiffré). Les interdire rendait impurgeable une PKI
    // dont la phrase est perdue — en contradiction avec docs/certs.md (« consultée ET PURGÉE »).
    const locked = BulkActions.commonActions(active, false);
    ck.eq(locked.canExport, true, "verrouillé : export disponible");
    ck.eq(locked.exportLabel, "Exporter publics (ZIP)", "verrouillé : libellé « Exporter publics (ZIP) »");
    ck.eq(locked.withPrivateKeys, false, "verrouillé : aucune clé privée incluse");
    ck.eq(locked.canRevoke, true, "verrouillé : révoquer reste disponible (métadonnée, aucun secret touché)");
    ck.eq(locked.canDelete, true, "verrouillé : supprimer reste disponible (purge d'une PKI sans phrase)");

    // …et un révoqué dans la sélection reste le SEUL motif de retrait de « révoquer », verrou ou pas.
    const lockedMixed = BulkActions.commonActions(mixed, false);
    ck.eq(lockedMixed.canRevoke, false, "verrouillé + un révoqué → révoquer indisponible (rien de commun)");
    ck.eq(lockedMixed.canDelete, true, "verrouillé + un révoqué → supprimer disponible");

    // partitionExport : sépare inclus / exclus-révoqués (ordre préservé).
    const part = BulkActions.partitionExport([
      { id: "a", revoked_at: null }, { id: "b", revoked_at: "2026-07-01T00:00:00Z" }, { id: "c", revoked_at: null },
    ]);
    ck.eq(part.included.join(","), "a,c", "partition : inclus = non révoqués (ordre préservé)");
    ck.eq(part.excludedRevoked.join(","), "b", "partition : exclus = révoqués");

    // -- exportChoices : catégories COMMUNES proposées au dialogue d'export groupé --
    const avail = (choices) => Object.fromEntries(choices.map((c) => [c.key, c.available]));

    // Homogène leaf-tls déverrouillé + clés → LES 4 catégories (ordre stable public,fullchain,ca-chain,key).
    const leafHome = [snap("leaf-tls", true, false), snap("leaf-tls", true, false)];
    const ch1 = BulkActions.exportChoices(leafHome, true);
    ck.eq(ch1.length, 4, "exportChoices : 4 catégories renvoyées");
    ck.eq(ch1.map((c) => c.key).join(","), "public,fullchain,ca-chain,key", "exportChoices : ordre stable public,fullchain,ca-chain,key");
    const a1 = avail(ch1);
    ck(a1.public && a1.fullchain && a1["ca-chain"] && a1.key, "exportChoices : leaf-tls homogène déverrouillé → 4 disponibles");

    // Mixte root+leaf → public + key (pas de chaînes : tous ne sont pas des feuilles TLS).
    const a2 = avail(BulkActions.exportChoices([snap("root-ca", true, false), snap("leaf-tls", true, false)], true));
    ck(a2.public && !a2.fullchain && !a2["ca-chain"] && a2.key, "exportChoices : mixte root+leaf → public + key (pas de fullchain/ca-chain)");
    // Un sans has_key → key indisponible (pas commun à TOUS).
    ck.eq(avail(BulkActions.exportChoices([snap("root-ca", false, false), snap("leaf-tls", true, false)], true)).key, false, "exportChoices : un sans has_key → key indisponible");

    // Verrouillé → JAMAIS key ; les chaînes restent (dépendent du kind, pas de la session).
    const aLocked = avail(BulkActions.exportChoices(leafHome, false));
    ck.eq(aLocked.key, false, "exportChoices : verrouillé → key jamais disponible");
    ck(aLocked.public && aLocked.fullchain && aLocked["ca-chain"], "exportChoices : verrouillé → public/fullchain/ca-chain selon le kind");

    // Avec révoqués → catégories calculées sur les NON-révoqués (un root révoqué n'empêche pas les chaînes des leaf actifs).
    const a4 = avail(BulkActions.exportChoices([snap("root-ca", true, true), snap("leaf-tls", true, false), snap("leaf-tls", true, false)], true));
    ck(a4.public && a4.fullchain && a4["ca-chain"] && a4.key, "exportChoices : catégories calculées sur les NON-révoqués (leaf actifs → chaînes dispo)");
    // Tout révoqué → seul public reste (toujours) ; aucune conditionnelle (aucun non-révoqué).
    const a5 = avail(BulkActions.exportChoices([snap("leaf-tls", true, true)], true));
    ck(a5.public && !a5.fullchain && !a5["ca-chain"] && !a5.key, "exportChoices : tout révoqué → seul public (aucun non-révoqué)");
    // Sélection vide → public reste proposé (le dialogue peut toujours offrir le mot de passe).
    ck.eq(avail(BulkActions.exportChoices([], true)).public, true, "exportChoices : sélection vide → public toujours proposé");
  }
  });

  await section("Certs : CertZip — dédup de noms + découpe d'extension (logique PURE)", async () => {
  {
    const { CertZip } = D("certs/CertZip.js");

    ck.eq(CertZip.splitExt("cert.pem").ext, ".pem", "splitExt : extension .pem");
    ck.eq(CertZip.splitExt("cert.pem").stem, "cert", "splitExt : radical avant le dernier point");
    ck.eq(CertZip.splitExt("hote.exemple.test.pem").stem, "hote.exemple.test", "splitExt : radical garde les points internes");
    ck.eq(CertZip.splitExt("cle-ssh").ext, "", "splitExt : sans point → pas d'extension");
    ck.eq(CertZip.splitExt(".cache").ext, "", "splitExt : point en tête → pas d'extension (radical entier)");

    const usedFolders = new Set();
    ck.eq(CertZip.dedupe("MonCert", usedFolders), "MonCert", "dedupe : premier nom conservé");
    ck.eq(CertZip.dedupe("MonCert", usedFolders), "MonCert-2", "dedupe : 1re collision → -2");
    ck.eq(CertZip.dedupe("MonCert", usedFolders), "MonCert-3", "dedupe : collision suivante → -3");
    const usedFiles = new Set();
    ck.eq(CertZip.dedupe("cert.pem", usedFiles), "cert.pem", "dedupe : fichier conservé");
    ck.eq(CertZip.dedupe("cert.pem", usedFiles), "cert-2.pem", "dedupe : suffixe AVANT l'extension (cert-2.pem)");
  }
  });

  await section("Certs : CertZip — bundles par kind + archive ZIP réelle (fflate zipSync/unzipSync)", async () => {
  {
    const { CertZip } = D("certs/CertZip.js");
    const { X509Factory } = D("certs/X509Factory.js");
    const { OpenSshEncoder } = D("certs/OpenSshEncoder.js");
    const { SshKeyMaterial } = D("certs/SshKeyMaterial.js");
    if (!globalThis.crypto || !globalThis.crypto.subtle) { ck(true, "WebCrypto indisponible → section CertZip sautée"); return; }
    const x509 = require("@peculiar/x509");
    const { unzipSync, strFromU8 } = require("fflate");   // fflate se require depuis node_modules racine (comme @peculiar)

    // -- X.509 : CA racine + feuille TLS (X509Factory) --
    const ca = await X509Factory.createRootCa({ commonName: "CA Racine exemple", keyAlgo: "ec-p256", days: 365 });
    const leaf = await X509Factory.issueLeaf({
      caCertPem: ca.certPem, caPrivateKeyPkcs8Pem: ca.privateKeyPkcs8Pem,
      commonName: "hote.exemple.test", keyAlgo: "ec-p256", days: 90, sans: [{ san_type: "dns", value: "hote.exemple.test" }],
    });
    const caRec = { id: "ca", label: "CA Racine exemple", parent_id: null, public_pem: ca.certPem, revoked_at: null, kind: "root-ca", subject: "CN=CA Racine exemple" };
    const leafRec = { id: "leaf", label: "hote.exemple.test", parent_id: "ca", public_pem: leaf.certPem, revoked_at: null, kind: "leaf-tls", subject: "CN=hote.exemple.test" };
    const all = [caRec, leafRec];

    // leaf-tls SANS clé → cert.pem + fullchain.pem (noms GÉNÉRIQUES, pas de key.pem).
    const leafPub = await CertZip.bundleFor(leafRec, all, null);
    ck.eq(leafPub.map((a) => a.filename).sort().join(","), "cert.pem,fullchain.pem", "leaf-tls sans clé : cert.pem + fullchain.pem");

    // leaf-tls AVEC clé → + key.pem ; contenus corrects.
    const leafFull = await CertZip.bundleFor(leafRec, all, leaf.privateKeyPkcs8Pem);
    ck.eq(leafFull.map((a) => a.filename).sort().join(","), "cert.pem,fullchain.pem,key.pem", "leaf-tls avec clé : + key.pem");
    const certArt = leafFull.find((a) => a.filename === "cert.pem");
    ck(/BEGIN CERTIFICATE/.test(certArt.content), "leaf-tls : cert.pem = PEM du certificat");
    const fcArt = leafFull.find((a) => a.filename === "fullchain.pem");
    ck.eq(fcArt.content.split("BEGIN CERTIFICATE").length, 3, "leaf-tls : fullchain = feuille + CA (2 blocs)");
    ck(/BEGIN PRIVATE KEY/.test(leafFull.find((a) => a.filename === "key.pem").content), "leaf-tls : key.pem = clé privée PKCS#8");

    // root-ca AVEC clé → cert.pem + key.pem (pas de fullchain).
    const rootFull = await CertZip.bundleFor(caRec, all, ca.privateKeyPkcs8Pem);
    ck.eq(rootFull.map((a) => a.filename).sort().join(","), "cert.pem,key.pem", "root-ca avec clé : cert.pem + key.pem (pas de fullchain)");

    // -- ASSEMBLAGE FILTRÉ par catégories (dialogue d'export groupé) --
    // {public} seul → cert.pem seul (ni fullchain, ni ca-chain, ni key).
    const onlyPublic = await CertZip.bundleFor(leafRec, all, leaf.privateKeyPkcs8Pem, new Set(["public"]));
    ck.eq(onlyPublic.map((a) => a.filename).sort().join(","), "cert.pem", "bundle filtré {public} : cert.pem seul");
    // {key} seul (avec clé) → key.pem seul.
    const onlyKey = await CertZip.bundleFor(leafRec, all, leaf.privateKeyPkcs8Pem, new Set(["key"]));
    ck.eq(onlyKey.map((a) => a.filename).sort().join(","), "key.pem", "bundle filtré {key} : key.pem seul");
    // {public, ca-chain} → cert.pem + ca-chain.pem (ca-chain est une catégorie PROPRE au dialogue groupé).
    const pubCaChain = await CertZip.bundleFor(leafRec, all, null, new Set(["public", "ca-chain"]));
    ck.eq(pubCaChain.map((a) => a.filename).sort().join(","), "ca-chain.pem,cert.pem", "bundle filtré {public,ca-chain} : cert.pem + ca-chain.pem");
    // Bundle HISTORIQUE (categories absent) INCHANGÉ : ca-chain ABSENT (compat export unitaire « Tout (ZIP) »).
    ck.eq(leafFull.map((a) => a.filename).indexOf("ca-chain.pem"), -1, "bundle historique (sans catégories) : ca-chain ABSENT (compat unitaire)");

    // -- SSH : paire ed25519 --
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const pub = await SshKeyMaterial.ed25519PublicRaw(kp.publicKey);
    const pubLine = OpenSshEncoder.ed25519PublicKeyLine(pub, "poste@exemple.test");
    const kpPkcs8 = x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE KEY");
    const kpRec = { id: "k", label: "cle-ssh", parent_id: null, public_pem: pubLine, revoked_at: null, kind: "ssh-keypair", subject: "poste@exemple.test" };

    // ssh-keypair SANS clé → seule la ligne .pub (publique).
    const sshPub = await CertZip.bundleFor(kpRec, [kpRec], null);
    ck.eq(sshPub.length, 1, "ssh-keypair sans clé : 1 artefact (.pub)");
    ck.eq(sshPub[0].filename, "cle-ssh.pub", "ssh-keypair sans clé : <label>.pub");
    ck.eq(sshPub[0].content.trim(), pubLine, "ssh-keypair sans clé : contenu = ligne authorized_keys");

    // ssh-keypair AVEC clé → clé privée openssh-key-v1 + .pub (via CertExports.opensshArtifacts).
    const sshFull = await CertZip.bundleFor(kpRec, [kpRec], kpPkcs8);
    ck.eq(sshFull.map((a) => a.filename).sort().join(","), "cle-ssh,cle-ssh.pub", "ssh-keypair avec clé : <label> + <label>.pub");
    ck(/BEGIN OPENSSH PRIVATE KEY/.test(sshFull.find((a) => a.filename === "cle-ssh").content), "ssh-keypair : clé privée au format openssh-key-v1");

    // SSH filtré : {public} → seule la ligne .pub ; {key} → seule la clé privée OpenSSH (pas de catégorie SSH dédiée).
    const sshPubOnly = await CertZip.bundleFor(kpRec, [kpRec], kpPkcs8, new Set(["public"]));
    ck.eq(sshPubOnly.map((a) => a.filename).sort().join(","), "cle-ssh.pub", "bundle SSH filtré {public} : ligne .pub seule");
    const sshKeyOnly = await CertZip.bundleFor(kpRec, [kpRec], kpPkcs8, new Set(["key"]));
    ck.eq(sshKeyOnly.map((a) => a.filename).sort().join(","), "cle-ssh", "bundle SSH filtré {key} : clé privée OpenSSH seule");

    // Cert RÉVOQUÉ → refus (même garde-fou partagé que CertExports).
    const revoked = Object.assign({}, leafRec, { revoked_at: "2026-07-01T00:00:00Z" });
    let revErr = null; try { await CertZip.bundleFor(revoked, all, null); } catch (e) { revErr = e.message; }
    ck(!!revErr && /révoqué/i.test(revErr), "bundle : cert révoqué refusé (garde-fou partagé)");

    // -- ARCHIVE ZIP RÉELLE : multi-certs (un dossier par cert) → unzipSync → structure + contenus --
    const zipBytes = CertZip.zipArtifacts([
      { folder: "hote.exemple.test", artifacts: leafFull },
      { folder: "CA Racine exemple", artifacts: rootFull },
    ]);
    ck(zipBytes instanceof Uint8Array && zipBytes.length > 0, "zipArtifacts : archive non vide");
    const unzipped = unzipSync(zipBytes);
    const paths = Object.keys(unzipped).sort();
    ck(paths.indexOf("hote.exemple.test/cert.pem") >= 0 && paths.indexOf("hote.exemple.test/fullchain.pem") >= 0 && paths.indexOf("hote.exemple.test/key.pem") >= 0,
      "zip : dossier feuille contient cert/fullchain/key");
    ck(paths.indexOf("CA Racine exemple/cert.pem") >= 0 && paths.indexOf("CA Racine exemple/key.pem") >= 0, "zip : dossier CA contient cert/key");
    ck.eq(strFromU8(unzipped["hote.exemple.test/cert.pem"]), certArt.content, "zip : contenu de cert.pem INTACT après aller-retour");

    // -- DÉDUP de dossiers homonymes : deux certs de même label → dossiers distincts (meme, meme-2) --
    const dupZip = CertZip.zipArtifacts([
      { folder: "meme", artifacts: [{ filename: "cert.pem", mime: "text/plain", content: "A" }] },
      { folder: "meme", artifacts: [{ filename: "cert.pem", mime: "text/plain", content: "B" }] },
    ]);
    ck.eq(Object.keys(unzipSync(dupZip)).sort().join(","), "meme-2/cert.pem,meme/cert.pem", "zip : dossiers homonymes dédupliqués (meme, meme-2)");

    // -- Export UNITAIRE (entrée SANS dossier) : fichiers à la RACINE du ZIP --
    const single = unzipSync(CertZip.zipArtifacts([{ artifacts: leafFull }]));
    ck.eq(Object.keys(single).sort().join(","), "cert.pem,fullchain.pem,key.pem", "zip unitaire : fichiers à la racine (cert/fullchain/key)");
  }
  });

  await section("Certs : CertZip — ZIP chiffré AES-256 (@zip.js/zip.js) : aller-retour réel + structure", async () => {
  {
    const { CertZip } = D("certs/CertZip.js");
    // zip.js se require depuis node_modules racine (comme fflate/@peculiar) → MÊME instance que le module compilé.
    const { ZipReader, Uint8ArrayReader, TextWriter, configure } = require("@zip.js/zip.js");
    const { unzipSync } = require("fflate");
    configure({ useWebWorkers: false });   // parité avec le module (bundle monolithique + tests Node)

    const PASS = "mot-de-passe-archive-test";
    const entries = [
      { folder: "hote.exemple.test", artifacts: [
        { filename: "cert.pem", mime: "text/plain", content: "CONTENU-CERT" },
        { filename: "key.pem", mime: "text/plain", content: "CONTENU-CLE" },
      ] },
      { folder: "CA Racine exemple", artifacts: [
        { filename: "cert.pem", mime: "text/plain", content: "CONTENU-CA" },
      ] },
    ];

    // -- Emballage CHIFFRÉ (AES-256) --
    const enc = await CertZip.zipArtifactsEncrypted(entries, PASS);
    ck(enc instanceof Uint8Array && enc.length > 0, "zipArtifactsEncrypted : archive non vide");

    // -- Relecture avec le BON mot de passe : contenus INTACTS --
    const reader = new ZipReader(new Uint8ArrayReader(enc), { password: PASS });
    const zEntries = await reader.getEntries();
    const paths = zEntries.map((e) => e.filename).sort();
    ck(paths.indexOf("hote.exemple.test/cert.pem") >= 0 && paths.indexOf("hote.exemple.test/key.pem") >= 0 && paths.indexOf("CA Racine exemple/cert.pem") >= 0,
      "zip chiffré : arborescence dossier/fichier attendue");
    const readOne = async (name) => reader && (await zEntries.find((e) => e.filename === name).getData(new TextWriter()));
    ck.eq(await readOne("hote.exemple.test/cert.pem"), "CONTENU-CERT", "zip chiffré : cert.pem déchiffré intact (bon mot de passe)");
    ck.eq(await readOne("hote.exemple.test/key.pem"), "CONTENU-CLE", "zip chiffré : key.pem déchiffré intact");
    ck.eq(await readOne("CA Racine exemple/cert.pem"), "CONTENU-CA", "zip chiffré : cert.pem CA déchiffré intact");
    await reader.close();

    // -- MAUVAIS mot de passe → lecture REFUSÉE (jamais de clair divulgué) --
    let wrongFailed = false;
    try {
      const bad = new ZipReader(new Uint8ArrayReader(enc), { password: "mauvais-mot-de-passe" });
      const be = await bad.getEntries();
      await be.find((e) => e.filename === "hote.exemple.test/cert.pem").getData(new TextWriter());
      await bad.close();
    } catch (_) { wrongFailed = true; }
    ck(wrongFailed, "zip chiffré : mauvais mot de passe → lecture refusée (aucun contenu divulgué)");

    // -- STRUCTURE IDENTIQUE au chemin fflate : mêmes chemins de fichiers (dédup/dossiers partagés) --
    const clearPaths = Object.keys(unzipSync(CertZip.zipArtifacts(entries))).sort();
    ck.eq(clearPaths.join(","), paths.join(","), "zip chiffré : mêmes chemins de fichiers que le chemin fflate (structure identique)");

    // -- Mot de passe vide refusé (garde-fou) --
    let emptyPassFailed = false;
    try { await CertZip.zipArtifactsEncrypted(entries, ""); } catch (_) { emptyPassFailed = true; }
    ck(emptyPassFailed, "zipArtifactsEncrypted : mot de passe vide refusé (garde-fou)");
  }
  });
};
