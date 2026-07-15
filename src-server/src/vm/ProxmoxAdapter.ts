import type { VmProviderAdapter, ProviderConfig, ProviderInfo, VmInventory, VmClusterInfo } from "./VmProvider.js";
import { ProxmoxParse } from "./ProxmoxParse.js";
import { PveHttpPool } from "./PveHttpPool.js";

/* =============================================================================
   ADAPTATEUR PROXMOX — implémentation du contrat `VmProviderAdapter` (module
   `vm/` amovible). ORCHESTRE les appels API et délègue tout le décodage à
   `ProxmoxParse` (pur) : ici ne vivent que l'ordre des appels, la tolérance
   aux échecs partiels et l'estampillage de l'instance (`provider_id`).

   Séquence de inventory() :
     1. /cluster/status        → nom du cluster (préfixe de l'ext_id) + quorate ;
     2. /cluster/resources     → squelettes VmRecord ET nœuds du cluster (1 appel
                                 cluster-wide, SANS filtre : une seule réponse porte les deux) ;
     3. /version               → version + gamme supportée (informatif, TOLÉRANT) ;
     4. /nodes/…/config        → enrichissement par VM (description, cpu/ram, vNIC) ;
     5. /nodes/…/agent/…       → IPs réelles (QEMU allumées uniquement), AU MIEUX.

   TOLÉRANCE (exigence de cadrage « résilience aux releases ») : un échec sur la
   config d'UNE VM (supprimée/migrée entre les appels 2 et 4) conserve son
   squelette au lieu de faire échouer tout l'inventaire ; l'agent est toujours
   optionnel ; les métadonnées cluster secondaires (quorum, version) sont AU MIEUX
   (indisponibles → null). SEUL l'échec de l'inventaire de masse (appel 2) rejette —
   le moteur de synchro journalise alors et conserve l'état précédent (contrat).
   Le client HTTP est INJECTÉ (interface minimale ci-dessous) : les tests
   orchestrent l'adaptateur avec un stub route → fixture, sans réseau.
   ============================================================================= */

/** Ce que l'adaptateur EXIGE du client HTTP — interface minimale côté consommateur
    (inversion de dépendance) : `PveHttp` la satisfait structurellement, un stub de
    test aussi. Permet de tester l'orchestration sans réseau ni TLS. */
export interface PveJsonClient {
  /** GET JSON authentifié (chemin absolu "/api2/json/…"). Rejette en cas d'échec réseau/HTTP. */
  getJson(path: string): Promise<any>;
}

export class ProxmoxAdapter implements VmProviderAdapter {
  readonly kind = "proxmox";

  /** Gamme de versions MAJEURES PVE supportée (validée sur cluster réel). Hors gamme :
      test() AVERTIT sans bloquer (décision de cadrage — l'API /cluster/resources et les
      configs netN sont stables depuis PVE 7, on tente l'inventaire quand même). */
  static readonly SUPPORTED_MAJOR_MIN = 8;
  static readonly SUPPORTED_MAJOR_MAX = 9;

  constructor(
    readonly config: ProviderConfig,
    private readonly http: PveJsonClient,
  ) {}

  /** Construction STANDARD (hors tests) : POOL de nœuds dérivé de la config — bascule
      sur défaillance de joignabilité, délai par requête `timeout_sec`, épinglage TLS
      PAR endpoint (cf. PveHttpPool/PveHttp pour les invariants sécurité). */
  static fromConfig(config: ProviderConfig): ProxmoxAdapter {
    return new ProxmoxAdapter(config, PveHttpPool.fromConfig(config));
  }

