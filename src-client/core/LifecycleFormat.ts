/* =============================================================================
   LifecycleFormat — logique PURE du CYCLE DE VIE matériel (aucun DOM, aucun store,
   aucun réseau) : ÂGE d'un équipement depuis sa date d'achat + ÉTAT de sa garantie
   depuis sa date de fin. Consommé par les FICHES (EquipmentForms/SubEquipmentForms)
   et par la colonne combinée « Âge / garantie » des LISTINGS (ListConfigs).

   Pourquoi une classe pure dédiée (principes n°2/n°7) : ces règles (décomposition
   calendaire, seuil de garantie, granularité adaptative) sont testables en isolation
   (Tests/modules/test-lifecycle-format.js) et réutilisables par les vues sans les
   charger de calculs. Le PRÉCÉDENT direct est `core/CertsFormat` (échéances des
   certificats) : comme lui, on compose les libellés via `I18n.t` au POINT DE RENDU
   (rien n'est évalué au chargement du module, donc jamais de `t()` avant `I18n.init()`),
   et on renvoie un STATUT sémantique (`ok`/`warn`/`err`) que la VUE mappe en couleur
   (var(--ok)/var(--warn)/var(--err)) — exactement comme `CertsAdminView` mappe
   `CertsFormat.expiryClass`. Aucune couleur/CSS n'est donc décidée ici.

   `now: Date` est TOUJOURS INJECTÉ (jamais de `new Date()` interne) : c'est ce qui
   rend l'âge et l'échéance déterministes en test (bissextiles, fins de mois, bornes
   de granularité, frontière exacte des 90 jours).

   DATES : les champs `purchase_date` / `warranty_end` sont des chaînes ISO COURTES
   (« YYYY-MM-DD », `default: ""`). On raisonne en UTC (composantes getUTC*) pour
   coller à la nature « date seule » de ces champs et rester insensible au fuseau. */
import { I18n } from "../i18n/I18n";

/** Statut d'une garantie (mappé en variable CSS par la vue) : sous garantie / bientôt / expirée. */
export type WarrantyStatus = "ok" | "warn" | "err";

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
  /** Seuil d'AVERTISSEMENT de garantie : une échéance à 90 jours ou moins passe en `warn` (orange).
      Constante nommée (comme `CertsFormat.WARN_DAYS`) : source unique, réutilisée/testée sans la redécouvrir. */
  static readonly WARN_DAYS = 90;

  /** Millisecondes par jour (constante nommée : évite les 86400000 magiques). */
  private static readonly DAY_MS = 24 * 60 * 60 * 1000;

  /** Parse une date ISO courte en `Date` (UTC), ou null si vide / non-chaîne / illisible. */
  private static parse(iso: string | null | undefined): Date | null {
    if (typeof iso !== "string" || iso.trim() === "") return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Date(t);
  }

  /** `now` est-il une `Date` valide ? (garde-fou : un appelant peut passer n'importe quoi). */
  private static validNow(now: Date): boolean {
    return now instanceof Date && !Number.isNaN(now.getTime());
  }

  /** Jours ENTIERS de `now` vers l'échéance `iso` (négatif si déjà passée) ; null si date/`now` invalide.
      Différence de MINUITS UTC → entier exact (plancher), même granularité « jour » que `CertsFormat.daysUntil`. */
  static daysUntil(iso: string | null | undefined, now: Date): number | null {
    const d = LifecycleFormat.parse(iso);
    if (!d || !LifecycleFormat.validNow(now)) return null;
    const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((b - a) / LifecycleFormat.DAY_MS);
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
    const d = LifecycleFormat.parse(purchaseIso);
    if (!d || !LifecycleFormat.validNow(now)) return null;
    const days = LifecycleFormat.daysUntil(purchaseIso, now);   // now → achat : > 0 si l'achat est dans le futur
    if (days === null || days > 0) return null;
    return LifecycleFormat.durationLabel(d, now);
  }

  /** ÉTAT de garantie depuis la date de fin : `err` = expirée (« expirée depuis X »), `warn` = expire dans
      ≤ WARN_DAYS jours (« expire dans X », ou « expire aujourd'hui » à J-0), `ok` au-delà (« expire dans X »).
      null si vide/illisible ou `now` invalide.
      BORNE « expire aujourd'hui » (décision assumée + testée) : le jour même de l'échéance = encore `warn`,
      PAS `err` — la garantie couvre la journée en cours ; seul un dépassement STRICT (jours < 0) passe en `err`. */
  static warranty(warrantyIso: string | null | undefined, now: Date): WarrantyState | null {
    const d = LifecycleFormat.parse(warrantyIso);
    if (!d || !LifecycleFormat.validNow(now)) return null;
    const days = LifecycleFormat.daysUntil(warrantyIso, now);
    if (days === null) return null;
    if (days < 0) return { status: "err", label: I18n.t("detail.lifecycle.expiredSince", { d: LifecycleFormat.durationLabel(d, now) }) };
    if (days === 0) return { status: "warn", label: I18n.t("detail.lifecycle.expiresToday") };
    const status: WarrantyStatus = days <= LifecycleFormat.WARN_DAYS ? "warn" : "ok";
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
