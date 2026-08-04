import type { WifiProviderConfig, WifiProviderOptions } from "./WifiProvider.js";

/* =============================================================================
   VALIDATION D'UN PROVIDER WIFI — module `wifi/` AMOVIBLE. Classe statique PURE
   (aucun filesystem, aucun réseau, aucun import d'adaptateur) : valide UN provider
   et applique les défauts, en poussant des messages d'erreur EXPLICITES.

   DEUX ÉTAGES, et c'est le cœur de l'agnosticisme de marque (décision D9) :
   1. les champs COMMUNS à toute marque — id, kind, url https, token, empreinte TLS,
      ca_pem, interval_sec, timeout_sec — validés ici une fois pour toutes ;
   2. les options PROPRES à la marque — déclarées dans `KIND_OPTION_SPECS`, une
      entrée par `kind`. Ajouter une marque = AJOUTER UNE ENTRÉE ici (plus son
      adaptateur et son entrée de fabrique), sans toucher au reste du module.
      Les options sont normalisées en un objet scalaire (`WifiProviderOptions`)
      persisté en JSON dans la colonne `options` — d'où l'absence de DDL à modifier.

   Un `kind` INCONNU est une ERREUR de validation (et non un échec différé à la
   synchro comme côté VM) : ici la validation DÉPEND du kind (les options), donc on
   ne peut pas normaliser une config dont on ignore la marque. Le message liste les
   kinds supportés — c'est plus actionnable qu'un provider enregistrable mais mort.

   SÉCURITÉ (invariant) : la valeur du `token` n'apparaît JAMAIS dans un message
   d'erreur — on ne signale que sa présence/son type. Les messages citent l'`id` du
   provider (+ le docId et l'index), jamais sa valeur secrète.
   ============================================================================= */

/** Déclaration d'UNE option propre à une marque : nom, type scalaire, défaut, et
    contrainte facultative « non vide » (pour une option textuelle qui identifie
    quelque chose côté contrôleur). Volontairement pauvre : ce sont des réglages de
    connexion, pas un modèle de données — une spec plus riche serait de la
    sur-ingénierie pour deux champs. */
export interface WifiOptionSpec {
  name: string;
  type: "string" | "boolean" | "number";
  default: string | boolean | number;
  /** `string` uniquement : refuse la chaîne vide (après trim). */
  nonEmpty?: boolean;
  /** `number` uniquement : borne inférieure INCLUSIVE. */
  min?: number;
}

/** LE point d'extension « marque » de la validation (cf. en-tête, D9).
    ⚠ Doit rester EN PHASE avec la fabrique `WifiSyncService.adapterFor` : un kind
    validable sans adaptateur donnerait un provider enregistrable qui échoue à chaque
    synchro. Un test de cohérence confronte les deux listes. */
export const KIND_OPTION_SPECS: Readonly<Record<string, readonly WifiOptionSpec[]>> = {
  unifi: [
    // SITE UniFi : une console héberge N sites, un provider en couvre UN (décision D3 —
    // multi-sites = plusieurs providers). Accepte l'identifiant OU le nom du site ;
    // « default » est le nom historique du site par défaut d'une console UniFi.
    { name: "site", type: "string", default: "default", nonEmpty: true },
    // Le besoin exprimé porte sur les clients WIFI ; l'API expose AUSSI le filaire.
    // Opt-in explicite plutôt que filtrage silencieux (le champ `client_type` du pivot
    // reste renseigné dans les deux cas, l'utilisateur peut donc filtrer côté listing).
    { name: "include_wired", type: "boolean", default: false },
  ],
};

/** Kinds supportés — DÉRIVÉ de la table ci-dessus (jamais une seconde liste). */
export const SUPPORTED_KINDS: readonly string[] = Object.keys(KIND_OPTION_SPECS);

