/* =============================================================================
   HostnameMatch — normalisation & rapprochement de HOSTNAMES (logique PURE :
   aucun DOM, aucun store, aucun réseau).

   Une SEULE définition de « comment on normalise et compare un hostname »
   (principe n°3). Cette règle était jusqu'ici ENFOUIE dans
   `VmClusterFormat.resolveHostEquipmentId` (rapprochement nœud Proxmox ↔ équipement) ;
   elle est extraite ici pour être :
     - RÉUTILISÉE par le rapprochement certificat ↔ équipement/VM (`CertTargetMatch`),
       qui doit comparer les noms DNS d'un certificat (SAN dns, CN) aux hostnames d'une
       cible réseau ;
     - testable en isolation (principes n°2/n°7).

   MODÈLE DE NORMALISATION (identique à VmClusterFormat, donc au MIROIR serveur
   `VmSyncService` — cf. l'avertissement de synchronisation dans VmClusterFormat.ts) :
     - `full`       : hostname trimé, en minuscules (FQDN complet OU nom court) ;
     - `firstLabel` : premier label du FQDN (« srv1.int.exemple.com » → « srv1 »),
       égal à `full` quand il n'y a pas de point.
   Le premier label sert de PONT court ⇄ FQDN : un nom court (« srv1 ») et un FQDN
   dont c'est le 1er label (« srv1.exemple.com ») se rapprochent.

   LIMITES ASSUMÉES : pas de gestion de l'IDN/punycode (les noms internationalisés ne
   sont ni normalisés ni convertis), pas de repli sur des labels autres que le premier.
   La comparaison est purement lexicale (après trim + minuscule).
   ============================================================================= */

/** Hostname normalisé : forme complète + premier label (jamais vide ; null si l'entrée est vide). */
export interface NormalizedHostname {
  /** Hostname entier, trimé et en minuscules (« srv1.exemple.com », « srv1 »). */
  full: string;
  /** Premier label du FQDN (« srv1.exemple.com » → « srv1 ») ; = `full` sans point. */
  firstLabel: string;
}

export class HostnameMatch {
  /** Normalise un hostname : trim + minuscules ; découpe sur « . » pour isoler le 1er label.
      Entrée non-chaîne ou vide (après trim) → null (aucun rapprochement possible). */
  static norm(hostname: string): NormalizedHostname | null {
    const full = (typeof hostname === "string" ? hostname.trim() : "").toLowerCase();
    if (!full) return null;
    return { full, firstLabel: full.split(".")[0] };
  }

  /** Le `candidate` (un nom DNS : SAN dns ou CN) rapproche-t-il l'UN des `names` (hostnames d'une cible) ?
      Un rapprochement est établi si, après normalisation, l'une de ces égalités tient :
        - `candidate.full === name.full`        (même FQDN, ou même nom court) ;
        - `candidate.full === name.firstLabel`  (candidate court, name = FQDN de ce court) ;
        - `candidate.firstLabel === name.full`  (candidate = FQDN, name court correspondant).
      On NE rapproche PAS deux FQDN distincts partageant seulement leur 1er label
      (« srv1.a.com » vs « srv1.b.com ») : le pont court ⇄ FQDN exige qu'un côté soit COURT. */
  static matchesExact(candidate: string, names: string[]): boolean {
    const c = HostnameMatch.norm(candidate);
    if (!c) return false;
    const list = Array.isArray(names) ? names : [];
    for (const raw of list) {
      const n = HostnameMatch.norm(raw);
      if (!n) continue;
      if (c.full === n.full || c.full === n.firstLabel || c.firstLabel === n.full) return true;
    }
    return false;
  }

  /** Le motif `*.dom` (wildcard RFC 6125 : UN seul « * », label de tête ENTIER) rapproche-t-il l'UN des `names` ?
      `*.dom` rapproche « x.dom » (EXACTEMENT un label de plus) mais PAS « x.y.dom » (deux labels de plus)
      ni « dom » seul (zéro label de plus). Motif invalide (pas préfixé « *. », suffixe vide, autre « * ») → false.
      Seule la forme COMPLÈTE (`full`) d'un name est confrontée : un nom court ne peut satisfaire un wildcard. */
  static matchesWildcard(pattern: string, names: string[]): boolean {
    const p = (typeof pattern === "string" ? pattern.trim() : "").toLowerCase();
    // Le label de tête doit être EXACTEMENT « * » (pas de wildcard partiel « ab*.dom »).
    if (!p.startsWith("*.")) return false;
    const suffix = p.slice(2);                       // partie après « *. » (« dom », « exemple.com »)
    if (!suffix || suffix.includes("*")) return false;   // suffixe vide ou 2ᵉ wildcard → invalide
    const list = Array.isArray(names) ? names : [];
    for (const raw of list) {
      const n = HostnameMatch.norm(raw);
      if (!n) continue;
      if (!n.full.endsWith("." + suffix)) continue;
      // Le préfixe (ce qui reste avant « .suffix ») doit être EXACTEMENT un label (non vide, sans point).
      const head = n.full.slice(0, n.full.length - suffix.length - 1);
      if (head && !head.includes(".")) return true;
    }
    return false;
  }
}
