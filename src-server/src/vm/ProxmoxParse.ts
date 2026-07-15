import type { VmRecord, VmNic, VmClusterNode } from "./VmProvider.js";

/* =============================================================================
   PARSING PROXMOX PUR — module `vm/` AMOVIBLE. Transforme les réponses JSON de
   l'API Proxmox VE (8/9) en pivot `VmRecord` (cf. VmProvider.ts). Classe à
   MÉTHODES STATIQUES, entièrement PURE : aucun accès réseau, aucun import Node
   API — testable en isolation (fixtures JSON → VmRecord).

   Principe directeur = TOLÉRANCE (exigence de cadrage « résilience aux releases
   Proxmox ») : une clé inconnue est ignorée, une valeur manquante devient null,
   une chaîne malformée renvoie ce qui est extractible SANS jamais jeter. Le
   contrat `VmRecord` isole ainsi tout le reste de l'application des évolutions
   d'API du provider. La responsabilité de l'ACCÈS réseau et de l'orchestration
   (quels appels, dans quel ordre) reste à l'adaptateur (ProxmoxAdapter, T1.3) ;
   ici on ne fait que DÉCODER des réponses déjà obtenues.
   ============================================================================= */

/** Résultat du décodage d'UNE chaîne de config d'interface Proxmox (clé `netN`).
    Structure de travail intermédiaire — mappée ensuite sur `VmNic` par mergeConfig.
    Champs absents de la chaîne → null (le nom d'interface `name` n'existe que pour
    LXC ; côté QEMU il vient de la CLÉ netN, pas de la chaîne). */
export interface ParsedNet {
  /** Modèle de carte QEMU (virtio/e1000/… — la clé dont la valeur est une MAC). null en LXC. */
  model: string | null;
  /** Nom interne de l'interface (LXC : `name=eth0`). null en QEMU. */
  name: string | null;
  /** Adresse MAC (QEMU : valeur du modèle ; LXC : `hwaddr=`). */
  mac: string | null;
  /** Bridge/vSwitch hôte (`bridge=vmbr0`). */
  bridge: string | null;
  /** Tag VLAN (`tag=42`). null = pas de tag / valeur non numérique. */
  vlan_tag: number | null;
  /** IP STATIQUE sans préfixe CIDR (LXC : `ip=10.0.0.5/24` → "10.0.0.5"). dhcp/manual → null. */
  ip: string | null;
}

/** Clés de configuration réseau qui NE sont JAMAIS un modèle de carte : sans cela,
    une clé au format keyword porteuse d'une valeur MAC pourrait être confondue avec
    un modèle. Les clés traitées explicitement (bridge/tag/name/hwaddr/ip) sont déjà
    court-circuitées ; ceci ne couvre que le repli « valeur au format MAC » du default. */
const RESERVED_NET_KEYS = new Set<string>([
  "gw", "gw6", "ip6", "firewall", "mtu", "rate", "queues", "link_down", "trunks", "mac",
]);

export class ProxmoxParse {
  /* --------------------------------------------------------------------------
     1) CHAÎNE D'INTERFACE (netN)
     -------------------------------------------------------------------------- */

