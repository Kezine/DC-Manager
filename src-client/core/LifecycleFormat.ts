/* =============================================================================
   LifecycleFormat — PRÉSENTATION du CYCLE DE VIE matériel (aucun DOM, aucun store,
   aucun réseau) : ÂGE d'un équipement depuis sa date d'achat + ÉTAT de sa garantie
   depuis sa date de fin. Consommé par les FICHES (EquipmentForms/SubEquipmentForms)
   et par la colonne combinée « Âge / garantie » des LISTINGS (ListConfigs).

   ⚠ La RÈGLE jours/frontières (parse ISO/UTC, `daysUntil`, seuil `WARN_DAYS`,
   décision `ok`/`warn`/`err` avec la borne « J-0 = encore couverte ») vit dans le
   module PARTAGÉ `src-shared/Lifecycle` depuis le chantier garantie-alerte
   (2026-08-15) : le veilleur SERVEUR `WarrantyExpiryWatcher` applique la MÊME
   frontière que l'affichage — ce fichier DÉLÈGUE et ne garde que ce qui est
   propre à la présentation : décomposition calendaire, granularité adaptative,
   libellés i18n, et l'état de FILTRE (`warrantyFilterState`).

   Pourquoi une classe pure dédiée (principes n°2/n°7) : ces règles (décomposition
   calendaire, granularité adaptative) sont testables en isolation
   (Tests/modules/test-lifecycle-format.js) et réutilisables par les vues sans les
   charger de calculs. Le PRÉCÉDENT direct est `core/CertsFormat` (échéances des
   certificats) : comme lui, on compose les libellés via `I18n.t` au POINT DE RENDU
   (rien n'est évalué au chargement du module, donc jamais de `t()` avant `I18n.init()`),
   et on renvoie un STATUT sémantique (`ok`/`warn`/`err`) que la VUE mappe en couleur
   (var(--ok)/var(--warn)/var(--err)) — exactement comme `CertsAdminView` mappe
   `CertsFormat.expiryClass`. Aucune couleur/CSS n'est donc décidée ici.

   `now: Date` est TOUJOURS INJECTÉ (jamais de `new Date()` interne) : c'est ce qui
   rend l'âge et l'échéance déterministes en test (bissextiles, fins de mois, bornes
   de granularité, frontière exacte des 90 jours). */
import { I18n } from "../i18n/I18n";
import { Lifecycle, type WarrantyStatus } from "../../src-shared/Lifecycle";

/** Ré-export du statut PARTAGÉ (mappé en variable CSS par la vue) : les consommateurs
    historiques continuent d'importer depuis ce fichier — la définition vit dans src-shared/. */
export type { WarrantyStatus };

/** État de FILTRE de garantie (volet 2 du TODO `age-garantie-mise-en-evidence`) : les trois statuts
    de `WarrantyStatus` + `"none"` — un 4ᵉ état qui n'existe QUE pour le filtre (cf. `warrantyFilterState`). */
export type WarrantyFilterState = WarrantyStatus | "none";

/** État de garantie rendu : le STATUT sémantique + le LIBELLÉ déjà localisé (« expire dans X »,
    « expirée depuis X », « expire aujourd'hui »). La vue mappe `status` → couleur, elle ne reformule pas. */
export interface WarrantyState {
  status: WarrantyStatus;
  label: string;
}

/** Décomposition calendaire d'une durée (ans / mois / jours restants) — brique PURE, testable sans i18n. */
export interface DurationParts {
  years: number;
  months: number;
  days: number;
}

export class LifecycleFormat {
  /** Seuil d'AVERTISSEMENT de garantie — ALIAS de la source unique `Lifecycle.WARN_DAYS`
      (src-shared/) : conservé pour les consommateurs historiques, JAMAIS une seconde valeur. */
  static readonly WARN_DAYS = Lifecycle.WARN_DAYS;

  /** Jours ENTIERS de `now` vers l'échéance `iso` — DÉLÉGATION pure à la règle partagée
      (`Lifecycle.daysUntil`), conservée ici pour les appelants historiques du client. */
  static daysUntil(iso: string | null | undefined, now: Date): number | null {
    return Lifecycle.daysUntil(iso, now);
  }

