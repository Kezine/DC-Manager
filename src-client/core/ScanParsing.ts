/* =============================================================================
   ScanParsing — parseurs NOMMÉS de la valeur décodée par le scan caméra.
   Documentation d'architecture : docs/qr-scan.md § « L'UI de scan ».

   DOCTRINE (maquette qr-saisie-camera, elle FAIT FOI) : « le scan est une SOURCE
   DE SAISIE, jamais une saisie parallèle ». Un champ qui accepte le scan déclare
   un parseur NOMMÉ ; la valeur décodée y passe AVANT toute injection — un champ
   sans parseur accepterait n'importe quel QR d'affiche. Et « jamais d'injection
   silencieuse » : une valeur non conforme est AFFICHÉE avec son avertissement,
   le bouton « Valider » du viseur est DÉSACTIVÉ (`ok: false`), l'utilisateur
   voit toujours ce que la caméra a lu.

   MODULE PUR (testé : Tests/modules/test-scan-ui.js) : aucune chaîne traduite
   ici — le résultat porte des CODES (`warning`), l'UI les traduit (clés
   `scan.warning.*`). Invariant v1 : `ok: false` ⟺ `warning` présent (pas
   d'avertissement « doux » à ce jour — la structure le permettrait).

   Les DEUX parseurs de la v1 :
     - `raw`    : valeur brute — trim, non vide, MONO-LIGNE (un vCard ou un QR
                  wifi multi-lignes ne convient pas à un <input> simple) ;
     - `serial` : n° de série — nettoie les préfixes CONSTRUCTEUR (« SN: »,
                  « S/N: », « SER »…, insensible à la casse), et REFUSE ce qui
                  ressemble à un LIEN (URL http(s) ou deep-link d'étiquette
                  DCM) : sur une planche d'étiquettes dense, c'est très
                  probablement le MAUVAIS code qui a été lu.
   ============================================================================= */

import { EntityLink } from "../../src-shared/EntityLink";

/** Identifiants des parseurs déclarables sur un champ (cf. `ui/ScanControl`). */
export type ScanParserId = "raw" | "serial";

/** Codes d'avertissement — l'UI traduit (`scan.warning.<code>`). */
export type ScanWarningCode = "empty" | "multiline" | "linklike";

/** Résultat structuré d'un parseur : `ok` pilote le bouton « Valider » du viseur ;
    `value` est TOUJOURS affichable (même refusée — doctrine « jamais silencieux ») ;
    `warning` est le code de la raison quand `ok` est faux. */
export interface ScanParseResult { ok: boolean; value: string; warning?: ScanWarningCode; }

export class ScanParsing {
  /** Préfixes CONSTRUCTEUR d'un n° de série : « SN », « S/N », « SER », « SERIAL »
      (+ qualificatif « No/Nr/Num/Number/# » optionnel), suivis d'un SÉPARATEUR
      EXPLICITE (`:`, `=`, `#` ou espace). ⚠ Le séparateur est REQUIS : sans lui,
      « SN123456 » (service tag réel) ou « Server-01 » seraient amputés — le
      backtracking de la regex garantit qu'un préfixe sans séparateur ne matche pas. */
  private static readonly SERIAL_PREFIX = /^(?:s\/?n|ser(?:ial)?)\s*(?:n[°o]\.?|nr\.?|num(?:ber)?\.?|#)?\s*(?:[:=#]|\s)\s*/i;

  /** Route vers le parseur nommé — point d'entrée du viseur (le champ déclare l'id). */
  static parse(parser: ScanParserId, text: unknown): ScanParseResult {
    return parser === "serial" ? ScanParsing.serial(text) : ScanParsing.raw(text);
  }

  /** Valeur BRUTE : trim, non vide, mono-ligne. Aucune règle métier — c'est le
      parseur du greffon GÉNÉRIQUE (« scan partout ») et du raccourci clavier. */
  static raw(text: unknown): ScanParseResult {
    const value = String(text ?? "").trim();
    if (!value) return { ok: false, value: "", warning: "empty" };
    if (/[\r\n]/.test(value)) return { ok: false, value, warning: "multiline" };
    return { ok: true, value };
  }

  /** N° de SÉRIE : mono-ligne, préfixes constructeur nettoyés, garde anti-lien. */
  static serial(text: unknown): ScanParseResult {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return { ok: false, value: "", warning: "empty" };
    /* Multi-ligne testé AVANT le nettoyage : un contenu structuré (vCard…) n'est
       pas un n° de série, inutile d'y chercher un préfixe. */
    if (/[\r\n]/.test(trimmed)) return { ok: false, value: trimmed, warning: "multiline" };
    const value = trimmed.replace(ScanParsing.SERIAL_PREFIX, "").trim();
    if (!value) return { ok: false, value: "", warning: "empty" };
    if (ScanParsing.looksLikeLink(value)) return { ok: false, value, warning: "linklike" };
    return { ok: true, value };
  }

  /** « Ressemble à un lien » : URL http(s), ou deep-link d'étiquette DCM — la
      SOURCE UNIQUE du format (`src-shared/EntityLink.parse`) décide, jamais une
      regex maison qui divergerait du vrai format. */
  private static looksLikeLink(value: string): boolean {
    if (/^https?:\/\//i.test(value)) return true;
    return EntityLink.parse(value) !== null;
  }
}
