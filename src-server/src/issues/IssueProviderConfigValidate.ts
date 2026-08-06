import type { IssueProviderConfig, IssueProviderOptions } from "./IssueProvider.js";

/* =============================================================================
   VALIDATION D'UN PROVIDER DE TICKETS — module `issues/` AMOVIBLE. Classe statique
   PURE (aucun filesystem, aucun réseau, aucun import d'adaptateur) : valide UN
   provider et applique les défauts, en poussant des messages d'erreur EXPLICITES,
   GROUPÉS (tous les griefs d'un même provider, pas seulement le premier) et en
   FRANÇAIS.

   DEUX ÉTAGES, et c'est le cœur de l'agnosticisme de marque :
   1. les champs COMMUNS à toute marque — id, kind, url https, token, account,
      interval_sec, timeout_sec — validés ici une fois pour toutes ;
   2. les options PROPRES à la marque — déclarées dans `KIND_OPTION_SPECS`, une
      entrée par `kind`. Ajouter une marque = AJOUTER UNE ENTRÉE ici (plus son
      adaptateur et son entrée de fabrique), sans toucher au reste du module. Les
      options sont normalisées en un objet scalaire (`IssueProviderOptions`)
      persisté en JSON dans la colonne `options` — d'où l'absence de DDL à modifier.
   ⚠ `KIND_OPTION_SPECS` est le SEUL endroit de ce fichier où une marque a le droit
   d'être nommée. Un test d'invariant relit les SOURCES et refuse tout autre
   littéral de marque dans ce module (comme dans les autres modules agnostiques).

   Un `kind` INCONNU est une ERREUR de validation (et non un échec différé à la
   synchro comme côté VM) : ici la validation DÉPEND du kind (les options), donc on
   ne peut pas normaliser une config dont on ignore la marque. Le message liste les
   kinds supportés — c'est plus actionnable qu'un provider enregistrable mais mort.
   Comportement REPRIS du module wifi, délibérément.

   ── POURQUOI `account` EST UN CHAMP COMMUN, ET REQUIS ─────────────────────────
   La configuration porte une IDENTIFICATION, et une identification est un COUPLE
   (qui, avec quel secret). La moitié publique est ici `account`, la moitié secrète
   `token`. L'exiger uniformément garde l'étage COMMUN totalement libre de tout test
   de marque : aucune branche `if (kind === …)` n'a à décider si le champ est
   nécessaire. Une marque future qui s'authentifierait par jeton SEUL y verrait
   simplement l'identifiant du compte de service (utile au diagnostic et à l'audit),
   ou déclarerait le cas dans SA branche — jamais dans l'étage commun.

   SÉCURITÉ (invariant) : la valeur du `token` n'apparaît JAMAIS dans un message
   d'erreur — on ne signale que sa présence/son type. Les messages citent l'`id` du
   provider (+ le docId et l'index), jamais sa valeur secrète.
   ============================================================================= */

/** Déclaration d'UNE option propre à une marque : nom, type scalaire, défaut, et contraintes
    facultatives. Volontairement pauvre : ce sont des réglages de connexion, pas un modèle de
    données — une spec plus riche serait de la sur-ingénierie pour deux champs. Forme IDENTIQUE à
    celle du module wifi (`WifiOptionSpec`), duplication ASSUMÉE et signalée : les factoriser
    coûterait l'AMOVIBILITÉ des deux modules (chacun doit pouvoir être supprimé en retirant SON
    dossier et une ligne de bootstrap), pour économiser huit lignes de déclaration. */
export interface IssueOptionSpec {
  name: string;
  type: "string" | "boolean" | "number";
  default: string | boolean | number;
  /** `string` uniquement : refuse la chaîne vide (après trim). */
  nonEmpty?: boolean;
  /** `number` uniquement : borne inférieure INCLUSIVE. */
  min?: number;
}

/** LE point d'extension « marque » de la validation (cf. en-tête).
    ⚠ Doit rester EN PHASE avec la fabrique d'adaptateurs du service de synchro (lot L3) : un kind
    validable sans adaptateur donnerait un provider enregistrable qui échoue à chaque synchro. Un
    test de cohérence confrontera les deux listes dès que la fabrique existera. */