export class WifiProviderConfigValidate {
  /** Valide UN provider et applique les défauts. Renvoie le `WifiProviderConfig` complet,
      ou `null` si au moins une erreur a été poussée pour lui. `docId`/`index` servent
      UNIQUEMENT à construire les libellés d'erreur (le CRUD passe l'index 0 : un seul
      provider validé à la fois). */
  static parseProvider(docId: string, index: number, raw: unknown, errors: string[]): WifiProviderConfig | null {
    if (!WifiProviderConfigValidate.isPlainObject(raw)) {
      errors.push(WifiProviderConfigValidate.providerLabel(docId, index, null) + " : chaque provider doit être un objet");
      return null;
    }
    const errorsBefore = errors.length;

    // `id` d'abord : il IDENTIFIE le provider dans tous les messages suivants (jamais le token).
    const id = WifiProviderConfigValidate.nonEmptyString(raw["id"]);
    const label = WifiProviderConfigValidate.providerLabel(docId, index, id);
    if (id === null) errors.push(WifiProviderConfigValidate.providerLabel(docId, index, null) + " : champ « id » requis (chaîne non vide)");

    // `kind` : requis ET connu (cf. en-tête — la validation des options en dépend).
    const kind = WifiProviderConfigValidate.nonEmptyString(raw["kind"]);
    if (kind === null) errors.push(label + " : champ « kind » requis (chaîne non vide)");
    else if (!(kind in KIND_OPTION_SPECS)) {
      errors.push(label + " : « kind » inconnu (« " + kind + " ») — types supportés : " + SUPPORTED_KINDS.join(", "));
    }

    // `url` : UNE console (pas de pool — décision D3). https EXIGÉ : l'API d'intégration
    // porte une clé statique en en-tête, la laisser voyager en clair serait la donner.
    const url = WifiProviderConfigValidate.nonEmptyString(raw["url"]);
    if (url === null) errors.push(label + " : champ « url » requis (chaîne non vide, ex. « https://unifi.exemple.lan »)");
    else if (!WifiProviderConfigValidate.isValidHttpsUrl(url)) {
      errors.push(label + " : « url » invalide (« " + url + " ») — URL https attendue, ex. « https://unifi.exemple.lan »");
    }

    // `token` : requis, mais sa VALEUR reste secrète — on ne mentionne jamais son contenu.
    const token = WifiProviderConfigValidate.nonEmptyString(raw["token"]);
    if (token === null) errors.push(label + " : champ « token » requis (chaîne non vide) — valeur jamais journalisée");

    // `fingerprint` : optionnel, défaut null (pas d'épinglage → CA fournie, puis CA système).
    const fingerprint = WifiProviderConfigValidate.parseFingerprint(raw["fingerprint"], label, errors);

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

    // `timeout_sec` : optionnel, défaut 15 s (parité avec le module VM). Entier >= 1.
    let timeout_sec = 15;
    if (raw["timeout_sec"] !== undefined) {
      const to = raw["timeout_sec"];
      if (typeof to !== "number" || !Number.isInteger(to) || to < 1) {
        errors.push(label + " : champ « timeout_sec » : entier >= 1 attendu (délai d'une requête, en secondes)");
      } else {
        timeout_sec = to;
      }
    }

    // `ca_pem` : optionnel, défaut null. PUBLIC (pas un secret) : on n'interdit pas de le citer,
    // et il PEUT figurer dans les réponses de lecture. Cumulable avec l'empreinte (le pin prime).
    let ca_pem: string | null = null;
    if (raw["ca_pem"] !== undefined && raw["ca_pem"] !== null) {
      const pem = raw["ca_pem"];
      if (typeof pem === "string" && pem.trim() === "") {
        // Champ VIDÉ côté UI = pas de CA → défaut null, sans erreur.
      } else if (typeof pem !== "string" || !pem.includes("-----BEGIN CERTIFICATE-----")) {
        errors.push(label + " : champ « ca_pem » : certificat CA au format PEM attendu (bloc « -----BEGIN CERTIFICATE----- »)");
      } else {
        ca_pem = pem;
      }
    }

    // OPTIONS PROPRES À LA MARQUE — seulement si le kind est connu (sinon on ne sait pas quoi valider).
    const options = (kind !== null && kind in KIND_OPTION_SPECS)
      ? WifiProviderConfigValidate.parseOptions(kind, raw["options"], label, errors)
      : {};

    // Clés inconnues au niveau provider : TOLÉRÉES — simplement non recopiées.

    if (errors.length > errorsBefore) return null;   // au moins une erreur sur CE provider → non retenu
    // À ce stade id/kind/url/token sont garantis valides (sinon une erreur aurait été poussée) :
    // les casts explicitent cet invariant au vérificateur de types (strict).
    return {
      id: id as string,
      kind: kind as string,
      url: url as string,
      token: token as string,
      fingerprint: fingerprint as string | null,
      ca_pem,
      interval_sec,
      timeout_sec,
      options,
    };
  }

