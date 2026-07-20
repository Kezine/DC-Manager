/* =============================================================================
   CertSubject — extraction de champs d'un SUJET X.509 stocké en DN BRUT (logique
   PURE : aucun DOM, aucun store, aucun réseau).

   Les certificats de la PKI interne stockent leur sujet sous forme de DN textuel
   (« CN=srv1.exemple.com, O=Exemple SA ») — il n'existait AUCUN extracteur côté
   client. Le rapprochement certificat ↔ cible (`CertTargetMatch`) a besoin du
   Common Name (CN) comme nom DNS candidat en complément des SAN dns.

   TOLÉRANCE (cadrage 2026-07-20) : casse de la clé (`cn=`/`CN=`), espaces autour de
   la clé et de la valeur, valeur vide → null. On prend le PREMIER RDN `CN=` rencontré.

   LIMITE ASSUMÉE : parsing lexical simple par découpe sur « , ». Les valeurs
   contenant une virgule ÉCHAPPÉE (« CN=Nom\,Inc ») ou les RDN multivalués (« CN=a+OU=b »)
   ne sont pas gérés — cas absents des sujets produits par la PKI interne (CN = un
   hostname). Aucune dépendance à une lib X.509 (extraction purement textuelle). */

export class CertSubject {
  /** Common Name (1er RDN `CN=`) d'un DN brut, trimé ; null si absent, illisible ou valeur vide.
      Insensible à la casse de la clé et tolérant aux espaces. */
  static cn(dn: string): string | null {
    if (typeof dn !== "string") return null;
    for (const rdn of dn.split(",")) {
      const eq = rdn.indexOf("=");
      if (eq < 0) continue;
      const key = rdn.slice(0, eq).trim().toLowerCase();
      if (key !== "cn") continue;
      const value = rdn.slice(eq + 1).trim();
      return value || null;   // premier CN : valeur vide (« CN= ») → null
    }
    return null;
  }
}
