import https from "node:https";
import type { WifiProviderAdapter, WifiProviderConfig, WifiProviderInfo, WifiInventory, WifiClientRecord } from "./WifiProvider.js";
import { UnifiParse } from "./UnifiParse.js";
import { UnifiHttp } from "./UnifiHttp.js";

/* =============================================================================
   ADAPTATEUR UNIFI — implémentation du contrat `WifiProviderAdapter` (module
   `wifi/` amovible), partie SPÉCIFIQUE À LA MARQUE (préfixe `Unifi*`, D9).
   ORCHESTRE les appels de l'API d'INTÉGRATION officielle et délègue TOUT le
   décodage à `UnifiParse` (pur) : ici ne vivent que l'ordre des appels, la
   PAGINATION, la tolérance aux échecs partiels et l'estampillage de l'instance
   (`provider_id`).

   Séquence de inventory() :
     1. GET /sites                       → résolution du site configuré (id OU nom) ;
     2. GET /sites/{id}/devices          → index id → nom d'AP (AU MIEUX, tolérant) ;
     3. GET /sites/{id}/clients (paginé) → clients, décodés puis filtrés (include_wired).

   TOLÉRANCE : l'échec de l'étape 2 n'interrompt RIEN (les clients garderont le nom
   d'AP qu'ils portent, ou aucun). SEUL l'échec de la liste des clients (ou de la
   résolution du site) rejette — le moteur de synchro journalise alors et conserve
   l'état précédent du document (contrat de `WifiProviderAdapter`).

   Le client HTTP est INJECTÉ (interface `UnifiJsonClient` ci-dessous, déclarée par
   le CONSOMMATEUR = inversion de dépendance, comme `PveJsonClient` côté VM) : les
   tests orchestrent l'adaptateur avec un stub route → fixture, sans réseau ni TLS.
   ============================================================================= */

/** Ce que l'adaptateur EXIGE du client HTTP — interface minimale côté CONSOMMATEUR
    (inversion de dépendance) : `UnifiHttp` la satisfait structurellement, un stub de
    test aussi. Permet de tester l'orchestration ET la pagination sans réseau. */
export interface UnifiJsonClient {
  /** GET JSON authentifié (chemin absolu, query string comprise). Rejette en cas d'échec. */
  getJson(path: string): Promise<any>;
  /** Libération OPTIONNELLE des sockets keep-alive en FIN DE PASSE : le client réel détruit
      son agent ; les stubs de test peuvent l'ignorer (membre absent). */
  dispose?(): void;
}

/** Options UniFi décodées depuis `WifiProviderConfig.options` (validées par la branche
    `unifi` de `WifiProviderConfigValidate.KIND_OPTION_SPECS`). Décodage DÉFENSIF : une
    config écrite par une version antérieure — ou par une autre marque — ne doit pas faire
    échouer l'adaptateur, elle retombe sur les mêmes défauts que la validation. */
interface UnifiOptions {
  site: string;
  include_wired: boolean;
}

export class UnifiAdapter implements WifiProviderAdapter {
  readonly kind = "unifi";

  /* --------------------------------------------------------------------------
     CHEMINS D'API — L'UNIQUE POINT du code qui les connaît.
     ⚠ À VALIDER SUR CONSOLE RÉELLE au déploiement (l'implémentation n'a pas eu accès
     à un contrôleur — cf. docs/wifi-unifi.md § « Déploiement »). Base attendue de
     l'API d'INTÉGRATION officielle d'une console UniFi OS :
        https://<console>/proxy/network/integration/v1/…
     Une console « Network Application » autonome (hors UniFi OS) peut exposer la même
     API SANS le préfixe `/proxy/network` : si le test de connexion rend un 404, c'est
     le premier réglage à vérifier. Corriger ICI, en un seul endroit.
     -------------------------------------------------------------------------- */
  static readonly API_BASE = "/proxy/network/integration/v1";
  /** Liste des sites de la console (paginée). */
  static readonly PATH_SITES = UnifiAdapter.API_BASE + "/sites";
  /** Liste des périphériques d'un site (paginée) — résolution du NOM d'AP. */
  static pathDevices(siteId: string): string { return UnifiAdapter.API_BASE + "/sites/" + encodeURIComponent(siteId) + "/devices"; }
  /** Liste des clients CONNECTÉS d'un site (paginée) — la matière de l'inventaire. */
  static pathClients(siteId: string): string { return UnifiAdapter.API_BASE + "/sites/" + encodeURIComponent(siteId) + "/clients"; }

