import type { Store } from "../store";

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
  /** « a.b.c.d » → entier non signé, ou null si invalide. */
  static toInt(str: string): number | null {
    if (typeof str !== "string") return null;
    const m = str.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    let n = 0;
    for (let i = 1; i <= 4; i++) { const o = +m[i]; if (o > 255) return null; n = n * 256 + o; }
    return n >>> 0;
  }

  /** Entier → « a.b.c.d ». */
  static toStr(n: number): string {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }

  /** « a.b.c.d/n » → Cidr, ou null si invalide. */
  static parseCidr(str: string): Cidr | null {
    if (typeof str !== "string") return null;
    const m = str.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
    if (!m) return null;
    const base = Ip.toInt(m[1]); const prefix = +m[2];
    if (base == null || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
    const network = (base & mask) >>> 0;
    const broadcast = (network | ((~mask) >>> 0)) >>> 0;
    const firstHost = prefix >= 31 ? network : ((network + 1) >>> 0);
    const lastHost = prefix >= 31 ? broadcast : ((broadcast - 1) >>> 0);
    const hostCount = prefix >= 31 ? (broadcast - network + 1) : Math.max(0, broadcast - network - 1);
    return { input: str.trim(), base, prefix, mask, network, broadcast,
      networkStr: Ip.toStr(network), broadcastStr: Ip.toStr(broadcast), firstHost, lastHost, hostCount };
  }

  /** CIDR canonique d'un réseau IP (objet) — null si non parsable. */
  static cidrOf(net: any): Cidr | null { return net ? Ip.parseCidr(net.cidr) : null; }

  /** L'entier d'IP appartient-il au CIDR ? */
  static inCidr(ipInt: number | null, cidr: Cidr | null): boolean {
    return cidr != null && ipInt != null && ((ipInt & cidr.mask) >>> 0) === cidr.network;
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
