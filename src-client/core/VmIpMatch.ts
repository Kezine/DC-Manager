import { Ipv4 } from "../../src-shared/DataValidation";

/* =============================================================================
   RAPPROCHEMENT IP ASSISTÉ — logique PURE (aucun DOM, aucun store, aucun réseau).

   IPAM INFORMATIF (décision de cadrage n°4, .notes/vm-proxmox-cadrage-2026-07-12.md
   & docs/vm-proxmox.md) : la synchro ne crée JAMAIS d'entrée IPAM et ne rattache
   JAMAIS automatiquement une adresse. Ce module se contente de PROPOSER : à partir
   des IPs CONSTATÉES des vNIC d'une VM (`nics[].ips`, donnée source) et des
   `ipAddresses` EXISTANTES du document, il calcule les enregistrements IPAM dont
   l'adresse correspond — l'utilisateur reste seul décideur du rattachement (un clic
   sur la fiche VM, cf. DetailForms.vmDetail).

   Chaque proposition porte son CONFLIT d'exclusivité éventuel (`equipment` /
   `other_vm`) : l'invariant de la spec `ipAddresses` interdit qu'une adresse vise à
   la fois un équipement et une VM (equipment_id / vm_id mutuellement exclusifs), donc
   rattacher une adresse déjà prise BASCULE son affectation — la fiche l'explicite et
   la confirme avant d'agir.

   Ce module ne connaît NI le store NI le DOM : il opère sur des tableaux nus (la VM
   et la liste des adresses), ce qui le rend testable en isolation (principes n°2/n°7).
   Il réutilise le parseur IPv4 PARTAGÉ (`src-shared/DataValidation.Ipv4`) pour le tri
   numérique — un seul analyseur d'adresse dans l'application (principe n°3).
   ============================================================================= */

/** Conflit d'exclusivité porté par une proposition :
    - `"equipment"` : l'adresse est actuellement rattachée à un ÉQUIPEMENT (equipment_id posé) ;
    - `"other_vm"`  : l'adresse est actuellement rattachée à une AUTRE VM (vm_id posé ≠ cette VM) ;
    - `null`        : l'adresse est libre (aucun rattachement) → rattachement sans bascule. */
export type VmIpConflict = "equipment" | "other_vm" | null;

/** Une proposition de rapprochement : un enregistrement `ipAddresses` existant dont l'adresse correspond
    à une IP constatée d'une vNIC de la VM, et qui n'est PAS déjà rattaché à cette VM. */
export interface VmIpSuggestion {
  /** id de l'enregistrement `ipAddresses` à rattacher — clé du `store.update` déclenché au clic. */
  id: string;
  /** Adresse IPAM, telle que STOCKÉE (« a.b.c.d ») — affichage et tri. */
  ip: string;
  /** FK → ipNetworks de l'adresse (affichage du réseau IP, comme la section des adresses liées). `null` = aucun. */
  network_id: string | null;
  /** Nom de la vNIC dont une IP constatée correspond. Si l'adresse matche PLUSIEURS vNIC, la PREMIÈRE gagne
      (ordre des `nics` puis des `ips` — choix simple, symétrique de VmNetMapping ; une adresse = une ligne). */
  nicName: string;
  /** Conflit d'exclusivité actuel (cf. VmIpConflict) — à confirmer par l'utilisateur avant bascule. */
  conflict: VmIpConflict;
  /** id de l'entité en conflit (equipment_id ou vm_id) — permet à l'UI d'en résoudre le NOM. `null` si aucun conflit. */
  conflictId: string | null;
}

export class VmIpMatch {
  /** Normalise une adresse (IP constatée d'une vNIC OU adresse IPAM stockée) pour la COMPARAISON :
      `trim`, puis suppression d'un éventuel suffixe CIDR (« 10.0.0.5/24 » → « 10.0.0.5 »). Les IPs
      constatées d'un LXC peuvent porter le préfixe (config statique « ip=… ») alors que le champ
      `ipAddresses.address` est une IPv4 nue (format validé « ipv4 ») — on retire le préfixe des DEUX
      côtés par sûreté afin qu'ils se comparent à égalité. Une valeur non-chaîne → "" (ignorée). */
  private static normAddr(raw: any): string {
    if (typeof raw !== "string") return "";
    const trimmed = raw.trim();
    const slash = trimmed.indexOf("/");
    return (slash >= 0 ? trimmed.slice(0, slash) : trimmed).trim();
  }