  /** Décode une chaîne de config d'interface Proxmox (QEMU ou LXC).
      QEMU : "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42,firewall=1"
             → le MODÈLE est la clé dont la valeur est une MAC (virtio/e1000/…).
      LXC  : "name=eth0,bridge=vmbr0,hwaddr=AA:…,ip=10.0.0.5/24,gw=…,tag=42"
             → mac depuis `hwaddr`, IP statique depuis `ip` (CIDR retiré).
      TOLÉRANT : segment sans "=" ignoré, clé inconnue ignorée, chaîne vide/nulle
      → tout à null. Ne jette jamais. */
  static parseNetString(raw: string | null | undefined): ParsedNet {
    const result: ParsedNet = { model: null, name: null, mac: null, bridge: null, vlan_tag: null, ip: null };
    if (typeof raw !== "string" || raw.trim() === "") return result;

    // La MAC peut provenir de deux sources mutuellement exclusives selon le type :
    // `hwaddr=` (LXC) ou la valeur du modèle (QEMU). On collecte les deux et on
    // privilégie hwaddr — le plus explicite — au moment de fixer result.mac.
    let hwaddrMac: string | null = null;
    let modelMac: string | null = null;

    for (const segment of raw.split(",")) {
      const eq = segment.indexOf("=");
      if (eq < 0) continue; // segment sans "=" (ex. drapeau isolé) → ignoré, tolérance
      const key = segment.slice(0, eq).trim().toLowerCase();
      const value = segment.slice(eq + 1).trim();
      if (key === "") continue;
      switch (key) {
        case "bridge": result.bridge = value || null; break;
        case "tag": result.vlan_tag = ProxmoxParse.parseVlanTag(value); break;
        case "name": result.name = value || null; break;
        case "hwaddr": if (ProxmoxParse.isMac(value)) hwaddrMac = value; break;
        case "ip": result.ip = ProxmoxParse.parseStaticIp(value); break;
        default:
          // Détection du modèle par la FORME de la valeur (une MAC) plutôt que par une
          // liste figée de modèles : un modèle introduit par une future release Proxmox
          // reste ainsi reconnu (résilience aux releases).
          if (!RESERVED_NET_KEYS.has(key) && ProxmoxParse.isMac(value)) {
            result.model = key;
            modelMac = value;
          }
          break;
      }
    }
    result.mac = hwaddrMac ?? modelMac;
    return result;
  }

  /* --------------------------------------------------------------------------
     2) INVENTAIRE DE MASSE (GET /cluster/resources — avec ou SANS ?type=vm)
     -------------------------------------------------------------------------- */

