import type { WifiClientRecord } from "./WifiProvider.js";

/* =============================================================================
   DÉCODAGE UNIFI PUR — module `wifi/` AMOVIBLE, partie SPÉCIFIQUE À LA MARQUE
   (préfixe `Unifi*`, cf. décision D9). Transforme les réponses JSON de l'API
   d'INTÉGRATION officielle UniFi (`/proxy/network/integration/v1/…`) en pivot
   `WifiClientRecord` (cf. WifiProvider.ts). Classe à MÉTHODES STATIQUES,
   entièrement PURE : aucun accès réseau, aucun import Node — testable en
   isolation (fixtures JSON → WifiClientRecord).

   ── PRINCIPE DIRECTEUR : TOLÉRANCE ABSOLUE ────────────────────────────────────
   Ce module NE JETTE JAMAIS. Champ absent → null (ou "" pour `name`/`client_type`,
   qui ne sont pas nullables au pivot), forme inattendue → enregistrement ignoré,
   type inattendu → valeur écartée. Raison de fond : la synchro écrit dans le
   document sous validation partagée — une exception de décodage ferait échouer la
   passe ENTIÈRE (et donc perdre l'inventaire) pour un seul client mal formé.

   ── ⚠ CE QUI ÉTAIT SUPPOSÉ, ET CE QUI EST VALIDÉ ──────────────────────────────
   Écrit SANS accès à une console UniFi, les NOMS DE CHAMPS ci-dessous suivaient la
   nomenclature camelCase de l'API d'intégration (`macAddress`, `ipAddress`,
   `connectedAt`, `type`…) par HYPOTHÈSE — tout en acceptant, par ALIAS, les
   orthographes historiques (`mac`, `ip`, `hostname`, `essid`…) de l'écosystème,
   histoire d'être correct sur les DEUX conventions plutôt que sur une seule
   supposition. **Validé le 2026-08-04** sur une console réelle (UniFi Network
   10.4.57, UniFi OS Server) : tous les alias PRIMAIRES de champs clients/périphériques
   sont confirmés, ainsi que la pagination (`{ data, offset, totalCount }`). Le SSID
   n'est en revanche PAS servi par cette API (liste ET fiche détail) — ce n'est pas un
   alias à corriger, la donnée est absente du contrat officiel. Détail, limite et piste
   d'enrichissement : `docs/wifi-unifi.md`.
   ============================================================================= */

/** ALIAS de champs acceptés, du plus PROBABLE au plus historique. UN SEUL point de
    déclaration (toute correction après validation sur console réelle se fait ICI).
    ⚠ L'ordre COMPTE : le premier alias présent et exploitable gagne. */
const FIELD_ALIASES = {
  /** Identifiant technique du client côté contrôleur. */
  id: ["id", "_id", "clientId"],
  /** Nom d'affichage : l'ALIAS UTILISATEUR prime sur le hostname DHCP (c'est ce que
      l'opérateur a saisi, donc ce qu'il cherchera). */
  name: ["name", "alias", "displayName", "hostname"],
  mac: ["macAddress", "mac"],
  ip: ["ipAddress", "ip", "lastIp"],
  /** « WIRED » / « WIRELESS » côté API d'intégration ; les formes historiques sont libres. */
  type: ["type", "connectionType", "clientType"],
  ssid: ["ssid", "essid", "ssidName", "wifiNetworkName"],
  /** MAC du périphérique porteur (AP pour un client sans fil, switch pour un filaire). */
  apMac: ["apMacAddress", "apMac", "uplinkMacAddress"],
  /** Nom du périphérique porteur, quand l'API le sert directement. */
  apName: ["apName", "uplinkDeviceName", "accessPointName"],
  /** Id du périphérique porteur — clé de résolution vers la liste des `devices`. */
  uplinkId: ["uplinkDeviceId", "apId", "deviceId"],
  /** Début de la connexion courante (ISO 8601 attendu). */
  connectedAt: ["connectedAt", "associationTime", "firstSeenAt"],
} as const;

