import type { ProviderConfig, ProviderEndpoint } from "./VmProvider.js";

/* =============================================================================
   VALIDATION D'UN PROVIDER VM — module `vm/` AMOVIBLE. Classe statique PURE
   (aucun filesystem, aucun réseau) : valide UN provider (id/kind/token requis,
   POOL d'urls https + empreintes par nœud, include_lxc/interval_sec/timeout_sec
   avec défauts) et applique les défauts, en poussant des messages d'erreur
   EXPLICITES.

   POURQUOI ce fichier séparé (cadrage UI providers 2026-07-14) : la MÊME règle
   de validation par provider doit servir DEUX chemins de stockage — le parseur
   du fichier legacy `vm-providers.json` (ProviderConfigStore) ET le CRUD de la
   base `vm-providers.db` (ProviderConfigDb). L'extraire ici garantit des messages
   d'erreur IDENTIQUES des deux côtés (exigence de cadrage) et zéro duplication :
   ProviderConfigStore et ProviderConfigDb délèguent tous deux à cette classe.

   SÉCURITÉ (invariant) : la valeur du `token` n'apparaît JAMAIS dans un message
   d'erreur — on ne signale que sa présence/son type. Les messages citent l'`id`
   du provider (+ le docId et l'index), jamais sa valeur secrète.
   ============================================================================= */