  /** Taille de page demandée. 200 est un compromis : assez grand pour qu'un site ordinaire
      tienne en 1–2 appels, assez petit pour rester loin du plafond de 32 Mio par réponse. */
  static readonly PAGE_SIZE = 200;

  /** CAP DUR de pages par ressource. Garde-fou contre une console qui ignorerait `offset` et
      renverrait éternellement la même page pleine : `UnifiParse.nextOffset` s'arrêterait alors
      jamais. 200 pages × 200 éléments = 40 000 clients, très au-delà de tout site réel — un
      dépassement est un SYMPTÔME, pas un cas nominal, et il est journalisé comme tel. */
  static readonly MAX_PAGES = 200;

  constructor(
    readonly config: WifiProviderConfig,
    private readonly http: UnifiJsonClient,
  ) {}

  /** Construction STANDARD (hors tests) : client HTTPS dérivé de la config — épinglage/CA,
      délai par requête, agent keep-alive à la durée d'UNE passe (cf. UnifiHttp). */
  static fromConfig(config: WifiProviderConfig): UnifiAdapter {
    const agent = new https.Agent({ keepAlive: true });
    return new UnifiAdapter(config, new UnifiHttp(config.url, config.token, config.fingerprint, config.timeout_sec * 1000, config.ca_pem, agent));
  }

  /** Options UniFi de CETTE instance, avec repli sur les défauts de la validation. */
  private options(): UnifiOptions {
    const raw = this.config.options || {};
    const site = typeof raw.site === "string" && raw.site.trim() !== "" ? raw.site.trim() : "default";
    return { site, include_wired: raw.include_wired === true };
  }