/** Alias des champs d'un PÉRIPHÉRIQUE (liste `devices`) — sert à résoudre `uplinkDeviceId`
    en nom d'AP quand le client ne le porte pas lui-même. */
const DEVICE_ALIASES = {
  id: ["id", "_id", "deviceId"],
  name: ["name", "displayName", "alias"],
  mac: ["macAddress", "mac"],
} as const;

/** Alias du NOM d'un site (liste `sites`) — POINT UNIQUE, partagé par `findSiteId` (résolution)
    et `siteSummaries` (énumération dans un message d'erreur) : les deux doivent voir le MÊME nom
    pour un même site, sans quoi le message d'erreur pourrait citer un libellé que la résolution
    elle-même ne reconnaîtrait pas. `internalReference` y reste en DERNIER repli d'AFFICHAGE
    (un site sans `name`/`displayName`/`description` montre au moins ça) — mais NE SUFFIT PAS à
    la résolution : cf. `SITE_INTERNAL_REF_ALIASES` ci-dessous pour la raison. */
const SITE_NAME_ALIASES = ["name", "displayName", "description", "internalReference"] as const;

/** Alias de la RÉFÉRENCE INTERNE d'un site (`internalReference` de l'API d'intégration —
    ex. « default »), constaté sur console réelle le 2026-08-04 : un site UniFi porte
    SOUVENT les DEUX à la fois — un nom lisible pour l'opérateur (`name: "Sonuma"`) ET une
    référence stable (`internalReference: "default"`), qui est justement la valeur par
    défaut posée par le formulaire de provider (cf. `UnifiAdapter.options`).
    ⚠ POURQUOI un alias SÉPARÉ de `SITE_NAME_ALIASES` plutôt qu'un ajout à sa liste : cette
    liste répond à « le PREMIER alias présent gagne » (`firstString`, un seul nom retenu par
    site) — si `internalReference` y était mélangé, il ne serait JAMAIS consulté dès qu'un
    `name` existe (le cas RÉEL ci-dessus), alors que le champ « Site » configuré peut
    précisément viser cette référence-là. `findSiteId` doit donc tester `internalReference`
    comme un critère de correspondance INDÉPENDANT, en plus de l'id et du nom — pas comme un
    simple repli d'affichage. */
const SITE_INTERNAL_REF_ALIASES = ["internalReference"] as const;

/** Une PAGE de réponse paginée, décodée : les éléments + ce qu'on sait du total. */
export interface UnifiPage {
  /** Éléments de la page (jamais null — tableau vide si la forme est inattendue). */
  items: any[];
  /** Décalage tel que RENVOYÉ par l'API. null = non remonté. */
  offset: number | null;
  /** Nombre TOTAL d'éléments tel que RENVOYÉ par l'API. null = non remonté. */
  totalCount: number | null;
}

export class UnifiParse {
  /* --------------------------------------------------------------------------
     1) ENVELOPPE ET PAGINATION (logique PURE — premier précédent du dépôt)
     -------------------------------------------------------------------------- */

  /** Décode l'enveloppe d'une réponse paginée. TOLÉRANT : accepte `{ data: [...] }`
      (forme de l'API d'intégration), un TABLEAU nu, ou n'importe quoi d'autre (→ page vide).
      `offset`/`totalCount` ne sont lus que s'ils sont des entiers ≥ 0 — une valeur exotique
      vaut « non remonté », jamais une exception. */
  static page(json: any): UnifiPage {
    if (Array.isArray(json)) return { items: json, offset: null, totalCount: null };
    if (!json || typeof json !== "object") return { items: [], offset: null, totalCount: null };
    const items = Array.isArray(json.data) ? json.data : [];
    return {
      items,
      offset: UnifiParse.nonNegativeInt(json.offset),
      totalCount: UnifiParse.nonNegativeInt(json.totalCount ?? json.total),
    };
  }

