import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";
import { IssueSync } from "../../src-shared/IssueSync";

/** TICKET d'un tracker distant (Atlassian Jira Cloud en première implémentation — la marque n'est
    qu'un ADAPTATEUR côté serveur) — collection AMOVIBLE (le cœur n'en dépend jamais). Miroir LOCAL
    d'un ticket SUIVI : ni placé en 2D/3D, ni câblé, ni compté dans le power ou les spares.

    ⚠ L'ASSIETTE EST INVERSÉE par rapport aux VMs et aux clients wifi (cadrage §3) : là-bas la
    SOURCE énumère et le document suit ; ici c'est le DOCUMENT qui énumère les tickets suivis, et la
    source n'est interrogée que sur ces clés-là. Un enregistrement n'apparaît donc JAMAIS tout seul —
    seuls les actes « Suivre un ticket » et « Ouvrir un ticket » en créent — et la synchro ne fait que
    RAFRAÎCHIR les champs source de ce qui a été choisi.

    En MODE FICHIER la collection reste entièrement lisible, filtrable et cherchable (records déjà
    synchronisés puis exportés), les champs LOCAUX et les LIENS restent éditables, et `url` reste
    cliquable — c'est ce que le lien persisté au pivot (décision D6) achète. Seules la synchro et la
    création sont serveur : écart au principe n°15 à DOCUMENTER dans le `docs/*.md` de la feature,
    comme pour les VMs et le wifi.

    Frontière SOURCE / LOCAUX (décision de cadrage D1) :
    - champs SOURCE : ÉCRASÉS à chaque passe (réconciliation par `ext_id`) ;
    - champs LOCAUX : enrichissements JAMAIS touchés par la synchro (`notes`, `description`,
      et le rattachement MANUEL `targets`). */
export class Issue extends Entity implements Records.Issue {
  /* ---- champs SOURCE (écrasés par la synchro) ---- */
  /** Identité STABLE côté tracker — clé de RÉCONCILIATION. 🚨 C'est l'identifiant INTERNE du ticket
      (« 10042 » chez Jira), JAMAIS la clé lisible : celle-ci change quand le ticket est déplacé de
      projet (décision D2, risque n°1 du cadrage — le défaut serait silencieux jusqu'au premier
      déplacement, puis produirait un doublon ET un orphelin). */
  ext_id: string;
  /** Instance d'adaptateur/tracker d'origine (multi-trackers par document). */
  provider_id: string;
  /** Clé LISIBLE du ticket (« INFRA-123 ») — champ d'AFFICHAGE, re-synchronisé à chaque passe. */
  key: string;
  /** Titre du ticket. "" toléré : on préfère un titre vide à un titre inventé. */
  summary: string;
  /** Libellé BRUT du statut — AFFICHÉ TEL QUEL et JAMAIS traduit (décision D3 : les workflows sont
      configurables par projet, « En recette » et « Attente client » sont des statuts légitimes). */
  status: string;
  /** Catégorie FERMÉE de l'état (`ISSUE_STATUS_CATEGORIES`) : la SEULE base des couleurs, tris et
      filtres sémantiques — cf. `core/IssueStatus`, source unique de l'état affiché. */
  status_category: string;
  /** Type de ticket côté tracker (Bug / Tâche / …) — libellé brut, tolérant. */
  issue_type: string;
  /** Priorité (libellé brut), `null` si le tracker n'en expose pas. */
  priority: string | null;
  /** Personne assignée, sous forme AFFICHABLE (un nom, pas un identifiant de compte). */
  assignee: string | null;
  /** Auteur du ticket, sous forme AFFICHABLE. */
  reporter: string | null;
  /** Étiquettes du ticket — filtrables par APPARTENANCE (∈ `Schema.ARRAY_FIELDS`). Normalisées de
      façon DÉTERMINISTE (tri + dédup) par la frontière partagée : sans cela, un réordonnancement
      côté tracker suffirait à faire réécrire le ticket à chaque passe. */
  labels: string[];
  /** Libellé de résolution — `null` tant que le ticket est ouvert. */
  resolution: string | null;
  /** Création CÔTÉ TRACKER (ISO). Distincte de `created_date`, qui date l'enregistrement LOCAL. */
  created_src: string | null;
  /** Dernière modification CÔTÉ TRACKER (ISO). */
  updated_src: string | null;
  /** Lien CANONIQUE du ticket, composé par l'adaptateur et PERSISTÉ (décision D6). C'est ce qui rend
      le ticket ouvrable d'un clic même en mode fichier, après export, sans serveur ni configuration. */
  url: string | null;
  /** Ticket NON RÉSOLU à la dernière passe. ⚠ Ici cela veut dire « INTROUVABLE » — suppression,
      projet archivé ou permission perdue — et non « déconnecté » (wifi) ou « détruit » (VM). Jamais
      une suppression : l'enregistrement survit avec ses notes et ses liens. */
  orphan: boolean;
  /** Horodatage ISO de la dernière synchro ayant touché cet enregistrement. */
  last_sync: string;