export const KIND_OPTION_SPECS: Readonly<Record<string, readonly IssueOptionSpec[]>> = {
  jira: [
    // PROJET où sont CRÉÉS les tickets (« Ouvrir un ticket »). Défaut VIDE et NON contraint à être
    // rempli, à dessein : un provider qui ne fait que MIROITER des tickets déjà existants n'a aucun
    // projet à désigner, et refuser son enregistrement pour un champ dont il ne se sert jamais
    // serait une friction gratuite. Le manque est signalé LÀ OÙ il compte — au moment de créer —
    // par un message actionnable de l'adaptateur, pas ici.
    { name: "project_key", type: "string", default: "" },
    // TYPE de ticket créé. Défaut « Task » = le type standard d'un projet Jira ; `nonEmpty` garde
    // le cas d'un champ VIDÉ à la main dans l'UI, qui produirait une création refusée en 400 peu
    // lisible. Le libellé dépend de la LANGUE du projet (« Tâche » sur une instance francophone) :
    // c'est un réglage, pas une énumération — on ne le contraint donc pas à une liste.
    { name: "issue_type", type: "string", default: "Task", nonEmpty: true },
  ],
};

/** Kinds supportés — DÉRIVÉ de la table ci-dessus (jamais une seconde liste). */
export const SUPPORTED_KINDS: readonly string[] = Object.keys(KIND_OPTION_SPECS);

export class IssueProviderConfigValidate {
  /** Délai par requête par DÉFAUT, en secondes. Plus généreux que les 15 s des modules `vm/`/`wifi/`
      et c'est délibéré : là-bas une requête liste une ressource locale sur le LAN, ici une requête
      est une RECHERCHE côté SaaS (jusqu'à ~100 identifiants d'un coup) traversant Internet. Un délai
      trop court transformerait une passe lente en passe ÉCHOUÉE, donc en tickets faussement
      « introuvables » à la lecture d'un opérateur pressé. */
  static readonly DEFAULT_TIMEOUT_SEC = 20;

  /** Valide UN provider et applique les défauts. Renvoie l'`IssueProviderConfig` complet, ou `null`
      si au moins une erreur a été poussée pour lui. `docId`/`index` servent UNIQUEMENT à construire
      les libellés d'erreur (le CRUD passe l'index 0 : un seul provider validé à la fois). */
  static parseProvider(docId: string, index: number, raw: unknown, errors: string[]): IssueProviderConfig | null {
    if (!IssueProviderConfigValidate.isPlainObject(raw)) {
      errors.push(IssueProviderConfigValidate.providerLabel(docId, index, null) + " : chaque provider doit être un objet");
      return null;
    }
    const errorsBefore = errors.length;

    // `id` d'abord : il IDENTIFIE le provider dans tous les messages suivants (jamais le token).
    const id = IssueProviderConfigValidate.nonEmptyString(raw["id"]);
    const label = IssueProviderConfigValidate.providerLabel(docId, index, id);
    if (id === null) errors.push(IssueProviderConfigValidate.providerLabel(docId, index, null) + " : champ « id » requis (chaîne non vide)");

    // `kind` : requis ET connu (cf. en-tête — la validation des options en dépend).
    const kind = IssueProviderConfigValidate.nonEmptyString(raw["kind"]);
    if (kind === null) errors.push(label + " : champ « kind » requis (chaîne non vide)");
    else if (!(kind in KIND_OPTION_SPECS)) {
      errors.push(label + " : « kind » inconnu (« " + kind + " ») — types supportés : " + SUPPORTED_KINDS.join(", "));
    }

    // `url` : base de l'instance. https EXIGÉ — le jeton voyage en en-tête d'autorisation à CHAQUE
    // requête, le laisser passer en clair reviendrait à le donner.
    const url = IssueProviderConfigValidate.nonEmptyString(raw["url"]);
    if (url === null) errors.push(label + " : champ « url » requis (chaîne non vide, ex. « https://exemple.atlassian.net »)");
    else if (!IssueProviderConfigValidate.isValidHttpsUrl(url)) {
      errors.push(label + " : « url » invalide (« " + url + " ») — URL https attendue, ex. « https://exemple.atlassian.net »");
    }

    // `account` : moitié PUBLIQUE de l'identification (cf. en-tête). Sa valeur PEUT être citée.
    const account = IssueProviderConfigValidate.nonEmptyString(raw["account"]);
    if (account === null) {
      errors.push(label + " : champ « account » requis (chaîne non vide) — identifiant du COMPTE de service côté tracker, souvent l'adresse e-mail associée au jeton");
    }

    // `token` : requis, mais sa VALEUR reste secrète — on ne mentionne jamais son contenu.
    const token = IssueProviderConfigValidate.nonEmptyString(raw["token"]);
    if (token === null) errors.push(label + " : champ « token » requis (chaîne non vide) — valeur jamais journalisée");

    // `interval_sec` : optionnel, défaut 0 (= synchro MANUELLE uniquement). Entier >= 0.
    // ⚠ À régler HAUT en usage réel : l'assiette étant pilotée par l'utilisateur, la passe coûte
    // une requête par centaine de tickets suivis — et l'état d'un ticket n'a pas la volatilité d'un
    // client wifi. Ce n'est pas une contrainte de validation (rien n'interdit une cadence courte),
    // mais une recommandation portée par la documentation et le formulaire.
    let interval_sec = 0;
    if (raw["interval_sec"] !== undefined) {
      const iv = raw["interval_sec"];
      if (typeof iv !== "number" || !Number.isInteger(iv) || iv < 0) {
        errors.push(label + " : champ « interval_sec » : entier >= 0 attendu (0 = synchro manuelle)");
      } else {
        interval_sec = iv;
      }
    }

    // `timeout_sec` : optionnel, défaut DEFAULT_TIMEOUT_SEC. Entier >= 1.
    let timeout_sec = IssueProviderConfigValidate.DEFAULT_TIMEOUT_SEC;
    if (raw["timeout_sec"] !== undefined) {
      const to = raw["timeout_sec"];
      if (typeof to !== "number" || !Number.isInteger(to) || to < 1) {
        errors.push(label + " : champ « timeout_sec » : entier >= 1 attendu (délai d'une requête, en secondes)");
      } else {
        timeout_sec = to;
      }
    }

    // OPTIONS PROPRES À LA MARQUE — seulement si le kind est connu (sinon on ne sait pas quoi valider).
    const options = (kind !== null && kind in KIND_OPTION_SPECS)
      ? IssueProviderConfigValidate.parseOptions(kind, raw["options"], label, errors)
      : {};

    // Clés inconnues au niveau provider : TOLÉRÉES — simplement non recopiées.

    if (errors.length > errorsBefore) return null;   // au moins une erreur sur CE provider → non retenu
    // À ce stade id/kind/url/account/token sont garantis valides (sinon une erreur aurait été
    // poussée) : les casts explicitent cet invariant au vérificateur de types (strict).
    return {
      id: id as string,
      kind: kind as string,
      url: url as string,
      token: token as string,
      account: account as string,
      interval_sec,
      timeout_sec,
      options,
    };
  }