  /** Joignabilité + authentification + contrôle de gamme via GET /version.
      Ne jette JAMAIS : toute erreur devient `ok: false` + message (sans jeton —
      garanti par PveHttp qui construit les messages d'erreur). */
  async test(): Promise<ProviderInfo> {
    const range = "(" + ProxmoxAdapter.SUPPORTED_MAJOR_MIN + "–" + ProxmoxAdapter.SUPPORTED_MAJOR_MAX + ")";
    try {
      const version = ProxmoxAdapter.versionOf(ProxmoxAdapter.unwrap(await this.http.getJson("/api2/json/version")));
      if (version === null) {
        // Répond mais sans version lisible : accès OK, compatibilité invérifiable → prudence sans blocage.
        return { ok: true, kind: this.kind, version: null, supported: false, message: "Proxmox joignable mais version illisible — compatibilité " + range + " non vérifiée" };
      }
      const supported = ProxmoxAdapter.isSupported(version);
      return {
        ok: true, kind: this.kind, version, supported,
        message: supported
          ? "Proxmox VE " + version + " — gamme supportée " + range
          : "Proxmox VE " + version + " — HORS gamme supportée " + range + ", l'inventaire sera tenté quand même",
      };
    } catch (e) {
      return { ok: false, kind: this.kind, version: null, supported: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Inventaire complet + état du cluster EN UN SEUL PASSAGE (cf. séquence en tête de fichier).
      Jette si l'inventaire de masse échoue ; TOLÉRANT sur les enrichissements par VM ET sur les
      métadonnées cluster secondaires (quorum, version → null si indisponibles). */
  async inventory(): Promise<VmInventory> {
    // 1) Identité + quorum du cluster (1 appel). Nom résolu ici (repli sur l'id d'instance : le
    //    parser pur ignore l'instance) pour préfixer les ext_id ET nommer le cluster de la vue.
    const status = await this.clusterStatus();
    const clusterName = status.name ?? this.config.id;

    // 2) Ressources cluster-wide SANS le filtre `?type=vm` : la MÊME réponse porte les VMs
    //    (fromClusterResources ignore les items sans vmid) ET les nœuds — zéro appel de plus.
    const resources = await this.http.getJson("/api2/json/cluster/resources");
    let records = ProxmoxParse.fromClusterResources(clusterName, resources);
    // URL de management PAR nœud GÉNÉRÉE ICI (le parseur pur ne connaît pas la config) : chaque
    // adaptateur connaît le schéma d'URL de son UI (cf. nodeManagementUrl).
    const nodes = ProxmoxParse.nodesFromClusterResources(resources)
      .map((node) => ({ ...node, management_url: this.nodeManagementUrl(node.name) }));

    // 3) Version + gamme (1 appel léger, INFORMATIF) : un échec donne version null / supported
    //    false SANS interrompre l'inventaire (la version n'est pas vitale — décision de cadrage).
    const version = await this.clusterVersion();
    // management_url du CLUSTER = RECOPIE de la config (l'URL du Proxmox Datacenter Manager, un
    // service distinct des nœuds, non déductible de l'API) — à ne pas confondre avec les liens par nœud.
    const cluster: VmClusterInfo = { name: clusterName, version: version.version, supported: version.supported, quorate: status.quorate, nodes, management_url: this.config.management_url };

    // Filtre LXC AVANT les appels de détail : pas d'appels réseau pour des records écartés.
    if (!this.config.include_lxc) records = records.filter((r) => r.vm_type !== "lxc");

    for (const record of records) {
      record.provider_id = this.config.id; // estampillage de l'instance (le parser pur l'ignore)
      const vmid = ProxmoxAdapter.vmidFromExtId(record.ext_id);
      if (record.host_node === null || vmid === "") continue; // sans nœud/vmid → pas d'appel détail possible

      try {
        const cfg = await this.http.getJson("/api2/json/nodes/" + record.host_node + "/" + record.vm_type + "/" + vmid + "/config");
        ProxmoxParse.mergeConfig(record, cfg);
      } catch {
        // VM disparue/migrée entre l'inventaire et cet appel : son squelette (nom, statut,
        // ressources max) reste dans l'inventaire — la prochaine synchro se réalignera.
      }

      // IPs réelles via guest-agent : QEMU ALLUMÉES uniquement (l'agent ne répond pas VM
      // éteinte, et les LXC exposent leur IP statique dans la config déjà fusionnée).
      if (record.vm_type === "qemu" && record.status === "running") {
        try {
          const agent = await this.http.getJson("/api2/json/nodes/" + record.host_node + "/qemu/" + vmid + "/agent/network-get-interfaces");
          ProxmoxParse.mergeAgentInterfaces(record, agent);
        } catch {
          // Agent non installé / VM sans agent : « au mieux » (cadrage) — record inchangé.
        }
      }
    }
    return { vms: records, cluster };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Identité + quorum du cluster depuis /cluster/status (1 appel). Le décodage JSON (nom +
      quorate, y compris le repli « nœud unique ») vit dans ProxmoxParse.clusterStatusInfo — ici
      ne restent que le repli dépendant de l'INSTANCE (nom absent → id du provider, décidé en
      amont) et la TOLÉRANCE à l'indisponibilité de l'endpoint (droits restreints → tout inconnu).
      ⚠ Si un nœud isolé rejoint plus tard un cluster, le préfixe d'ext_id change et la synchro
      recrée les VMs (les anciennes passent orphelines) — assumé : événement d'infra rare, purge
      manuelle des orphelines. */
  private async clusterStatus(): Promise<{ name: string | null; quorate: boolean | null }> {
    try {
      return ProxmoxParse.clusterStatusInfo(await this.http.getJson("/api2/json/cluster/status"));
    } catch {
      // /cluster/status indisponible (droits restreints ?) → nom/quorate inconnus (repli en amont).
      return { name: null, quorate: null };
    }
  }

  /** Version + appartenance à la gamme pour la MÉTADONNÉE cluster. TOLÉRANT (informatif) : un
      échec réseau/format donne { version:null, supported:false } — l'inventaire CONTINUE. Partage
      le décodage pur (versionOf/isSupported) avec test(), qui lui gère ses propres messages. */
  private async clusterVersion(): Promise<{ version: string | null; supported: boolean }> {
    try {
      const version = ProxmoxAdapter.versionOf(ProxmoxAdapter.unwrap(await this.http.getJson("/api2/json/version")));
      return { version, supported: version !== null && ProxmoxAdapter.isSupported(version) };
    } catch {
      return { version: null, supported: false };
    }
  }

  /** Numéro de version lisible depuis la réponse /version DÉBALLÉE (ex. "8.4.1"), sinon null. */
  private static versionOf(data: any): string | null {
    return data && typeof data.version === "string" && data.version !== "" ? data.version : null;
  }

  /** Version DANS la gamme MAJEURE supportée : "8.4.1" → major 8 ∈ [MIN, MAX] (le mineur n'entre pas). */
  private static isSupported(version: string): boolean {
    const major = parseInt(version, 10);
    return Number.isFinite(major)
      && major >= ProxmoxAdapter.SUPPORTED_MAJOR_MIN && major <= ProxmoxAdapter.SUPPORTED_MAJOR_MAX;
  }

  /** vmid depuis l'ext_id "<cluster>/<vmid>" — dernier segment (le nom de cluster ne
      contient pas de "/" chez Proxmox ; prendre le DERNIER segment reste correct sinon). */
  private static vmidFromExtId(extId: string): string {
    return extId.slice(extId.lastIndexOf("/") + 1);
  }

  /** Lien PROFOND de l'UI web Proxmox pointant sur UN nœud, généré par l'adaptateur (chaque
      provider connaît le schéma d'URL de son UI). POURQUOI la base du PREMIER endpoint du pool :
      l'UI Proxmox est CLUSTER-WIDE — se connecter à N'IMPORTE quel nœud permet de naviguer vers
      tous —, et l'ordre du pool = priorité (le 1er est le nœud préféré, comme pour la bascule). On
      garde l'ORIGINE (schéma+hôte+port) de l'URL d'API et on y accroche le lien profond standard
      `#v1:0:=node/<nom>` ; le nom est encodé (il apparaît dans le fragment). Le pool est GARANTI
      non vide (validation), aucun autre cas d'erreur à traiter. */
  private nodeManagementUrl(nodeName: string): string {
    const base = new URL(this.config.endpoints[0].url).origin;
    return base + "/#v1:0:=node/" + encodeURIComponent(nodeName);
  }

  /** Déballe l'enveloppe Proxmox `{ data: … }` (tolère une réponse déjà déballée). */
  private static unwrap(json: any): any {
    if (json && typeof json === "object" && !Array.isArray(json) && "data" in json) return json.data;
    return json;
  }
}