  /** Normalise les options d'UNE marque d'après sa déclaration : chaque option déclarée est
      posée (valeur fournie si valide, DÉFAUT sinon), et toute clé NON déclarée est écartée
      SILENCIEUSEMENT — pas une erreur : une option d'une autre marque (ou d'une version
      antérieure du même adaptateur) ne doit pas rendre une config irrécupérable. En revanche
      une option déclarée mais MAL TYPÉE est une erreur explicite : c'est une faute de saisie. */
  static parseOptions(kind: string, raw: unknown, label: string, errors: string[]): WifiProviderOptions {
    const specs = KIND_OPTION_SPECS[kind] || [];
    const source = WifiProviderConfigValidate.isPlainObject(raw) ? raw : {};
    const out: WifiProviderOptions = {};
    for (const spec of specs) {
      const value = source[spec.name];
      if (value === undefined || value === null) { out[spec.name] = spec.default; continue; }
      if (spec.type === "boolean") {
        if (typeof value !== "boolean") { errors.push(label + " : option « " + spec.name + " » : booléen attendu"); continue; }
        out[spec.name] = value;
      } else if (spec.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value) || (spec.min !== undefined && value < spec.min)) {
          errors.push(label + " : option « " + spec.name + " » : nombre" + (spec.min !== undefined ? " >= " + spec.min : "") + " attendu");
          continue;
        }
        out[spec.name] = value;
      } else {
        if (typeof value !== "string") { errors.push(label + " : option « " + spec.name + " » : chaîne attendue"); continue; }
        if (spec.nonEmpty && value.trim() === "") { errors.push(label + " : option « " + spec.name + " » : chaîne NON VIDE attendue"); continue; }
        out[spec.name] = value;
      }
    }
    return out;
  }

  /** Valide une empreinte optionnelle : absente/null/vide → null (pas d'épinglage) ; valide →
      telle quelle ; invalide → pousse l'erreur et renvoie null (l'erreur suffit à écarter la config). */
  private static parseFingerprint(raw: unknown, label: string, errors: string[]): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string" && raw.trim() === "") return null;   // champ vidé côté UI
    if (typeof raw !== "string" || !WifiProviderConfigValidate.isSha256Fingerprint(raw)) {
      errors.push(label + " : champ « fingerprint » : empreinte SHA-256 attendue (32 octets hexadécimaux, ex. « AA:BB:CC:… »)");
      return null;
    }
    return raw;   // conservée TELLE QUELLE (UnifiHttp normalise au moment de comparer)
  }

  /* --------------------------------------------------------------------------
     Helpers (coercitions + libellés d'erreur) — certains publics car
     WifiProviderConfigDb les réutilise (isPlainObject/providerLabel).
     -------------------------------------------------------------------------- */

  /** Objet JSON « simple » (ni null, ni tableau). */
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
    return WifiProviderConfigValidate.docLabel(docId) + ", provider #" + index + idPart;
  }

  /** Chaîne NON VIDE (après trim) → la chaîne d'origine ; sinon null. */
  private static nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }

  /** Empreinte SHA-256 valide : 32 octets = 64 caractères hexa une fois les séparateurs
      retirés (même normalisation que `UnifiHttp.normFp`, pour rester cohérent à la comparaison TLS). */
  private static isSha256Fingerprint(fp: string): boolean {
    return fp.replace(/[^0-9a-fA-F]/g, "").length === 64;
  }

  /** URL de console : https OBLIGATOIRE (le jeton voyage en en-tête à chaque requête). */
  private static isValidHttpsUrl(raw: string): boolean {
    try {
      return new URL(raw).protocol === "https:";
    } catch {
      return false;
    }
  }
}

/** Erreur de validation d'une config de provider (chemin CRUD) : porte la LISTE des messages
    pour que la route les rende en 400. Séparée d'une erreur d'IO/DB (500) : le routeur
    distingue « saisie invalide » de « panne serveur ». */
export class WifiProviderConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super("configuration de provider wifi invalide :\n- " + issues.join("\n- "));
    this.name = "WifiProviderConfigError";
  }
}