  /** DÉCIDE s'il faut demander une page de plus, et laquelle. Fonction PURE, extraite
      exprès de la boucle réseau : c'est LA règle qui, mal écrite, boucle à l'infini.

      Rend le PROCHAIN offset, ou `null` pour ARRÊTER. On s'arrête dès que l'UNE de ces
      conditions tient — chacune est un garde-fou indépendant, et c'est voulu : l'API peut
      mentir sur `totalCount`, ou ignorer `limit` :
      1. la page est VIDE → plus rien à lire (le cas nominal de fin) ;
      2. la page rend MOINS que la limite demandée → c'était la dernière ;
      3. le total est connu et déjà atteint (offset consommé + reçus ≥ totalCount) ;
      4. `limit` non strictement positif → configuration absurde, on ne boucle pas.
      @param page      la page décodée (cf. `page`)
      @param sentOffset l'offset qu'on VIENT de demander (référence de progression : on
                       n'utilise PAS l'offset renvoyé par l'API, qui peut manquer ou dériver)
      @param limit     la taille de page demandée */
  static nextOffset(page: UnifiPage, sentOffset: number, limit: number): number | null {
    if (!Number.isFinite(limit) || limit <= 0) return null;                         // 4
    const received = page.items.length;
    if (received === 0) return null;                                                // 1
    if (received < limit) return null;                                              // 2
    const next = sentOffset + received;
    if (page.totalCount !== null && next >= page.totalCount) return null;           // 3
    return next;
  }

  /* --------------------------------------------------------------------------
     2) SITES — résolution du site configuré (id OU nom)
     -------------------------------------------------------------------------- */

  /** Trouve, dans une liste de sites décodée, celui qui correspond au libellé configuré :
      correspondance sur l'`id`, le `name` (repli d'affichage compris) OU l'`internalReference`
      (insensible à la casse, trimée) — trois critères INDÉPENDANTS, un site réel peut porter
      les trois à la fois (ex. id UUID + `name: "Sonuma"` + `internalReference: "default"`,
      constaté sur console réelle le 2026-08-04). Rend son ID technique, ou `null` si aucun
      critère ne correspond.
      ⚠ Ne fait AUCUN repli sur « le premier site » : ce repli est une décision
      d'ORCHESTRATION (elle dépend de la config), elle vit dans l'adaptateur — ici on ne
      répond qu'à « ce libellé désigne-t-il un site de cette liste ? ». */
  static findSiteId(sites: any[], wanted: string): string | null {
    const key = String(wanted || "").trim().toLowerCase();
    if (key === "") return null;
    for (const site of sites) {
      if (!site || typeof site !== "object") continue;
      const id = UnifiParse.firstString(site, DEVICE_ALIASES.id);
      const name = UnifiParse.firstString(site, SITE_NAME_ALIASES);
      const internalRef = UnifiParse.firstString(site, SITE_INTERNAL_REF_ALIASES);
      if ((id && id.toLowerCase() === key)
        || (name && name.trim().toLowerCase() === key)
        || (internalRef && internalRef.trim().toLowerCase() === key)) return id;
    }
    return null;
  }

  /** Premier identifiant de site exploitable de la liste (repli « console mono-site »
      décidé par l'adaptateur — cf. `findSiteId`). null si la liste n'en porte aucun. */
  static firstSiteId(sites: any[]): string | null {
    for (const site of sites) {
      if (!site || typeof site !== "object") continue;
      const id = UnifiParse.firstString(site, DEVICE_ALIASES.id);
      if (id) return id;
    }
    return null;
  }