export class ProviderConfigValidate {
  /** Valide UN provider et applique les défauts. Renvoie le `ProviderConfig` complet, ou
      `null` si au moins une erreur a été poussée pour lui (le provider n'est alors pas retenu).
      IMPORTANT : la valeur du `token` n'est jamais recopiée dans un message — on ne signale
      que sa présence/son type. `docId`/`index` servent UNIQUEMENT à construire les libellés
      d'erreur (le CRUD passe l'index 0 : un seul provider validé à la fois). */
  static parseProvider(docId: string, index: number, raw: unknown, errors: string[]): ProviderConfig | null {
    if (!ProviderConfigValidate.isPlainObject(raw)) {
      errors.push(ProviderConfigValidate.providerLabel(docId, index, null) + " : chaque provider doit être un objet");
      return null;
    }
    const errorsBefore = errors.length;

    // `id` d'abord : il IDENTIFIE le provider dans tous les messages suivants (jamais le token).
    const id = ProviderConfigValidate.nonEmptyString(raw["id"]);
    const label = ProviderConfigValidate.providerLabel(docId, index, id);
    if (id === null) errors.push(ProviderConfigValidate.providerLabel(docId, index, null) + " : champ « id » requis (chaîne non vide)");

    const kind = ProviderConfigValidate.nonEmptyString(raw["kind"]);
    if (kind === null) errors.push(label + " : champ « kind » requis (chaîne non vide)");

    // POOL D'ENDPOINTS : `urls` (tableau) OU raccourci mono-nœud `url` (+ `fingerprint`).
    const endpoints = ProviderConfigValidate.parseEndpoints(raw, label, errors);

    // `token` : requis, mais sa VALEUR reste secrète — on ne mentionne jamais son contenu.
    const token = ProviderConfigValidate.nonEmptyString(raw["token"]);
    if (token === null) errors.push(label + " : champ « token » requis (chaîne non vide) — valeur jamais journalisée");

    // `include_lxc` : optionnel, défaut TRUE (décision de cadrage : les conteneurs LXC sont inventoriés par défaut).
    let include_lxc = true;
    if (raw["include_lxc"] !== undefined) {
      if (typeof raw["include_lxc"] !== "boolean") errors.push(label + " : champ « include_lxc » : booléen attendu");
      else include_lxc = raw["include_lxc"];
    }

    // `interval_sec` : optionnel, défaut 0 (= synchro MANUELLE uniquement). Entier >= 0.
    let interval_sec = 0;
    if (raw["interval_sec"] !== undefined) {
      const iv = raw["interval_sec"];
      if (typeof iv !== "number" || !Number.isInteger(iv) || iv < 0) {
        errors.push(label + " : champ « interval_sec » : entier >= 0 attendu (0 = synchro manuelle)");
      } else {
        interval_sec = iv;
      }
    }

    // `timeout_sec` : optionnel, défaut 15 s (parité avec l'ancien délai codé en dur de PveHttp).
    // Entier >= 1 : c'est le délai d'UNE requête ET le coût maximal d'une bascule de nœud mort.
    let timeout_sec = 15;
    if (raw["timeout_sec"] !== undefined) {
      const to = raw["timeout_sec"];
      if (typeof to !== "number" || !Number.isInteger(to) || to < 1) {
        errors.push(label + " : champ « timeout_sec » : entier >= 1 attendu (délai d'une requête, en secondes)");
      } else {
        timeout_sec = to;
      }
    }

    // `ca_pem` : optionnel, défaut null. CA du cluster (PEM `pve-root-ca.pem`) — niveau 2 de la
    // hiérarchie de confiance (cf. VmProvider.ca_pem / PveHttp.trustOptions). PUBLIC (pas un secret) :
    // on N'INTERDIT PAS de le citer et il PEUT figurer dans les réponses de lecture. Combinaison avec
    // une empreinte PAR ENDPOINT AUTORISÉE : le pin prime par nœud, la CA sert de repli pour les nœuds
    // non épinglés. Validation minimale : présent → chaîne contenant le marqueur PEM de certificat.
    let ca_pem: string | null = null;
    if (raw["ca_pem"] !== undefined && raw["ca_pem"] !== null) {
      const pem = raw["ca_pem"];
      if (typeof pem !== "string" || !pem.includes("-----BEGIN CERTIFICATE-----")) {
        errors.push(label + " : champ « ca_pem » : certificat CA au format PEM attendu (bloc « -----BEGIN CERTIFICATE----- », ex. contenu de /etc/pve/pve-root-ca.pem)");
      } else {
        ca_pem = pem;
      }
    }

    // `management_url` : optionnel, défaut null. URL de l'outil de MANAGEMENT du CLUSTER (Proxmox :
    // l'URL du Proxmox Datacenter Manager) — FOURNIE en config car NON déductible de l'API (le PDM
    // est un service distinct des nœuds). PUBLIC (pas un secret) : on n'interdit pas de le citer.
    // Vide/absent → null ; présent → URL http(s) valide (le PDM peut être en HTTP interne, d'où
    // http OU https accepté, contrairement aux endpoints d'API — cf. isValidHttpUrl).
    let management_url: string | null = null;
    if (raw["management_url"] !== undefined && raw["management_url"] !== null) {
      const url = raw["management_url"];
      if (typeof url === "string" && url.trim() === "") {
        // Champ VIDÉ (édition UI qui retire l'URL) = pas d'URL de management → défaut null, sans erreur.
      } else if (typeof url !== "string" || !ProviderConfigValidate.isValidHttpUrl(url)) {
        errors.push(label + " : champ « management_url » : URL http(s) attendue (ex. « https://pdm.exemple.com:8443 ») — l'URL du Proxmox Datacenter Manager, non déductible de l'API");
      } else {
        management_url = url;
      }
    }

    // Clés inconnues au niveau provider : TOLÉRÉES (fichier édité à la main) — simplement non recopiées.

    if (errors.length > errorsBefore) return null; // au moins une erreur sur CE provider → non retenu
    // À ce stade id/kind/endpoints/token sont garantis valides (sinon une erreur aurait été
    // poussée) : les casts explicitent cet invariant au vérificateur de types (strict).
    return {
      id: id as string,
      kind: kind as string,
      endpoints: endpoints as ProviderEndpoint[],
      token: token as string,
      include_lxc,
      interval_sec,
      timeout_sec,
      ca_pem,
      management_url,
    };
  }