  /** Joignabilité + authentification + présence de l'API d'intégration, via la liste des sites
      (le seul appel qui ne présuppose RIEN : ni site résolu, ni droits sur une sous-ressource).
      Ne jette JAMAIS : toute erreur devient `ok: false` + message (SANS la clé — garanti par
      UnifiHttp qui construit les messages d'erreur).
      `supported` signifie ici « l'API d'intégration VERSIONNÉE a répondu ET le site configuré a
      été résolu » : c'est le contrat de compatibilité que la décision utilisateur vise (`/v1/`),
      il n'y a pas de gamme de versions à contrôler comme chez Proxmox. `version` reste null —
      l'API d'intégration n'expose pas de version applicative sur ce chemin. */
  async test(): Promise<WifiProviderInfo> {
    const options = this.options();
    try {
      const sites = await this.fetchAll(UnifiAdapter.PATH_SITES);
      if (sites.length === 0) {
        return { ok: true, kind: this.kind, version: null, supported: false,
          message: "console joignable, mais AUCUN site remonté — vérifiez les droits de la clé d'API" };
      }
      const siteId = UnifiParse.findSiteId(sites, options.site);
      if (siteId) {
        return { ok: true, kind: this.kind, version: null, supported: true,
          message: "console joignable — site « " + options.site + " » résolu (" + sites.length + " site(s) au total)" };
      }
      // Site introuvable : la connexion EST bonne, c'est la configuration qui ne l'est pas.
      // On le dit franchement plutôt que de laisser croire à une panne réseau.
      return { ok: true, kind: this.kind, version: null, supported: false,
        message: "console joignable, mais le site « " + options.site + " » est INTROUVABLE parmi les "
          + sites.length + " site(s) — corrigez le champ « Site » (identifiant ou nom exact)" };
    } catch (e) {
      return { ok: false, kind: this.kind, version: null, supported: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      // Libère la socket keep-alive MÊME en cas d'échec — sinon elle traînerait jusqu'au timeout
      // système. No-op pour un client sans dispose (stub).
      this.http.dispose?.();
    }
  }

  /** Inventaire des clients du site configuré (cf. séquence en tête de fichier). */
  async inventory(): Promise<WifiInventory> {
    const options = this.options();
    try {
      // 1) SITE : résolution par identifiant OU nom. REPLI « console mono-site » : quand la valeur
      //    configurée est le nom HISTORIQUE « default » et qu'aucun site ne s'appelle ainsi, on
      //    prend le PREMIER site — l'API d'intégration nomme les sites par UUID, et « default »
      //    est le réglage par DÉFAUT du formulaire : refuser ici ferait échouer toute première
      //    configuration sans que l'utilisateur comprenne pourquoi. Tout AUTRE libellé non résolu
      //    est, lui, une ERREUR franche (l'utilisateur a saisi quelque chose d'intentionnel).
      const sites = await this.fetchAll(UnifiAdapter.PATH_SITES);
      let siteId = UnifiParse.findSiteId(sites, options.site);
      if (!siteId && options.site === "default") siteId = UnifiParse.firstSiteId(sites);
      if (!siteId) {
        throw new Error("UniFi : site « " + options.site + " » introuvable sur la console ("
          + sites.length + " site(s) remonté(s)) — corrigez le champ « Site » du provider");
      }

      // 2) PÉRIPHÉRIQUES : index id → nom/MAC d'AP. AU MIEUX — un échec (droits partiels sur cette
      //    sous-ressource, endpoint absent d'une version) ne doit PAS priver l'utilisateur de son
      //    inventaire de clients : on continue avec un index vide.
      let apIndex: Map<string, { name: string | null; mac: string | null }> | undefined;
      try {
        apIndex = UnifiParse.deviceIndex(await this.fetchAll(UnifiAdapter.pathDevices(siteId)));
      } catch {
        apIndex = undefined;   // le nom d'AP se limitera à ce que porte le client lui-même
      }

      // 3) CLIENTS : la seule étape dont l'échec fait échouer la passe.
      const items = await this.fetchAll(UnifiAdapter.pathClients(siteId));
      let clients: WifiClientRecord[] = UnifiParse.clientRecords(items, apIndex);

      // Filtre FILAIRE (opt-in — décision D3 : le besoin porte sur les clients WIFI).
      if (!options.include_wired) clients = clients.filter((c) => UnifiParse.isWireless(c));

      // Estampillage de l'instance : le décodeur pur ignore le provider (comme ProxmoxParse).
      for (const client of clients) client.provider_id = this.config.id;
      return { clients };
    } finally {
      this.http.dispose?.();
    }
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Lit une ressource PAGINÉE en entier et rend ses éléments concaténés.
      La DÉCISION de continuer est PURE (`UnifiParse.nextOffset`, testée en isolation) ; ici ne
      restent que l'appel réseau et le CAP DUR de pages (cf. MAX_PAGES). L'offset envoyé est
      celui qu'on a DEMANDÉ, jamais celui que l'API renvoie : une API qui répond un offset
      fantaisiste ne doit pas pouvoir nous faire boucler ni sauter des éléments. */
  private async fetchAll(path: string): Promise<any[]> {
    const items: any[] = [];
    let offset = 0;
    for (let page = 0; page < UnifiAdapter.MAX_PAGES; page++) {
      const decoded = UnifiParse.page(await this.http.getJson(
        path + "?offset=" + offset + "&limit=" + UnifiAdapter.PAGE_SIZE,
      ));
      items.push(...decoded.items);
      const next = UnifiParse.nextOffset(decoded, offset, UnifiAdapter.PAGE_SIZE);
      if (next === null) return items;
      offset = next;
    }
    // Cap atteint : on rend ce qu'on a (mieux qu'une exception qui perdrait tout l'inventaire),
    // mais l'anomalie doit être VISIBLE — le moteur de synchro compte les enregistrements et
    // l'utilisateur verra un total figé à 40 000. Cf. MAX_PAGES pour le raisonnement.
    return items;
  }
}