  /** Résumés (id + nom) de TOUS les sites exploitables de la console — sert à ÉNUMÉRER les
      sites disponibles dans le message d'erreur quand le site configuré n'est pas résolu
      (cf. `UnifiAdapter.siteNotFoundMessage`), pour que l'utilisateur corrige sans deviner.
      Un site SANS id exploitable est écarté : rien à lui proposer pour le champ « Site »
      (qui accepte id OU nom — sans id il ne resterait qu'un nom, potentiellement absent aussi). */
  static siteSummaries(sites: any[]): { id: string; name: string | null }[] {
    const out: { id: string; name: string | null }[] = [];
    for (const site of sites) {
      if (!site || typeof site !== "object") continue;
      const id = UnifiParse.firstString(site, DEVICE_ALIASES.id);
      if (!id) continue;
      out.push({ id, name: UnifiParse.firstString(site, SITE_NAME_ALIASES) });
    }
    return out;
  }

  /* --------------------------------------------------------------------------
     3) PÉRIPHÉRIQUES — index id → { nom, mac } pour résoudre l'AP d'un client
     -------------------------------------------------------------------------- */

  /** Index des périphériques par ID technique. Les entrées sans id sont ignorées (elles ne
      pourraient être rapprochées d'aucun client). Sert à donner un NOM lisible à l'AP quand
      le client ne remonte que l'id de son uplink. */
  static deviceIndex(devices: any[]): Map<string, { name: string | null; mac: string | null }> {
    const index = new Map<string, { name: string | null; mac: string | null }>();
    for (const device of devices) {
      if (!device || typeof device !== "object") continue;
      const id = UnifiParse.firstString(device, DEVICE_ALIASES.id);
      if (!id) continue;
      index.set(id, {
        name: UnifiParse.firstString(device, DEVICE_ALIASES.name),
        mac: UnifiParse.firstString(device, DEVICE_ALIASES.mac),
      });
    }
    return index;
  }

  /* --------------------------------------------------------------------------
     4) CLIENTS — item brut → pivot `WifiClientRecord`
     -------------------------------------------------------------------------- */

  /** Décode UN client. Rend `null` quand l'item est inexploitable — c'est-à-dire quand il
      n'offre AUCUNE identité stable (ni MAC ni id) : le réconcilier serait impossible et
      créerait un enregistrement fantôme à chaque passe.

      IDENTITÉ (`ext_id`) : la MAC d'abord, l'id technique en repli. POURQUOI cet ordre —
      la MAC est l'identité PHYSIQUE du client, stable à travers les déconnexions, alors
      qu'un id de session peut être régénéré à chaque association ; un ext_id instable
      recréerait le client à chaque retour et laisserait un « déconnecté » derrière lui.
      ⚠ Point à VALIDER sur console réelle (cf. en-tête).

      `provider_id` est laissé VIDE : le décodeur pur ignore l'instance d'adaptateur, c'est
      l'adaptateur qui estampille (même partage des rôles que `ProxmoxParse`).

      @param apIndex index optionnel des périphériques (cf. `deviceIndex`) — quand le client
             ne porte pas le NOM de son AP, on le résout par son `uplinkDeviceId`. */
  static clientRecord(raw: any, apIndex?: Map<string, { name: string | null; mac: string | null }>): WifiClientRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const mac = UnifiParse.firstString(raw, FIELD_ALIASES.mac);
    const id = UnifiParse.firstString(raw, FIELD_ALIASES.id);
    const extId = mac || id;
    if (!extId) return null;   // aucune identité stable → inréconciliable

    // AP : nom/MAC directs s'ils existent, sinon résolution par l'id d'uplink (au mieux).
    let apName = UnifiParse.firstString(raw, FIELD_ALIASES.apName);
    let apMac = UnifiParse.firstString(raw, FIELD_ALIASES.apMac);
    const uplinkId = UnifiParse.firstString(raw, FIELD_ALIASES.uplinkId);
    if (apIndex && uplinkId) {
      const device = apIndex.get(uplinkId);
      if (device) {
        if (!apName) apName = device.name;
        if (!apMac) apMac = device.mac;
      }
    }

