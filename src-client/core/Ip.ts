import type { Store } from "../store";
import { Ipv4 } from "../../src-shared/DataValidation";

/** CIDR analysé. */
export interface Cidr {
  input: string; base: number; prefix: number; mask: number;
  network: number; broadcast: number; networkStr: string; broadcastStr: string;
  firstHost: number; lastHost: number; hostCount: number;
}

/* Helpers IPv4 / CIDR. Le calcul est PUR (testable) ; les allocateurs qui
   interrogent le modèle prennent le store en paramètre. Remplace les fonctions
   libres ipv4ToInt / intToIpv4 / parseCidr / ipNetCidr / ipIntInCidr /
   nextFreeIp / dhcpRangeContaining / ipNetworkShort. */
export class Ip {
  /** « a.b.c.d » → entier non signé, ou null si invalide. DÉLÉGUÉ au parseur IPv4 PARTAGÉ
      (`shared/DataValidation.ipv4ToInt`) → un seul analyseur, réutilisé par la validation. */
  static toInt(str: string): number | null {
    return Ipv4.toInt(str);
  }

  /** Entier → « a.b.c.d ». */
  static toStr(n: number): string {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }

  /** « a.b.c.d/n » → Cidr enrichi, ou null si invalide. Le parsing de BASE (base/prefix/mask/network) est DÉLÉGUÉ
      au parseur PARTAGÉ ; on n'ajoute ici que les champs dérivés (broadcast, hôtes) propres à l'UI. */
  static parseCidr(str: string): Cidr | null {
    const parsed = Ipv4.parseCidr(str);
    if (!parsed) return null;
    const { base, prefix, mask, network } = parsed;
    const broadcast = (network | ((~mask) >>> 0)) >>> 0;
    const firstHost = prefix >= 31 ? network : ((network + 1) >>> 0);
    const lastHost = prefix >= 31 ? broadcast : ((broadcast - 1) >>> 0);
    const hostCount = prefix >= 31 ? (broadcast - network + 1) : Math.max(0, broadcast - network - 1);
    return { input: str.trim(), base, prefix, mask, network, broadcast,
      networkStr: Ip.toStr(network), broadcastStr: Ip.toStr(broadcast), firstHost, lastHost, hostCount };
  }

  /** CIDR canonique d'un réseau IP (objet) — null si non parsable. */
  static cidrOf(net: any): Cidr | null { return net ? Ip.parseCidr(net.cidr) : null; }

  /** L'entier d'IP appartient-il au CIDR ? DÉLÉGUÉ au prédicat PARTAGÉ (le Cidr enrichi a `mask`+`network`). */
  static inCidr(ipInt: number | null, cidr: Cidr | null): boolean {
    return Ipv4.inCidr(ipInt, cidr);
  }

  /** Libellé court d'un réseau IP (label · cidr). */
  static short(net: any): string {
    if (!net) return "—";
    const bits = [net.label, net.cidr].filter(Boolean);
    return bits.join(" · ") || "(réseau)";
  }

  /** Première IP libre d'un réseau (ni statique, ni dans une plage DHCP) — string|null. */
  static nextFree(store: Store, netId: string): string | null {
    const cidr = Ip.cidrOf(store.get("ipNetworks", netId));
    if (!cidr) return null;
    const taken = new Set(store.ipAddressesOfNetwork(netId).map((a: any) => Ip.toInt(a.address)).filter((v) => v != null));
    const ranges = store.dhcpRangesOfNetwork(netId).map((r: any) => [Ip.toInt(r.start_ip), Ip.toInt(r.end_ip)]).filter((p) => p[0] != null && p[1] != null) as [number, number][];
    for (let n = cidr.firstHost; n <= cidr.lastHost; n++) {
      if (taken.has(n)) continue;
      if (ranges.some(([s, e]) => n >= s && n <= e)) continue;
      return Ip.toStr(n >>> 0);
    }
    return null;
  }

  /** Plage DHCP du réseau contenant cette IP (entier) — l'entité ou null. */
  static dhcpRangeContaining(store: Store, netId: string, ipInt: number | null, exceptId?: string): any {
    if (ipInt == null) return null;
    return store.dhcpRangesOfNetwork(netId).find((r: any) => {
      if (r.id === exceptId) return false;
      const s = Ip.toInt(r.start_ip), e = Ip.toInt(r.end_ip);
      return s != null && e != null && ipInt >= s && ipInt <= e;
    }) || null;
  }
}