  /** Normalise les options d'UNE marque d'après sa déclaration : chaque option déclarée est posée
      (valeur fournie si valide, DÉFAUT sinon), et toute clé NON déclarée est écartée SILENCIEUSEMENT
      — pas une erreur : une option d'une autre marque (ou d'une version antérieure du même
      adaptateur) ne doit pas rendre une config irrécupérable. En revanche une option déclarée mais
      MAL TYPÉE est une erreur explicite : c'est une faute de saisie. */
  static parseOptions(kind: string, raw: unknown, label: string, errors: string[]): IssueProviderOptions {
    const specs = KIND_OPTION_SPECS[kind] || [];
    const source = IssueProviderConfigValidate.isPlainObject(raw) ? raw : {};
    const out: IssueProviderOptions = {};
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

  /* --------------------------------------------------------------------------
     Helpers (coercitions + libellés d'erreur) — certains publics car
     IssueProviderConfigDb les réutilise (isPlainObject/providerLabel).
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
    return IssueProviderConfigValidate.docLabel(docId) + ", provider #" + index + idPart;
  }

  /** Chaîne NON VIDE (après trim) → la chaîne d'origine ; sinon null. */
  private static nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }

  /** URL d'instance : https OBLIGATOIRE (cf. le commentaire du champ `url`). */
  private static isValidHttpsUrl(raw: string): boolean {
    try {
      return new URL(raw).protocol === "https:";
    } catch {
      return false;
    }
  }
}

/** Erreur de validation d'une config de provider (chemin CRUD) : porte la LISTE des messages pour
    que la route les rende en 400. Séparée d'une erreur d'IO/DB (500) : le routeur distingue
    « saisie invalide » de « panne serveur ». */
export class IssueProviderConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super("configuration de provider de tickets invalide :\n- " + issues.join("\n- "));
    this.name = "IssueProviderConfigError";
  }
}
