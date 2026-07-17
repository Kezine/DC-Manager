/* ============================================================================
   I18n — infrastructure de LOCALISATION du client (français / anglais).
   ----------------------------------------------------------------------------
   POURQUOI i18next (choix utilisateur, principe n°12 CLAUDE.md) : moteur de
   traduction éprouvé, sans dépendance framework, gérant l'interpolation, le
   repli de langue et le chargement de catalogues « en mémoire ». On l'enveloppe
   dans cette classe sémantique à méthodes statiques (principe n°2) pour NE PAS
   exposer i18next partout dans l'app : le reste du code n'appelle que `I18n.t`.

   MODÈLE v1 (assumé, cf. docs/i18n.md) :
   - PRÉFÉRENCE persistée dans localStorage ("fr" | "en" | absente = auto).
   - En mode AUTO, on suit la langue du navigateur (« en… » → anglais, sinon
     français par repli — le domaine métier est francophone).
   - Un changement de préférence RECHARGE la page (`location.reload`) plutôt que
     de re-render l'app à chaud : l'UI est construite une fois au boot, changer
     de langue est un événement RARISSIME → un reload est plus simple et sûr
     qu'un ré-affichage global (aucune vue à réhydrater, aucun état à recâbler).

   INIT AVANT UI : `init()` DOIT être appelé au tout début du bootstrap, avant
   toute construction d'interface — sinon `t()` jette (garde-fou explicite).
   `initAsync: false` force i18next à charger les catalogues (fournis en ligne
   via `resources`) de façon SYNCHRONE : `t()` fonctionne dès le retour d'`init()`,
   sans attendre une micro-tâche (l'option historique `initImmediate` a été
   renommée `initAsync` en i18next 26 ; même sémantique inversée). */
import { createInstance } from "i18next";
import type { i18n as I18nextInstance, TOptions } from "i18next";
import { fr } from "./locales/fr";
import { en } from "./locales/en";

/** Locale EFFECTIVE (langue réellement active). */
export type LocaleCode = "fr" | "en";
/** Préférence utilisateur : une locale explicite, ou « auto » (= détection navigateur). */
export type LocalePreference = LocaleCode | "auto";

export class I18n {
  /** Clé de persistance de la préférence de langue (localStorage). */
  static readonly STORAGE_KEY = "dcmanager.locale";
  /** Repli quand aucune traduction n'existe pour la locale active. Le FR est la source de vérité. */
  static readonly FALLBACK: LocaleCode = "fr";

  /** Instance i18next dédiée (createInstance → pas de singleton global partagé, testable/isolable). */
  private static instance: I18nextInstance | null = null;
  /** Locale effective résolue à l'init (mémorisée pour `locale` sans re-dériver). */
  private static effective: LocaleCode = "fr";

  /** Initialise le moteur de traduction. Idempotent (un second appel est ignoré). */
  static init(): void {
    if (I18n.instance) return;
    const lng = I18n.resolve(I18n.preference);
    I18n.effective = lng;
    const inst = createInstance();
    // Catalogues fournis EN LIGNE (namespace i18next par défaut « translation ») → aucun backend, init synchrone.
    inst.init({
      lng,
      fallbackLng: I18n.FALLBACK,
      initAsync: false,
      // On n'injecte PAS le résultat de `t()` dans du HTML via i18next : l'échappement est géré au point d'insertion
      // (textContent / Html.escape). Désactivé pour ne pas transformer « & », « < »… en entités dans du texte brut.
      interpolation: { escapeValue: false },
      resources: { fr: { translation: fr }, en: { translation: en } },
    });
    I18n.instance = inst;
    // Reflète la langue active sur <html lang> (accessibilité, moteurs de recherche, césure/sélection). Best-effort.
    try { document.documentElement.lang = lng; } catch (_) { /* pas de DOM (tests) : sans effet */ }
  }

  /** Traduit une clé (`"domaine.sous.clé"`), avec paramètres d'interpolation optionnels (`{ n: 3 }`). */
  static t(key: string, params?: TOptions): string {
    if (!I18n.instance) {
      throw new Error("I18n.t() appelé avant I18n.init() : initialiser la localisation au bootstrap, avant toute construction d'UI.");
    }
    // Cast : sans augmentation de type des ressources, i18next type déjà le retour en `string` pour une clé `string`.
    return I18n.instance.t(key, params) as string;
  }

  /** Locale EFFECTIVE (langue réellement active après résolution auto/préférence). */
  static get locale(): LocaleCode { return I18n.effective; }

  /** Préférence PERSISTÉE : "fr" | "en" | "auto" (valeur inconnue ou absente = "auto"). */
  static get preference(): LocalePreference {
    try {
      const v = window.localStorage.getItem(I18n.STORAGE_KEY);
      return (v === "fr" || v === "en") ? v : "auto";
    } catch (_) {
      return "auto";   // stockage indisponible (mode privé strict, tests) → comportement par défaut
    }
  }

  /** Persiste la préférence puis RECHARGE la page (cf. modèle v1 : reload plutôt que re-render à chaud). */
  static setPreference(pref: LocalePreference): void {
    try {
      if (pref === "auto") window.localStorage.removeItem(I18n.STORAGE_KEY);
      else window.localStorage.setItem(I18n.STORAGE_KEY, pref);
    } catch (_) { /* stockage indisponible : on recharge quand même (la préférence ne sera juste pas mémorisée) */ }
    try { location.reload(); } catch (_) { /* pas de navigateur (tests) : sans effet */ }
  }

  /** Dérive la locale EFFECTIVE depuis la préférence : explicite si donnée, sinon détection navigateur (repli FR). */
  private static resolve(pref: LocalePreference): LocaleCode {
    if (pref === "fr" || pref === "en") return pref;
    let lang = "";
    try { lang = (navigator.language || "").toLowerCase(); } catch (_) { lang = ""; }
    // Seul l'anglais est proposé en plus du français : tout ce qui n'est pas « en… » retombe sur le français.
    return lang.indexOf("en") === 0 ? "en" : "fr";
  }
}
