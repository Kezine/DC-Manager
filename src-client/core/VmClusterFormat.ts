/* =============================================================================
   VUE « CLUSTERS » — logique PURE (aucun DOM, aucun store, aucun réseau).

   Sert le sous-onglet « Clusters » (cadrage .notes/vue-clusters-cadrage-2026-07-13.md,
   feature VM AMOVIBLE — cf. docs/vm-proxmox.md) :
   - `resolveHostEquipmentId` : rapproche un NŒUD Proxmox (nom court) d'un ÉQUIPEMENT
     DC Manager. C'est un MIROIR EXACT de la résolution serveur (rapprochement d'hôte v3 de
     `VmSyncService`) — TOUTE ÉVOLUTION doit être synchronisée des deux côtés —, extrait
     ici pour être testable en isolation (principes n°2/n°7) et réutilisé par la vue : la
     même règle de rapprochement s'affiche donc côté client que celle appliquée par la
     synchro sur `host_equipment_id`.
   - `uptime` / `cpuText` / `memGo` : formatage lisible des métriques d'un nœud (durée
     j/h/min, pourcentage CPU, Go avec séparateur français).

   AUCUNE dépendance au store ni au DOM : le module opère sur des tableaux/valeurs nus
   (tolérance de forme), ce qui le rend testable sans navigateur (harness.js). L'accès
   concret aux équipements/adresses IP/VMs reste dans la vue.

   NORMALISATION DES HOSTNAMES : déléguée à `HostnameMatch.norm` (module pur dédié) —
   une SEULE définition de « trim + minuscules + 1er label », partagée avec le
   rapprochement certificat (`CertTargetMatch`). Le comportement reste STRICTEMENT
   identique à l'ancienne normalisation inline (donc au miroir serveur `VmSyncService`).
   ============================================================================= */
import { HostnameMatch } from "./HostnameMatch";

/** Vue MINIMALE d'un équipement pour le rapprochement (le module ne dépend pas du modèle `Equipment`). */
export interface VmHostEquipmentRef {
  id: string;
  /** Nom DC Manager — typiquement un FQDN (« srv1.int.exemple.com ») alors que les nœuds
      Proxmox portent un nom COURT (« srv1 »), d'où le repli par premier label ci-dessous. */
  name: string;
}

/** Vue MINIMALE d'une adresse IP pour le rapprochement de NIVEAU 1 (hostnames des IP rattachées). */
export interface VmHostIpRef {
  /** FK équipement — l'IP n'entre au niveau 1 que si elle est RATTACHÉE (equipment_id posé). null sinon. */
  equipment_id: string | null;
  /** Hostname encodé sur l'IP — FQDN complet OU nom court (le 1er label sert de repli). "" = absent. */
  hostname: string;
}