  /** Propositions de rapprochement pour `vm`, calculées contre les `ipAddresses` du document.
      Une adresse EST proposée si (et seulement si) elle correspond EXACTEMENT (après normalisation) à
      une IP constatée d'une vNIC de la VM ET qu'elle n'est PAS déjà rattachée à CETTE VM (une adresse
      déjà liée figure dans la section « adresses IPAM liées », pas dans les suggestions).

      `vm` et `ipAddresses` sont typés lâche (`any`) : le module ne dépend NI du modèle `Vm` NI du modèle
      `IpAddress`, il lit seulement `vm.id`/`vm.nics[].ips` et `addr.{id,address,network_id,equipment_id,vm_id}`
      (tolérance de forme). Résultat trié par valeur d'adresse croissante (adresses non parsables en fin). */
  static suggestions(vm: any, ipAddresses: any[]): VmIpSuggestion[] {
    if (!vm) return [];
    const vmId = vm.id ? String(vm.id) : "";

    // 1) Index « adresse constatée normalisée → nom de la première vNIC qui la porte ».
    //    On parcourt les vNIC dans l'ordre puis leurs IPs dans l'ordre : la PREMIÈRE occurrence gagne,
    //    garantissant une seule ligne par adresse même si plusieurs vNIC constatent la même IP.
    const byIp = new Map<string, string>();
    (Array.isArray(vm.nics) ? vm.nics : []).forEach((nic: any) => {
      const nicName = (nic && typeof nic.name === "string") ? nic.name : "";
      ((nic && Array.isArray(nic.ips)) ? nic.ips : []).forEach((ip: any) => {
        const key = VmIpMatch.normAddr(ip);
        if (key && !byIp.has(key)) byIp.set(key, nicName);
      });
    });
    if (!byIp.size) return [];

    // 2) Balayage des adresses IPAM existantes : on ne retient que celles qui matchent une IP constatée
    //    et ne sont pas déjà rattachées à cette VM. Le conflit d'exclusivité (equipment_id prioritaire,
    //    puis vm_id d'une AUTRE VM) est capté pour que l'UI avertisse et confirme la bascule.
    const out: VmIpSuggestion[] = [];
    (Array.isArray(ipAddresses) ? ipAddresses : []).forEach((addr: any) => {
      if (!addr || !addr.id) return;
      if (addr.vm_id && String(addr.vm_id) === vmId) return;   // déjà lié à CETTE VM → section « liées »
      const nicName = byIp.get(VmIpMatch.normAddr(addr.address));
      if (nicName === undefined) return;                        // aucune IP constatée ne correspond
      let conflict: VmIpConflict = null;
      let conflictId: string | null = null;
      if (addr.equipment_id) { conflict = "equipment"; conflictId = String(addr.equipment_id); }
      else if (addr.vm_id) { conflict = "other_vm"; conflictId = String(addr.vm_id); }   // vm_id ≠ vmId (exclu au-dessus)
      out.push({
        id: String(addr.id),
        ip: typeof addr.address === "string" ? addr.address : "",
        network_id: addr.network_id || null,
        nicName,
        conflict,
        conflictId,
      });
    });

    // 3) Tri par valeur d'adresse croissante (comme la section des adresses liées) ; les adresses non
    //    parsables (toInt null) sont renvoyées EN FIN, l'id départageant pour un ordre stable.
    return out.sort((a, b) => {
      const ia = Ipv4.toInt(a.ip), ib = Ipv4.toInt(b.ip);
      const va = ia == null ? Infinity : ia, vb = ib == null ? Infinity : ib;
      return va - vb || a.ip.localeCompare(b.ip) || a.id.localeCompare(b.id);
    });
  }
}
