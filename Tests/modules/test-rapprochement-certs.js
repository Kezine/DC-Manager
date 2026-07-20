/* Tests modules — RAPPROCHEMENT certificat ↔ équipement/VM (logique PURE) :
   HostnameMatch (normalisation + rapprochement de hostnames, exact & wildcard),
   CertSubject (extraction du CN d'un DN brut) et CertTargetMatch (le moteur :
   leaf-tls seul, révoqués exclus, expirés inclus, DNS/CN/wildcard/IP, IP constatée,
   IPv6 non matché, ambiguïté). Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  await section("Rapprochement : HostnameMatch — normalisation (trim/minuscule/1er label)", async () => {
    const { HostnameMatch } = D("core/HostnameMatch.js");

    const n = HostnameMatch.norm("  SRV1.Int.Exemple.COM ");
    ck(n && n.full === "srv1.int.exemple.com", "norm : trim + minuscule → full");
    ck(n && n.firstLabel === "srv1", "norm : 1er label isolé");
    const short = HostnameMatch.norm("host");
    ck(short && short.full === "host" && short.firstLabel === "host", "norm : sans point → firstLabel = full");
    ck.eq(HostnameMatch.norm(""), null, "norm : chaîne vide → null");
    ck.eq(HostnameMatch.norm("   "), null, "norm : espaces seuls → null");
    ck.eq(HostnameMatch.norm(null), null, "norm : non-chaîne → null");
  });

  await section("Rapprochement : HostnameMatch — matchesExact (full, 1er label, pont court⇄FQDN, casse)", async () => {
    const { HostnameMatch } = D("core/HostnameMatch.js");

    ck(HostnameMatch.matchesExact("srv1.exemple.com", ["srv1.exemple.com"]), "exact : FQDN identique");
    ck(HostnameMatch.matchesExact("SRV1.Exemple.com", ["srv1.exemple.COM"]), "exact : insensible à la casse");
    ck(HostnameMatch.matchesExact("srv1", ["srv1.exemple.com"]), "exact : candidate COURT ↔ name FQDN (via 1er label)");
    ck(HostnameMatch.matchesExact("srv1.exemple.com", ["srv1"]), "exact : candidate FQDN ↔ name COURT");
    ck(!HostnameMatch.matchesExact("srv1.a.com", ["srv1.b.com"]), "exact : 2 FQDN même 1er label, domaines ≠ → PAS de match");
    ck(!HostnameMatch.matchesExact("srv2", ["srv1.exemple.com"]), "exact : 1er label différent → pas de match");
    ck(!HostnameMatch.matchesExact("", ["srv1"]), "exact : candidate vide → false");
    ck(!HostnameMatch.matchesExact("srv1", []), "exact : aucun name → false");
  });

  await section("Rapprochement : HostnameMatch — matchesWildcard (*.dom = UN label de plus, un seul *)", async () => {
    const { HostnameMatch } = D("core/HostnameMatch.js");

    ck(HostnameMatch.matchesWildcard("*.exemple.com", ["srv1.exemple.com"]), "wildcard : *.dom rapproche x.dom");
    ck(HostnameMatch.matchesWildcard("*.EXEMPLE.com", ["SRV1.exemple.COM"]), "wildcard : insensible à la casse");
    ck(!HostnameMatch.matchesWildcard("*.exemple.com", ["a.b.exemple.com"]), "wildcard : PAS deux labels de plus");
    ck(!HostnameMatch.matchesWildcard("*.exemple.com", ["exemple.com"]), "wildcard : PAS le domaine nu (zéro label de plus)");
    ck(!HostnameMatch.matchesWildcard("srv1.exemple.com", ["srv1.exemple.com"]), "wildcard : motif non wildcard → false");
    ck(!HostnameMatch.matchesWildcard("*.*.com", ["a.b.com"]), "wildcard : deux * → motif invalide");
    ck(!HostnameMatch.matchesWildcard("*.", ["a."]), "wildcard : suffixe vide → invalide");
    ck(!HostnameMatch.matchesWildcard("ab*.exemple.com", ["abx.exemple.com"]), "wildcard : wildcard PARTIEL (ab*) → invalide");
  });

  await section("Rapprochement : CertSubject — extraction du CN d'un DN brut (casse, absence, valeur vide)", async () => {
    const { CertSubject } = D("core/CertSubject.js");

    ck.eq(CertSubject.cn("CN=srv1.exemple.com, O=Exemple SA"), "srv1.exemple.com", "cn : présent en 1er RDN");
    ck.eq(CertSubject.cn("O=Exemple SA, CN=srv1.exemple.com"), "srv1.exemple.com", "cn : présent (pas en 1er)");
    ck.eq(CertSubject.cn("cn = srv1.exemple.com"), "srv1.exemple.com", "cn : casse de la clé + espaces tolérés");
    ck.eq(CertSubject.cn("O=Exemple SA"), null, "cn : absent (O= seul) → null");
    ck.eq(CertSubject.cn("CN="), null, "cn : valeur vide → null");
    ck.eq(CertSubject.cn(""), null, "cn : DN vide → null");
    ck.eq(CertSubject.cn(null), null, "cn : non-chaîne → null");
  });

  await section("Rapprochement : CertTargetMatch — pistes DNS/CN/wildcard/IP, révoqué/expiré/non-leaf, IPv6", async () => {
    const { CertTargetMatch } = D("core/CertTargetMatch.js");
    // Fabriques minimales (valeurs par défaut sûres, surchargées par cas).
    const mkId = (over) => Object.assign({ kind: "equipment", id: "e1", name: "", hostnames: [], ips: [] }, over);
    const mkCert = (over) => Object.assign({ id: "c1", label: "cert", kind: "leaf-tls", subject: "", sans: [], revoked_at: null, not_after: null }, over);

    const idHost = mkId({ hostnames: ["web.corp.exemple"] });

    // -- SAN dns exact --
    const mDns = CertTargetMatch.matches(mkCert({ sans: [{ san_type: "dns", value: "web.corp.exemple" }] }), idHost);
    ck(mDns.length === 1 && mDns[0].via === "dns" && mDns[0].value === "web.corp.exemple", "SAN dns exact → via dns");

    // -- CN (sujet) exact --
    const mCn = CertTargetMatch.matches(mkCert({ subject: "CN=web.corp.exemple, O=X" }), idHost);
    ck(mCn.length === 1 && mCn[0].via === "cn" && mCn[0].value === "web.corp.exemple", "CN → via cn");

    // -- SAN dns wildcard --
    const mWild = CertTargetMatch.matches(mkCert({ sans: [{ san_type: "dns", value: "*.corp.exemple" }] }), idHost);
    ck(mWild.length === 1 && mWild[0].via === "wildcard" && mWild[0].value === "*.corp.exemple", "SAN *.dom → via wildcard");

    // -- SAN ip IPAM (fait foi) : match SANS flag observed --
    const mIpam = CertTargetMatch.matches(mkCert({ sans: [{ san_type: "ip", value: "10.0.0.5" }] }), mkId({ ips: [{ value: "10.0.0.5", observed: false }] }));
    ck(mIpam.length === 1 && mIpam[0].via === "ip" && mIpam[0].observed === undefined, "SAN ip IPAM → via ip, pas de flag observed (fait foi)");

    // -- SAN ip vNIC seule : observed:true (constatée) --
    const mVnic = CertTargetMatch.matches(mkCert({ sans: [{ san_type: "ip", value: "10.0.0.9" }] }), mkId({ ips: [{ value: "10.0.0.9", observed: true }] }));
    ck(mVnic.length === 1 && mVnic[0].observed === true, "SAN ip vNIC seule → observed:true (constatée)");

    // -- Même IP en IPAM ET vNIC → IPAM fait foi (pas de flag) --
    const mBoth = CertTargetMatch.matches(mkCert({ sans: [{ san_type: "ip", value: "10.0.0.5" }] }), mkId({ ips: [{ value: "10.0.0.5", observed: false }, { value: "10.0.0.5", observed: true }] }));
    ck(mBoth.length === 1 && mBoth[0].observed === undefined, "IP en IPAM + vNIC → IPAM fait foi (pas de flag observed)");

    // -- Révoqué EXCLU --
    ck.eq(CertTargetMatch.matches(mkCert({ revoked_at: "2026-01-01T00:00:00Z", sans: [{ san_type: "dns", value: "web.corp.exemple" }] }), idHost).length, 0, "révoqué → exclu (0 match)");

    // -- Expiré INCLUS (l'appelant teinte) --
    ck.eq(CertTargetMatch.matches(mkCert({ not_after: "2000-01-01T00:00:00Z", sans: [{ san_type: "dns", value: "web.corp.exemple" }] }), idHost).length, 1, "expiré → INCLUS (teinté par l'appelant)");

    // -- Non leaf-tls IGNORÉ --
    ck.eq(CertTargetMatch.matches(mkCert({ kind: "root-ca", sans: [{ san_type: "dns", value: "web.corp.exemple" }] }), idHost).length, 0, "non leaf-tls (root-ca) → ignoré");

    // -- SAN email ignoré --
    ck.eq(CertTargetMatch.matches(mkCert({ sans: [{ san_type: "email", value: "a@b.c" }] }), idHost).length, 0, "SAN email → ignoré");

    // -- IPv6 jamais matché (Ipv4 strict) --
    ck.eq(CertTargetMatch.matches(mkCert({ sans: [{ san_type: "ip", value: "2001:db8::1" }] }), mkId({ ips: [{ value: "2001:db8::1", observed: false }] })).length, 0, "IPv6 → jamais un match (Ipv4 strict)");

    // -- Dédup (via+valeur) sur SAN dns dupliqués --
    ck.eq(CertTargetMatch.matches(mkCert({ sans: [{ san_type: "dns", value: "web.corp.exemple" }, { san_type: "dns", value: "web.corp.exemple" }] }), idHost).length, 1, "SAN dns dupliqués → dédup (1 piste)");

    // -- Plusieurs pistes distinctes (CN + dns + ip) toutes rapportées --
    const idMulti = mkId({ hostnames: ["web.corp.exemple"], ips: [{ value: "10.0.0.5", observed: false }] });
    const mMulti = CertTargetMatch.matches(mkCert({ subject: "CN=web.corp.exemple", sans: [{ san_type: "dns", value: "web.corp.exemple" }, { san_type: "ip", value: "10.0.0.5" }] }), idMulti);
    ck.eq(mMulti.length, 3, "CN + SAN dns + SAN ip → 3 pistes distinctes");
  });

  await section("Rapprochement : CertTargetMatch — certsForTarget / targetsForCert + ambiguïté multi-cibles", async () => {
    const { CertTargetMatch } = D("core/CertTargetMatch.js");
    const mkId = (over) => Object.assign({ kind: "equipment", id: "e1", name: "", hostnames: [], ips: [] }, over);
    const mkCert = (over) => Object.assign({ id: "c1", label: "cert", kind: "leaf-tls", subject: "", sans: [], revoked_at: null, not_after: null }, over);

    const idHost = mkId({ hostnames: ["web.corp.exemple"] });
    const certDns = mkCert({ id: "cDns", sans: [{ san_type: "dns", value: "web.corp.exemple" }] });
    const certRoot = mkCert({ id: "cRoot", kind: "root-ca", sans: [{ san_type: "dns", value: "web.corp.exemple" }] });
    const certRevoked = mkCert({ id: "cRev", revoked_at: "2026-01-01T00:00:00Z", sans: [{ san_type: "dns", value: "web.corp.exemple" }] });
    const certOther = mkCert({ id: "cOther", sans: [{ san_type: "dns", value: "autre.exemple" }] });

    // certsForTarget : seul le leaf-tls RAPPROCHANT (ni root-ca, ni révoqué, ni hors sujet) ressort.
    const forTarget = CertTargetMatch.certsForTarget(idHost, [certDns, certRoot, certRevoked, certOther]);
    ck(forTarget.length === 1 && forTarget[0].cert === certDns, "certsForTarget : seul le leaf-tls rapprochant ressort");
    ck(forTarget[0].vias.length === 1 && forTarget[0].vias[0].via === "dns", "certsForTarget : piste renseignée (via dns)");

    // targetsForCert : un cert rapprochant DEUX cibles (équipement + VM homonymes) → ambiguïté (cardinalité > 1).
    const idEq = mkId({ id: "e1", hostnames: ["web.corp.exemple"] });
    const idVm = mkId({ id: "v1", kind: "vm", hostnames: ["web.corp.exemple"] });
    const targets = CertTargetMatch.targetsForCert(certDns, [idEq, idVm]);
    ck.eq(targets.length, 2, "targetsForCert : 2 cibles rapprochées");
    ck(targets.length > 1, "ambiguïté : cardinalité > 1 → l'appelant signale « ambigu » (le moteur ne masque pas)");
    ck.eq(CertTargetMatch.targetsForCert(certDns, [idEq]).length, 1, "targetsForCert : une seule cible → non ambigu");
  });
};