export class VmClusterFormat {
  /** Rapproche un nœud (nom court) d'un équipement DC Manager — MIROIR EXACT de la résolution serveur
      (`src-server/src/vm/VmSyncService.ts`, rapprochement d'hôte v3). L'ordre, la casse et les cas
      d'ambiguïté sont IDENTIQUES — toute évolution est à synchroniser DES DEUX CÔTÉS. Hiérarchie à
      3 niveaux évaluée DANS L'ORDRE ; à CHAQUE niveau : UNIQUE → résolu ; PLUSIEURS → null (on ne
      devine pas, et on NE DESCEND PAS au niveau suivant) ; ZÉRO → niveau suivant.
        1) PRIORITAIRE — hostnames des adresses IP RATTACHÉES à un équipement (`equipment_id` posé) :
           hostname COMPLET égal OU 1er label égal (insensible à la casse, trimé). TOUTES les IP d'un
           équipement comptent ; plusieurs IP du MÊME équipement = UN candidat (dédup par équipement).
        2) nom d'équipement EXACT — insensible à la casse et trimé.
        3) premier label du FQDN du nom d'équipement (« srv1.int.exemple.com » → « srv1 »).
      `node` vide → null. `ipAddresses` (nouveau param v3) porte les hostnames du niveau 1. */
  static resolveHostEquipmentId(equipments: VmHostEquipmentRef[], ipAddresses: VmHostIpRef[], node: string): string | null {
    const nodeNorm = HostnameMatch.norm(node);
    if (!nodeNorm) return null;
    const key = nodeNorm.full;                             // clé de recherche = hostname COMPLET normalisé
    const eqs = Array.isArray(equipments) ? equipments : [];
    const ips = Array.isArray(ipAddresses) ? ipAddresses : [];

    // Construction des 3 index — MÊMES clés et MÊME dédup que VmSyncService.buildHostIndex (via Set).
    const byIpHost = new Map<string, Set<string>>();      // niveau 1 : hostname d'IP rattachée (COMPLET + 1er label) → equipment_id
    const byNameExact = new Map<string, Set<string>>();   // niveau 2 : nom d'équipement (lower, trim) → id
    const byNameLabel = new Map<string, Set<string>>();   // niveau 3 : 1er label du FQDN du nom → id
    const add = (map: Map<string, Set<string>>, k: string, id: string): void => {
      if (!k) return;
      const set = map.get(k); if (set) set.add(id); else map.set(k, new Set([id]));
    };
    for (const eq of eqs) {
      if (!eq || typeof eq.id !== "string") continue;
      const eqName = HostnameMatch.norm(eq.name);
      if (!eqName) continue;   // sans nom → seul un futur niveau 1 (IP) pourrait le trouver
      add(byNameExact, eqName.full, eq.id);
      if (eqName.full.includes(".")) add(byNameLabel, eqName.firstLabel, eq.id);   // pas un FQDN → seul le niveau 2 le trouve
    }
    for (const ip of ips) {
      if (!ip || !ip.equipment_id) continue;   // niveau 1 = IP RATTACHÉE à un équipement (equipment_id posé)
      const ipHost = HostnameMatch.norm(ip.hostname);
      if (!ipHost) continue;
      add(byIpHost, ipHost.full, ip.equipment_id);          // hostname COMPLET
      add(byIpHost, ipHost.firstLabel, ip.equipment_id);    // + PREMIER LABEL (dédup par équipement : même Set)
    }

    // Évaluation DANS L'ORDRE — premier niveau qui a des candidats TRANCHE (résolu OU ambigu), sans descendre.
    for (const map of [byIpHost, byNameExact, byNameLabel]) {
      const candidates = map.get(key);
      if (!candidates || candidates.size === 0) continue;                  // ZÉRO → niveau suivant
      return candidates.size === 1 ? [...candidates][0] : null;            // UNIQUE → résolu ; PLUSIEURS → null (ambigu)
    }
    return null;
  }

  /** Durée d'activité lisible (j / h / min) depuis des secondes. null/non-fini/négatif → « — ».
      Grain volontairement grossier (métrique d'affichage) : au-delà du jour on masque les minutes,
      au-delà de l'heure on masque les secondes ; < 1 min (ou 0) → « < 1 min ». */
  static uptime(sec: number | null): string {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    if (days > 0) return days + " j " + hours + " h";
    if (hours > 0) return hours + " h " + minutes + " min";
    if (minutes > 0) return minutes + " min";
    return "< 1 min";
  }

  /** Nombre en français à `digits` décimale(s) (séparateur virgule) — « 8,0 », « 12,3 ». */
  private static frac(n: number, digits: number): string {
    return n.toFixed(digits).replace(".", ",");
  }

  /** CPU lisible : « X % / N vCPU » depuis une FRACTION 0..1 (`cpu_used`) et un total (`cpu_total`).
      Pourcentage arrondi à l'entier. Fraction absente → part omise ; total absent → sans « / N vCPU » ;
      les deux absents → « — ». */
  static cpuText(cpuUsed: number | null, cpuTotal: number | null): string {
    const pct = (cpuUsed != null && Number.isFinite(cpuUsed)) ? Math.round(cpuUsed * 100) + " %" : null;
    const total = (cpuTotal != null && Number.isFinite(cpuTotal)) ? cpuTotal + " vCPU" : null;
    if (pct && total) return pct + " / " + total;
    if (pct) return pct;
    if (total) return total;
    return "—";
  }

  /** RAM lisible : « x,x / y,y Go » depuis des Mo (conversion /1024, une décimale, virgule française).
      Total absent → « x,x Go » ; utilisé absent mais total présent → « ? / y,y Go » ; les deux absents → « — ». */
  static memGo(usedMb: number | null, totalMb: number | null): string {
    const u = (usedMb != null && Number.isFinite(usedMb)) ? VmClusterFormat.frac(usedMb / 1024, 1) : null;
    const t = (totalMb != null && Number.isFinite(totalMb)) ? VmClusterFormat.frac(totalMb / 1024, 1) : null;
    if (u == null && t == null) return "—";
    if (t == null) return u + " Go";
    if (u == null) return "? / " + t + " Go";
    return u + " / " + t + " Go";
  }
}