  /** Construit les SQUELETTES de VmRecord depuis la réponse `/cluster/resources`
      (1 appel cluster-wide). Fonctionne AUSSI BIEN sur la réponse filtrée (`?type=vm`) que
      sur la réponse COMPLÈTE : les entrées sans `vmid` (nœuds, stockages, pools…) sont ignorées
      par le garde ci-dessous — c'est ce qui permet à l'adaptateur d'appeler l'endpoint SANS
      filtre et d'en tirer VMs (ici) ET nœuds (nodesFromClusterResources) en UNE seule réponse.
      Enrichis ensuite par mergeConfig / mergeAgentInterfaces.
      - ext_id = clusterName + "/" + vmid (clé de réconciliation stable) ;
      - provider_id laissé VIDE : le parser pur ignore l'instance d'adaptateur,
        c'est l'adaptateur (T1.3) qui estampille `ProviderConfig.id` ;
      - TEMPLATES EXCLUS (`template === 1`) — décision de cadrage ;
      - status conservé TEL QUEL (valeur inconnue tolérée) ;
      - maxmem (octets) → Mo, maxdisk (octets) → Go ;
      - tags séparés par `;` (séparateur canonique Proxmox). */
  static fromClusterResources(clusterName: string, json: any): VmRecord[] {
    const items = ProxmoxParse.asArray(ProxmoxParse.unwrapData(json));
    const records: VmRecord[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.template === 1 || item.template === "1") continue; // templates exclus (cadrage)
      const vmid = item.vmid;
      if (vmid === undefined || vmid === null || vmid === "") continue; // sans identité stable → inréconciliable
      records.push({
        ext_id: clusterName + "/" + vmid,
        provider_id: "", // estampillé par l'adaptateur (T1.3) : le parser pur ne connaît pas l'instance
        vm_type: item.type === "lxc" ? "lxc" : "qemu",
        name: typeof item.name === "string" ? item.name : "",
        description: "",
        status: typeof item.status === "string" ? item.status : "", // valeur inconnue conservée telle quelle
        host_node: typeof item.node === "string" ? item.node : null,
        cpu: ProxmoxParse.toNum(item.maxcpu),
        ram_mb: ProxmoxParse.bytesToMb(item.maxmem),
        disk_gb: ProxmoxParse.bytesToGb(item.maxdisk),
        tags: ProxmoxParse.parseTags(item.tags),
        nics: [],
      });
    }
    return records;
  }

  /* --------------------------------------------------------------------------
     2bis) NŒUDS DU CLUSTER (mêmes entrées `type:"node"` de /cluster/resources)
     -------------------------------------------------------------------------- */

  /** Extrait les NŒUDS et leurs métriques instantanées de la MÊME réponse `/cluster/resources`
      que fromClusterResources (zéro appel supplémentaire — cadrage vue « Clusters »). Ne garde
      que les entrées `type:"node"` ; les VMs/stockages/pools sont ignorés.
      - name  = champ `node` (identité courte du nœud) ; entrée sans nom → écartée (tolérance) ;
      - online = statut "online" (tout autre statut / absent → hors ligne) ;
      - cpu_used = `cpu`, FRACTION déjà 0..1 chez Proxmox (l'UI formate en %) ;
      - cpu_total = `maxcpu` ; mem/maxmem (OCTETS) → Mo via bytesToMb (même unité que ram_mb) ;
      - uptime_sec = `uptime` (secondes).
      TOLÉRANT comme le reste du fichier : item malformé ignoré, valeur manquante → null, jamais de throw. */
  static nodesFromClusterResources(json: any): VmClusterNode[] {
    const items = ProxmoxParse.asArray(ProxmoxParse.unwrapData(json));
    const nodes: VmClusterNode[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "node") continue; // seules les entrées nœud (les VMs sont pour fromClusterResources)
      const name = typeof item.node === "string" && item.node !== "" ? item.node : null;
      if (name === null) continue; // nœud sans identité → écarté (name n'est PAS nullable dans le pivot)
      nodes.push({
        name,
        online: item.status === "online", // statut inconnu/absent → hors ligne (prudence)
        cpu_used: ProxmoxParse.toNum(item.cpu),   // fraction 0..1 telle quelle
        cpu_total: ProxmoxParse.toNum(item.maxcpu),
        mem_used_mb: ProxmoxParse.bytesToMb(item.mem),
        mem_total_mb: ProxmoxParse.bytesToMb(item.maxmem),
        uptime_sec: ProxmoxParse.toNum(item.uptime),
        // Le lien profond de l'UI est GÉNÉRÉ par l'adaptateur (il connaît le pool d'endpoints et le
        // schéma d'URL Proxmox) — le parseur PUR ignore la config, il pose donc null ici.
        management_url: null,
      });
    }
    return nodes;
  }

  /* --------------------------------------------------------------------------
     2ter) IDENTITÉ + QUORUM DU CLUSTER (GET /cluster/status)
     -------------------------------------------------------------------------- */

  /** Décode `/cluster/status` : NOM du cluster + état de QUORUM. PUR et tolérant — le décodage
      JSON vit ici (testable par fixtures), l'adaptateur ne garde que le repli dépendant de
      l'instance (nom absent → id du provider). Choix de cadrage : l'extraction du nom vivait
      dans l'adaptateur ; on la SORT ici pour la mutualiser avec l'extraction du quorate (même
      réponse, même logique tolérante) — l'adaptateur ne conserve que ce qu'il est SEUL à savoir.
      - name : entrée `type:"cluster"` nommée ; sinon nœud UNIQUE (installation isolée : son nom
        est une identité stable) ; sinon null (repli DÉCIDÉ par l'appelant, seul à connaître l'instance) ;
      - quorate : champ `quorate` (0/1) de l'entrée cluster → booléen ; PAS d'entrée cluster
        (nœud isolé) → null (le quorum n'a pas de sens hors cluster : inconnu, pas « faux »). */
  static clusterStatusInfo(json: any): { name: string | null; quorate: boolean | null } {
    const items = ProxmoxParse.asArray(ProxmoxParse.unwrapData(json));
    const cluster = items.find((i) => i && typeof i === "object" && i.type === "cluster");
    // quorate n'a de sens qu'AVEC une entrée cluster : un nœud isolé n'a pas de quorum → inconnu (null).
    const quorate = cluster ? ProxmoxParse.quorateFlag(cluster.quorate) : null;
    if (cluster && typeof cluster.name === "string" && cluster.name !== "") {
      return { name: cluster.name, quorate };
    }
    // Sans cluster nommé : installation isolée → le nom du nœud UNIQUE sert d'identité stable.
    const nodes = items.filter((i) => i && typeof i === "object" && i.type === "node" && typeof i.name === "string" && i.name !== "");
    return { name: nodes.length === 1 ? nodes[0].name : null, quorate };
  }

  /* --------------------------------------------------------------------------
     3) DÉTAIL PAR VM (GET /nodes/{node}/{qemu|lxc}/{vmid}/config)
     -------------------------------------------------------------------------- */

  /** Enrichit un record depuis sa config détaillée. FUSION TOLÉRANTE : on n'écrase
      JAMAIS une valeur déjà présente par null/undefined (une valeur absente de la
      config laisse le squelette intact).
      - description : notes libres côté provider ;
      - cpu : cores × sockets (QEMU) ou cores (LXC) si `cores` présent ;
      - ram_mb : champ `memory` (déjà en Mo chez Proxmox) si présent ;
      - nics : clés `netN` triées NUMÉRIQUEMENT (net0, net1, … net10), via parseNetString. */
  static mergeConfig(record: VmRecord, configJson: any): VmRecord {
    const cfg = ProxmoxParse.unwrapData(configJson);
    if (!cfg || typeof cfg !== "object") return record;

    if (typeof cfg.description === "string") record.description = cfg.description;

    const cpu = ProxmoxParse.cpuFromConfig(record.vm_type, cfg);
    if (cpu !== null) record.cpu = cpu;

    const memoryMb = ProxmoxParse.toNum(cfg.memory); // Proxmox : `memory` est déjà en Mo (MiB)
    if (memoryMb !== null) record.ram_mb = memoryMb;

    const nics = ProxmoxParse.nicsFromConfig(cfg);
    if (nics.length > 0) record.nics = nics; // pas de netN → on garde les nics existants (fusion tolérante)

    return record;
  }

  /* --------------------------------------------------------------------------
     4) IP RÉELLES via guest-agent (GET …/qemu/{vmid}/agent/network-get-interfaces)
     -------------------------------------------------------------------------- */

  /** Enrichit les `nics[].ips` depuis la réponse du guest-agent. Rapprochement PAR
      MAC (insensible à la casse). Filtre le loopback (127.0.0.0/8, ::1) et le
      link-local IPv6 (fe80::/10). L'agent est OPTIONNEL : absent, en erreur ou de
      format inattendu → record INCHANGÉ, jamais de throw (synchro « au mieux »). */
  static mergeAgentInterfaces(record: VmRecord, agentJson: any): VmRecord {
    const data = ProxmoxParse.unwrapData(agentJson);
    let interfaces: any[];
    if (data && typeof data === "object" && Array.isArray((data as any).result)) interfaces = (data as any).result;
    else if (Array.isArray(data)) interfaces = data;
    else return record; // format inattendu (agent absent/erreur) → inchangé

    // Index des vNIC par MAC (minuscule) : le rapprochement se fait sur ce pivot.
    const byMac = new Map<string, VmNic>();
    for (const nic of record.nics) {
      if (nic.mac) byMac.set(nic.mac.toLowerCase(), nic);
    }
    if (byMac.size === 0) return record; // aucune MAC connue → rien à rapprocher

    for (const iface of interfaces) {
      if (!iface || typeof iface !== "object") continue;
      const mac = iface["hardware-address"];
      if (typeof mac !== "string") continue;
      const nic = byMac.get(mac.toLowerCase());
      if (!nic) continue; // interface sans vNIC correspondant → ignorée
      const addresses = iface["ip-addresses"];
      if (!Array.isArray(addresses)) continue;
      for (const entry of addresses) {
        if (!entry || typeof entry !== "object") continue;
        const ip = entry["ip-address"];
        if (typeof ip !== "string" || ip === "") continue;
        if (ProxmoxParse.isLoopbackOrLinkLocal(ip)) continue; // loopback / link-local filtrés
        if (!nic.ips.includes(ip)) nic.ips.push(ip); // dédup (l'IP statique LXC peut déjà y être)
      }
    }
    return record;
  }

  /* --------------------------------------------------------------------------
     Helpers internes (privés) — décodage tolérant de valeurs
     -------------------------------------------------------------------------- */

  /** Déballe l'enveloppe Proxmox `{ data: … }` si présente, sinon renvoie tel quel
      (tolérance : accepte aussi bien la réponse brute que le contenu déjà déballé). */
  private static unwrapData(json: any): any {
    if (json && typeof json === "object" && !Array.isArray(json) && "data" in json) return json.data;
    return json;
  }

  private static asArray(value: any): any[] {
    return Array.isArray(value) ? value : [];
  }

  /** Convertit une valeur en nombre fini, sinon null (accepte les nombres et les
      chaînes numériques que Proxmox renvoie parfois). */
  private static toNum(value: any): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /** Octets → Mo (base 1024, cohérent avec les Mio de Proxmox). null si non numérique. */
  private static bytesToMb(bytes: any): number | null {
    const n = ProxmoxParse.toNum(bytes);
    return n === null ? null : Math.round(n / (1024 * 1024));
  }

  /** Octets → Go (base 1024). null si non numérique. */
  private static bytesToGb(bytes: any): number | null {
    const n = ProxmoxParse.toNum(bytes);
    return n === null ? null : Math.round(n / (1024 * 1024 * 1024));
  }

  /** Tags Proxmox : chaîne séparée par `;` → tableau nettoyé (vides écartés). */
  private static parseTags(tags: any): string[] {
    if (typeof tags !== "string") return [];
    return tags.split(";").map((t) => t.trim()).filter((t) => t !== "");
  }

  private static isMac(value: string): boolean {
    return /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(value);
  }

  /** Tag VLAN : entier non signé, sinon null (valeur non numérique tolérée). */
  private static parseVlanTag(value: string): number | null {
    return /^\d+$/.test(value) ? parseInt(value, 10) : null;
  }

  /** Drapeau quorate Proxmox (0/1, parfois déjà booléen) → booléen ; absent/illisible → null
      (inconnu — on ne confond pas « quorum perdu » avec « quorum non renseigné »). */
  private static quorateFlag(value: any): boolean | null {
    if (value === 1 || value === "1" || value === true) return true;
    if (value === 0 || value === "0" || value === false) return false;
    return null;
  }

  /** IP statique LXC : "dhcp"/"manual"/"auto" → null (pas d'adresse fixe) ;
      sinon retire le préfixe CIDR ("10.0.0.5/24" → "10.0.0.5"). */
  private static parseStaticIp(value: string): string | null {
    if (!value) return null;
    const low = value.toLowerCase();
    if (low === "dhcp" || low === "manual" || low === "auto") return null;
    const addr = value.split("/")[0].trim();
    return addr || null;
  }

  /** vCPU depuis la config : QEMU = cores × sockets (sockets défaut 1), LXC = cores.
      null si `cores` absent → mergeConfig conserve alors la valeur du squelette. */
  private static cpuFromConfig(vmType: string, cfg: any): number | null {
    const cores = ProxmoxParse.toNum(cfg.cores);
    if (cores === null) return null;
    if (vmType === "qemu") {
      const sockets = ProxmoxParse.toNum(cfg.sockets);
      return cores * (sockets ?? 1);
    }
    return cores; // lxc : pas de notion de sockets
  }

  /** Construit les VmNic depuis les clés `netN` de la config, triées NUMÉRIQUEMENT
      (net0, net1, … net10 — un tri lexical placerait net10 avant net2). */
  private static nicsFromConfig(cfg: any): VmNic[] {
    const keys = Object.keys(cfg).filter((k) => /^net\d+$/.test(k));
    keys.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    const nics: VmNic[] = [];
    for (const key of keys) {
      const raw = cfg[key];
      if (typeof raw !== "string") continue;
      const parsed = ProxmoxParse.parseNetString(raw);
      nics.push({
        name: parsed.name ?? key, // LXC : nom interne (eth0) ; QEMU : la clé (net0)
        mac: parsed.mac,
        bridge: parsed.bridge,
        vlan_tag: parsed.vlan_tag,
        ips: parsed.ip ? [parsed.ip] : [], // IP statique LXC ; l'agent complètera pour QEMU
      });
    }
    return nics;
  }

  /** Vrai si l'IP est du loopback (127.0.0.0/8, ::1) ou du link-local IPv6 (fe80::/10)
      — adresses non pertinentes pour l'inventaire (filtrées côté agent). */
  private static isLoopbackOrLinkLocal(ip: string): boolean {
    const addr = ip.trim().toLowerCase();
    if (addr === "::1") return true;        // loopback IPv6
    if (/^127\./.test(addr)) return true;   // loopback IPv4 (127.0.0.0/8)
    if (addr.includes(":")) {               // IPv6 : test du link-local fe80::/10
      const firstGroup = addr.split(":")[0];
      if (firstGroup === "") return false;  // "::…" abrégé → pas fe80
      const hextet = parseInt(firstGroup, 16);
      if (Number.isFinite(hextet) && (hextet & 0xffc0) === 0xfe80) return true;
    }
    return false;
  }
}