  /** Décode le POOL d'endpoints d'un provider : `urls` (tableau d'objets `{ url, fingerprint? }`
      ou de chaînes) OU raccourci mono-nœud `url` (+ `fingerprint` global). Renvoie null si une
      erreur a été poussée. Règles d'ambiguïté : `url` ET `urls` ensemble = erreur ; `fingerprint`
      au niveau provider AVEC `urls` = erreur (chaque nœud a SON certificat → son empreinte). */
  private static parseEndpoints(raw: Record<string, unknown>, label: string, errors: string[]): ProviderEndpoint[] | null {
    const hasUrl = raw["url"] !== undefined;
    const hasUrls = raw["urls"] !== undefined;
    if (hasUrl && hasUrls) {
      errors.push(label + " : « url » et « urls » sont exclusifs — utilisez « urls » seul pour un pool");
      return null;
    }

    // Raccourci MONO-NŒUD : url + fingerprint au niveau provider (compat et cas simple).
    if (!hasUrls) {
      const url = ProviderConfigValidate.nonEmptyString(raw["url"]);
      if (url === null) {
        errors.push(label + " : champ « url » (chaîne) ou « urls » (tableau d'endpoints) requis");
        return null;
      }
      if (!ProviderConfigValidate.isValidHttpsUrl(url)) {
        errors.push(label + " : « url » invalide (« " + url + " ») — URL https attendue, ex. « https://pve1.example.lan:8006 »");
        return null;
      }
      const fingerprint = ProviderConfigValidate.parseFingerprint(raw["fingerprint"], label, errors);
      return fingerprint === undefined ? null : [{ url, fingerprint }];
    }

    // POOL : fingerprint GLOBAL interdit (une empreinte identifie UN certificat, donc UN nœud).
    if (raw["fingerprint"] !== undefined) {
      errors.push(label + " : « fingerprint » au niveau provider est interdit avec « urls » — portez l'empreinte dans chaque entrée du pool");
      return null;
    }
    const rawUrls = raw["urls"];
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
      errors.push(label + " : champ « urls » : tableau NON VIDE d'endpoints attendu");
      return null;
    }
    const endpoints: ProviderEndpoint[] = [];
    const errorsBefore = errors.length;
    rawUrls.forEach((entry, position) => {
      const entryLabel = label + ", urls[" + position + "]";
      if (typeof entry === "string") {
        // Raccourci : chaîne = endpoint sans épinglage (validation CA système).
        if (entry.trim() === "") errors.push(entryLabel + " : url vide");
        else if (!ProviderConfigValidate.isValidHttpsUrl(entry)) errors.push(entryLabel + " : url invalide (« " + entry + " ») — URL https attendue");
        else endpoints.push({ url: entry, fingerprint: null });
        return;
      }
      if (!ProviderConfigValidate.isPlainObject(entry)) {
        errors.push(entryLabel + " : chaîne ou objet { url, fingerprint? } attendu");
        return;
      }
      const url = ProviderConfigValidate.nonEmptyString(entry["url"]);
      if (url === null) { errors.push(entryLabel + " : champ « url » requis (chaîne non vide)"); return; }
      if (!ProviderConfigValidate.isValidHttpsUrl(url)) { errors.push(entryLabel + " : url invalide (« " + url + " ») — URL https attendue"); return; }
      const fingerprint = ProviderConfigValidate.parseFingerprint(entry["fingerprint"], entryLabel, errors);
      if (fingerprint === undefined) return;
      endpoints.push({ url, fingerprint });
    });
    // Doublon d'URL dans le pool : erreur (retenter le même nœud mort n'apporte rien — c'est
    // presque toujours une faute de frappe d'édition manuelle).
    const seen = new Set<string>();
    for (const endpoint of endpoints) {
      if (seen.has(endpoint.url)) errors.push(label + " : url en double dans le pool (« " + endpoint.url + " »)");
      seen.add(endpoint.url);
    }
    return errors.length > errorsBefore ? null : endpoints;
  }

  /** Valide une empreinte optionnelle : absente/null → null (pas d'épinglage) ; valide → telle
      quelle ; invalide → pousse l'erreur et renvoie `undefined` (sentinelle « erreur poussée »,
      distincte de null qui est une valeur légitime). */
  private static parseFingerprint(raw: unknown, label: string, errors: string[]): string | null | undefined {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || !ProviderConfigValidate.isSha256Fingerprint(raw)) {
      errors.push(label + " : champ « fingerprint » : empreinte SHA-256 attendue (32 octets hexadécimaux, ex. « AA:BB:CC:… »)");
      return undefined;
    }
    return raw; // conservée TELLE QUELLE (PveHttp normalise au moment de comparer)
  }

  /* --------------------------------------------------------------------------
     Helpers (coercitions + libellés d'erreur) — publics quand ProviderConfigStore
     les partage au niveau DOCUMENT (racine, unicité des id) pour rester sans duplication.
     -------------------------------------------------------------------------- */

  /** Objet JSON « simple » (ni null, ni tableau) — les entrées `Record<string, unknown>`. */
  static isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** Libellé d'un document pour les messages d'erreur. */
  static docLabel(docId: string): string {
    return "document « " + docId + " »";
  }

  /** Libellé d'un provider (docId + index + id si connu) — JAMAIS le token. */
  static providerLabel(docId: string, index: number, id: string | null): string {
    const idPart = id !== null ? " (« " + id + " »)" : "";
    return ProviderConfigValidate.docLabel(docId) + ", provider #" + index + idPart;
  }

  /** Chaîne NON VIDE (après trim) → la chaîne d'origine ; sinon null (champ absent/vide/mal typé). */
  private static nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }

  /** Empreinte SHA-256 valide : 32 octets = 64 caractères hexa une fois les séparateurs retirés
      (même normalisation que PveHttp.normFp, pour rester cohérent à la comparaison TLS). */
  private static isSha256Fingerprint(fp: string): boolean {
    return fp.replace(/[^0-9a-fA-F]/g, "").length === 64;
  }

  /** URL exploitable dont le protocole figure dans `protocols`. Valider ICI (au chargement, avec
      l'URL citée) plutôt que de laisser une URL bancale produire une erreur cryptique plus tard.
      Généralisé (2026-07-14) : les endpoints d'API EXIGENT https (pveproxy n'écoute qu'en TLS),
      mais `management_url` (l'UI du PDM) peut être exposée en http interne → on paramètre les
      protocoles acceptés au lieu de dupliquer la logique de parsing. */
  private static isValidUrl(raw: string, protocols: string[]): boolean {
    try {
      return protocols.includes(new URL(raw).protocol);
    } catch {
      return false;
    }
  }

  /** URL d'endpoint d'API : https OBLIGATOIRE (pveproxy n'écoute qu'en TLS). */
  private static isValidHttpsUrl(raw: string): boolean {
    return ProviderConfigValidate.isValidUrl(raw, ["https:"]);
  }

  /** URL d'outil de management (UI) : http OU https — le Proxmox Datacenter Manager est souvent
      exposé en http sur un réseau d'administration interne. */
  private static isValidHttpUrl(raw: string): boolean {
    return ProviderConfigValidate.isValidUrl(raw, ["http:", "https:"]);
  }
}

/** Erreur de validation d'une config de provider (chemin CRUD) : porte la LISTE des messages
    (mêmes libellés que le parseur fichier) pour que la route les rende en 400. Séparée d'une
    erreur d'IO/DB (500) : le routeur distingue « saisie invalide » de « panne serveur ». */
export class ProviderConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super("configuration de provider invalide :\n- " + issues.join("\n- "));
    this.name = "ProviderConfigError";
  }
}