    return {
      ext_id: extId,
      provider_id: "",                                                  // estampillé par l'adaptateur
      name: UnifiParse.firstString(raw, FIELD_ALIASES.name) || "",      // "" fréquent : l'UI replie sur la MAC
      mac,
      ip: UnifiParse.firstString(raw, FIELD_ALIASES.ip),
      client_type: UnifiParse.clientType(raw),
      ssid: UnifiParse.firstString(raw, FIELD_ALIASES.ssid),
      ap_mac: apMac,
      ap_name: apName,
      connected_since: UnifiParse.isoDate(UnifiParse.firstValue(raw, FIELD_ALIASES.connectedAt)),
    };
  }

  /** Décode une PAGE de clients en records, en écartant les inexploitables et les DOUBLONS
      d'`ext_id` (une console peut lister deux fois le même client — le premier gagne, comme
      dans la réconciliation). L'appelant concatène les pages et estampille `provider_id`. */
  static clientRecords(items: any[], apIndex?: Map<string, { name: string | null; mac: string | null }>): WifiClientRecord[] {
    const out: WifiClientRecord[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const record = UnifiParse.clientRecord(item, apIndex);
      if (!record || seen.has(record.ext_id)) continue;
      seen.add(record.ext_id);
      out.push(record);
    }
    return out;
  }

  /** Le client est-il SANS FIL ? Sert au filtre `include_wired` (opt-in, décision D3).
      PRUDENCE VOLONTAIRE : seul un type reconnu comme FILAIRE (« wired ») exclut le client —
      un type inconnu ou absent est traité comme sans-fil, donc CONSERVÉ. Inverser la
      prudence ferait DISPARAÎTRE des clients réels au premier vocabulaire inattendu, ce qui
      est bien pire qu'un filaire de trop dans un listing où le type est une colonne filtrable. */
  static isWireless(record: WifiClientRecord): boolean {
    return !/wired|wire$|ethernet|lan/i.test(record.client_type || "");
  }

  /* --------------------------------------------------------------------------
     Helpers internes (privés) — décodage tolérant de valeurs
     -------------------------------------------------------------------------- */

  /** Type de raccordement en MINUSCULES (« WIRELESS » → « wireless ») : le pivot conserve la
      valeur telle quelle mais normaliser la CASSE évite un faux delta de synchro le jour où
      une release change « WIRED » en « Wired ». Valeur inconnue → conservée (minuscule). */
  private static clientType(raw: any): string {
    const value = UnifiParse.firstString(raw, FIELD_ALIASES.type);
    return value ? value.trim().toLowerCase() : "";
  }

  /** Première valeur BRUTE non vide parmi une liste d'alias de clés. */
  private static firstValue(raw: any, keys: readonly string[]): any {
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  }

  /** Première valeur CHAÎNE non vide parmi une liste d'alias (les nombres sont acceptés et
      convertis : certaines API rendent un id numérique). null si aucune. */
  private static firstString(raw: any, keys: readonly string[]): string | null {
    const value = UnifiParse.firstValue(raw, keys);
    if (typeof value === "string") return value.trim() === "" ? null : value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  }

  /** Horodatage → ISO 8601, quelle que soit la forme reçue : chaîne ISO (revalidée),
      secondes UNIX ou millisecondes UNIX (départagées par l'ordre de grandeur — au-delà de
      10^11, c'est nécessairement des millisecondes). Illisible → null (jamais une date
      inventée : une fausse date d'association trompe l'opérateur plus qu'un tiret). */
  private static isoDate(value: any): string | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      const ms = value > 1e11 ? value : value * 1000;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof value === "string" && value.trim() !== "") {
      const date = new Date(value.trim());
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    return null;
  }

  /** Entier ≥ 0, sinon null (accepte une chaîne numérique). */
  private static nonNegativeInt(value: any): number | null {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  }
}