  /** Décomposition calendaire de la durée écoulée entre `from` et `to` (années pleines, puis mois pleins,
      puis jours restants). Si `to` ≤ `from`, renvoie une durée NULLE (jamais de composante négative).
      Algorithme d'emprunt classique : quand les jours passent en négatif, on emprunte les jours du mois
      PRÉCÉDANT `to` (d'où la sensibilité correcte aux fins de mois et aux années bissextiles). */
  static breakdown(from: Date, to: Date): DurationParts {
    const zero: DurationParts = { years: 0, months: 0, days: 0 };
    if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return zero;
    const fromMs = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const toMs = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    if (toMs <= fromMs) return zero;
    let years = to.getUTCFullYear() - from.getUTCFullYear();
    let months = to.getUTCMonth() - from.getUTCMonth();
    let days = to.getUTCDate() - from.getUTCDate();
    if (days < 0) {
      months -= 1;
      // Jours du mois précédant celui de `to` (jour 0 du mois de `to` = dernier jour du mois d'avant).
      const daysInPrevMonth = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 0)).getUTCDate();
      days += daysInPrevMonth;
    }
    if (months < 0) { years -= 1; months += 12; }
    return { years, months, days };
  }

  /** Libellé d'une durée à granularité ADAPTATIVE, localisé : « 3 ans 2 mois » (≥ 1 an, mois omis si 0),
      « 8 mois » (< 1 an), « 12 jours » (< 1 mois). Composé via `I18n.t` (pluriels `_one`/`_other`). */
  static durationLabel(from: Date, to: Date): string {
    const b = LifecycleFormat.breakdown(from, to);
    if (b.years >= 1) {
      const parts = [I18n.t("detail.lifecycle.years", { count: b.years })];
      if (b.months > 0) parts.push(I18n.t("detail.lifecycle.months", { count: b.months }));
      return parts.join(" ");
    }
    if (b.months >= 1) return I18n.t("detail.lifecycle.months", { count: b.months });
    return I18n.t("detail.lifecycle.days", { count: b.days });
  }

  /** ÂGE écoulé depuis la date d'achat, localisé (« 3 ans 2 mois »…) ; null si vide/illisible ou si l'achat
      est POSTÉRIEUR à `now` (jamais un âge négatif). Un achat DU JOUR (0 jour) affiche « 0 jour » — décision
      assumée et testée : l'âge zéro reste une information, on ne le masque pas. */
  static age(purchaseIso: string | null | undefined, now: Date): string | null {
    const d = Lifecycle.parseDate(purchaseIso);
    if (!d || !Lifecycle.validNow(now)) return null;
    const days = Lifecycle.daysUntil(purchaseIso, now);   // now → achat : > 0 si l'achat est dans le futur
    if (days === null || days > 0) return null;
    return LifecycleFormat.durationLabel(d, now);
  }

  /** ÉTAT de garantie depuis la date de fin : le STATUT vient de la règle PARTAGÉE
      (`Lifecycle.warrantyStatus` — frontières J-0/90 j décidées LÀ-BAS, jamais re-dérivées ici),
      ce fichier n'y AJOUTE que le libellé localisé : `err` → « expirée depuis X », `warn` à J-0 →
      « expire aujourd'hui », sinon « expire dans X » (warn et ok partagent la formulation).
      null si vide/illisible ou `now` invalide (mêmes cas que la règle partagée). */
  static warranty(warrantyIso: string | null | undefined, now: Date): WarrantyState | null {
    const status = Lifecycle.warrantyStatus(warrantyIso, now);
    const d = Lifecycle.parseDate(warrantyIso);
    const days = Lifecycle.daysUntil(warrantyIso, now);
    if (status === null || !d || days === null) return null;   // les trois sont null exactement ensemble
    if (status === "err") return { status, label: I18n.t("detail.lifecycle.expiredSince", { d: LifecycleFormat.durationLabel(d, now) }) };
    if (days === 0) return { status, label: I18n.t("detail.lifecycle.expiresToday") };
    return { status, label: I18n.t("detail.lifecycle.expiresIn", { d: LifecycleFormat.durationLabel(now, d) }) };
  }

  /** État de FILTRE de garantie (volet 2 du TODO `age-garantie-mise-en-evidence`, § 2 — filtre-colonne
      à états CALCULÉS sur la colonne combinée « Âge / garantie », zéro primitive nouvelle). DÉLÈGUE
      à `warranty(...)` pour les trois statuts existants — JAMAIS de re-dérivation du seuil `WARN_DAYS` :
      une seule source pour « c'est `warn` ». `"none"` couvre tout le reste (vide, chaîne illisible, `now`
      invalide) : `warranty` renvoie `null` pour « pas de garantie », ce qui ne se filtre PAS — le filtre
      a besoin d'un état TOTAL (une valeur pour CHAQUE ligne) afin qu'un enregistrement sans date de fin
      reste TROUVABLE via l'option « Sans garantie », plutôt qu'invisible de toute sélection. */
  static warrantyFilterState(warrantyIso: string | null | undefined, now: Date): WarrantyFilterState {
    const w = LifecycleFormat.warranty(warrantyIso, now);
    return w ? w.status : "none";
  }
}