  /* ---- champs LOCAUX (jamais touchés par la synchro) ---- */
  /** Note libre d'enrichissement (saisie utilisateur). */
  notes: string;
  /** Objets du modèle ciblés par le ticket, en clés COMPOSÉES « famille:id » (cf.
      `src-shared/IssueTargets`). Rattachement MANUEL (arbitrage A4) : rien n'est dérivé d'une
      convention imposée côté tracker. Détaché en cascade à la suppression de l'objet ciblé. */
  targets: string[];

  constructor(p: Props = {}) {
    super(p);
    /* --- SOURCE --- normalisation PARTAGÉE (IssueSync.normalizeSource). Une SEULE définition de la
       sémantique, commune au modèle client et au diff de réconciliation serveur : un écart de
       normalisation entre les deux côtés créerait de FAUX deltas à chaque synchro, donc une
       réécriture EN BOUCLE du document (révision qui monte, SSE, bruit d'undo) sans qu'aucune donnée
       n'ait bougé. Un test d'invariant compare les deux CHAMP PAR CHAMP. */
    const src = IssueSync.normalizeSource(p);
    this.ext_id = src.ext_id;
    this.provider_id = src.provider_id;
    this.key = src.key;
    this.summary = src.summary;
    this.status = src.status;
    this.status_category = src.status_category;
    this.issue_type = src.issue_type;
    this.priority = src.priority;
    this.assignee = src.assignee;
    this.reporter = src.reporter;
    this.labels = src.labels;
    this.resolution = src.resolution;
    this.created_src = src.created_src;
    this.updated_src = src.updated_src;
    this.url = src.url;
    this.orphan = src.orphan;
    this.last_sync = src.last_sync;
    /* --- LOCAUX --- (`description` est héritée d'Entity) */
    this.notes = p.notes || "";
    // `targets` : MÊME filtre que la normalisation de spec (`string[]` → chaînes seulement), sans
    // tri ni dédoublonnage. Volontairement PAS traité comme `labels` : ces clés sont SAISIES, la
    // normalisation de spec ne les réordonne pas, et le modèle doit lui coïncider — un aller-retour
    // d'écriture ne doit jamais déplacer une donnée. La FORME de chaque clé est jugée par
    // l'invariant de la spec (`IssueTargets.isValidKey`), l'unicité par l'éditeur de liens.
    this.targets = Array.isArray(p.targets) ? p.targets.filter((t: any) => typeof t === "string") : [];
  }

  /** Libellé d'affichage : la clé lisible, sinon le titre, sinon l'identité côté tracker. Règle
      UNIQUE (listing, fiche, palette de recherche) — la dupliquer laisserait les trois diverger au
      premier ajustement. La CLÉ prime sur le titre parce que c'est elle qu'on prononce et qu'on
      recopie (« regarde INFRA-123 »), et parce qu'elle est courte. Rend "" si l'enregistrement n'a
      rien d'affichable (l'appelant décide alors de son propre repli). */
  static displayName(issue: { key?: string; summary?: string; ext_id?: string } | null | undefined): string {
    if (!issue) return "";
    return (issue.key || "").trim() || (issue.summary || "").trim() || (issue.ext_id || "").trim();
  }
}
