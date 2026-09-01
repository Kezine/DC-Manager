/* =============================================================================
   ScanControl — le GREFFON de scan attachable à un champ de saisie (+ les points
   d'entrée transverses : générique « scan partout », raccourci clavier, entrée
   globale). Documentation : docs/qr-scan.md § « L'UI de scan ». La maquette
   design-system/briefs/qr-saisie-camera-maquette.html FAIT FOI.

   PRINCIPE n°14 APPLIQUÉ AU SCAN : UNE primitive, jamais un contrôle réinventé
   par vue. Un formulaire qui veut le scan sur un champ appelle
   `ScanControl.attach({ input, parser, fieldKey, label })` — le greffon pose un
   bouton-icône 44px (registre `Icons.SCAN`, aria-label + tooltip) ACCOLÉ au
   champ, qui ouvre le VISEUR (`ui/ScanViewfinder`) et INJECTE la valeur
   validée. DEUX régimes d'attachement :
     - DÉCLARÉ : le champ nomme son parseur (`serial` pour les n° de série) et
       sa clé de mémoire de ROI — les 3 champs `serial` de l'app (équipements,
       sous-équipements, spares) sont branchés ainsi ;
     - GÉNÉRIQUE : la préférence « bouton scan sur tous les champs texte »
       (Prefs.scanAllFields) greffe le bouton sur les champs texte DIRECTS des
       rangées de formulaire (`.form-field > input[type=text]`), parseur `raw` —
       les contrôles COMPOSITES (date, entity picker, chips…) enveloppent leur
       input dans un div interne et sont donc exclus PAR CONSTRUCTION.

   VISIBILITÉ (décision pure `core/ScanAffordance`) : pointeur grossier OU écran
   étroit OU préférence de forçage, ET une caméra existe, ET contexte sécurisé —
   évaluée à l'attachement (les champs vivent le temps d'une modale, on ne suit
   pas un resize en cours de saisie).

   INJECTION « COMME UNE FRAPPE » : setter NATIF de la valeur + événements
   `input` et `change` qui bulle — les écouteurs du formulaire (validation
   live, onchange…) réagissent exactement comme à une saisie clavier ; flash de
   confirmation + focus rendu au champ (maquette).

   L'HÔTE est INJECTÉ par `setup()` (main.ts) : pile de modales standard +
   préférences — ce module n'importe ni `Prefs` ni le Store. Tant que `setup`
   n'a pas été appelé, tout est no-op (robustesse tests headless).
   ============================================================================= */

import type { ModalOptions } from "./Modal";
import { Icons } from "./Icons";
import { ScanViewfinder } from "./ScanViewfinder";
import type { ScanViewfinderHost } from "./ScanViewfinder";
import { BarcodeDetection } from "../core/BarcodeDetection";
import { ScanAffordance } from "../core/ScanAffordance";
import type { ScanParserId } from "../core/ScanParsing";
import type { ScanEngineMode } from "../core/Prefs";
import type { AppLinkTarget } from "../../src-shared/AppLink";
import { I18n } from "../i18n/I18n";

/** Ce que le greffon attend de l'application (câblé UNE fois par main.ts). */
export interface ScanControlHost extends ScanViewfinderHost {
  openModal(opts: ModalOptions): void;
  closeModal(): void;
  enginePref(): ScanEngineMode;
  setEnginePref(mode: ScanEngineMode): void;
  /** Préférence « bouton scan sur tous les champs texte » (greffon générique). */
  scanAllFields(): boolean;
  /** Préférence « toujours afficher le bouton » (forçage desktop, webcam poste fixe). */
  forceButtons(): boolean;
}

/** Attachement DÉCLARÉ d'un champ (cf. en-tête). */
export interface ScanAttachSpec {
  input: HTMLInputElement;
  /** Parseur NOMMÉ de la valeur décodée (`core/ScanParsing`). */
  parser: ScanParserId;
  /** Clé STABLE de la mémoire de ROI (ex. « equipments.serial »). */
  fieldKey: string;
  /** Libellé du champ — aria-label du bouton et sous-titre du viseur. */
  label: string;
}

export class ScanControl {
  private static host: ScanControlHost | null = null;
  /** Champs déjà greffés (WeakSet : un champ ne reçoit jamais deux boutons). */
  private static grafted = new WeakSet<HTMLElement>();
  /** Spec d'un champ greffé — relue par le raccourci clavier (parseur du champ s'il est déclaré). */
  private static specs = new WeakMap<HTMLElement, ScanAttachSpec>();
  /** Dernier champ texte ÉDITABLE focalisé (entrée globale : « injecter dans le dernier champ »).
      Jamais effacé au blur : cliquer le bouton de la topbar déplace le focus, la cible doit survivre. */
  private static lastField: HTMLInputElement | HTMLTextAreaElement | null = null;
  /** Sonde caméra/contexte, UNE fois par session (l'énumération des périphériques ne change
      pas pendant une saisie — et une webcam branchée en cours de route se règle par F5). */
  private static probePromise: Promise<{ hasCamera: boolean; secureContext: boolean }> | null = null;

  /** Câblage de l'hôte — à appeler UNE fois au bootstrap, avant tout attach. */
  static setup(host: ScanControlHost): void { ScanControl.host = host; }

  /* ------------------------------- attachement ------------------------------- */

  /** Greffe le bouton de scan sur `spec.input` : enveloppe le champ dans une rangée
      `.scan-row` (à sa place dans le DOM) et pose le bouton 44px à sa droite. La
      visibilité est résolue en async (sonde caméra) — bouton masqué en attendant. */
  static attach(spec: ScanAttachSpec): void {
    const host = ScanControl.host;
    const input = spec.input;
    if (!host || ScanControl.grafted.has(input) || !input.parentElement) return;
    ScanControl.grafted.add(input);
    ScanControl.specs.set(input, spec);

    const wrap = document.createElement("div"); wrap.className = "scan-row";
    input.parentElement.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "scan-btn";
    btn.innerHTML = Icons.SCAN;   // constante de confiance (registre ui/Icons)
    btn.setAttribute("aria-label", I18n.t("scan.button.label", { field: spec.label }));
    btn.title = I18n.t("scan.button.tip");
    btn.style.display = "none";
    btn.onclick = () => ScanControl.openViewfinder(spec);
    wrap.appendChild(btn);

    void ScanControl.probe().then((probe) => {
      const visible = ScanAffordance.fieldButton({
        ...ScanControl.mediaFlags(),
        forced: host.forceButtons() || host.scanAllFields(),
        ...probe,
      });
      if (visible) btn.style.display = "";
    });
  }

  /** Régime GÉNÉRIQUE : observe le corps des modales (`Modal.body`, injecté par main.ts) et
      greffe — quand la préférence est active — les champs texte des formulaires qui s'y posent.
      La préférence est relue à CHAQUE lot de mutations : l'activer prend effet à la prochaine
      ouverture de formulaire, sans rechargement. */
  static installGeneric(formRoot: HTMLElement): void {
    const sweep = (node: Element): void => {
      const host = ScanControl.host;
      if (!host || !host.scanAllFields()) return;
      if (node.matches('input[type="text"]')) ScanControl.maybeGenericAttach(node as HTMLInputElement);
      node.querySelectorAll('input[type="text"]').forEach((el) => ScanControl.maybeGenericAttach(el as HTMLInputElement));
    };
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) m.addedNodes.forEach((n) => { if (n.nodeType === 1) sweep(n as Element); });
    });
    observer.observe(formRoot, { childList: true, subtree: true });
  }

  /** Un champ est-il éligible au greffon GÉNÉRIQUE ? Enfant DIRECT d'une rangée `.form-field`
      (les composites — date, picker, chips, recherche — enveloppent leur input : exclus par
      construction), éditable, pas déjà greffé. */
  private static maybeGenericAttach(input: HTMLInputElement): void {
    if (ScanControl.grafted.has(input) || input.readOnly || input.disabled) return;
    const parent = input.parentElement;
    if (!parent || !parent.classList.contains("form-field")) return;
    const label = ScanControl.labelOf(input);
    ScanControl.attach({
      input, parser: "raw",
      fieldKey: ScanControl.genericKeyOf(input),
      label: label || I18n.t("scan.viewfinder.genericField"),
    });
  }

  /* ----------------------------- points d'entrée ----------------------------- */

  /** Suivi du dernier champ texte actif (entrée globale) — à installer UNE fois au bootstrap. */
  static installFieldTracking(): void {
    document.addEventListener("focusin", (e) => {
      const target = e.target;
      if (ScanControl.isEditableTextField(target)) ScanControl.lastField = target;
    });
  }

  /** RACCOURCI CLAVIER (Ctrl+Maj+S, enregistré par main.ts) : ouvre le viseur sur le champ
      FOCALISÉ — parseur du champ s'il est greffé en déclaré, brut sinon. */
  static openForField(field: HTMLInputElement | HTMLTextAreaElement): void {
    const host = ScanControl.host;
    if (!host) return;
    const declared = ScanControl.specs.get(field);
    ScanViewfinder.open(host, {
      kind: "field",
      parser: declared ? declared.parser : "raw",
      fieldKey: declared ? declared.fieldKey : ScanControl.genericKeyOf(field),
      label: declared ? declared.label : (ScanControl.labelOf(field) || I18n.t("scan.viewfinder.genericField")),
      onValidate: (value) => ScanControl.injectValue(field, value),
    });
  }

  /** Entrée GLOBALE « scanner une étiquette » (topbar) : viseur en mode LIBRE — un lien direct
      OUVRE sa cible (`openTarget` = l'instance `AppLinkOpener` de main.ts, jamais dupliquée),
      sinon panneau d'actions (copier / injecter dans le DERNIER champ actif / lien si URL).
      La cible d'injection est CAPTURÉE à l'ouverture : le focus bouge pendant le scan. */
  static openGlobal(opts: { openTarget(target: AppLinkTarget): void }): void {
    const host = ScanControl.host;
    if (!host) return;
    const captured = ScanControl.lastField;
    const injectable = (): boolean =>
      !!captured && document.contains(captured) && !captured.disabled && !captured.readOnly;
    ScanViewfinder.open(host, {
      kind: "free",
      onDeepLink: (target) => opts.openTarget(target),
      canInject: injectable,
      onInject: (value) => { if (injectable()) ScanControl.injectValue(captured!, value); },
    });
  }

  /** L'entrée globale a-t-elle un sens sur ce poste ? (caméra + contexte — pas de condition
      tactile : scanner une étiquette à la webcam d'un poste fixe est un cas d'usage entier.) */
  static async globalAvailable(): Promise<boolean> {
    const probe = await ScanControl.probe();
    return ScanAffordance.globalEntry({ ...ScanControl.mediaFlags(), forced: false, ...probe });
  }

  /* -------------------------------- utilitaires ------------------------------ */

  /** Le champ est-il une saisie TEXTE éditable ? (garde du raccourci et du suivi de focus —
      ni readonly, ni disabled ; types texte au sens large, password EXCLU.) */
  static isEditableTextField(el: unknown): el is HTMLInputElement | HTMLTextAreaElement {
    if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "text").toLowerCase();
      const textual = type === "text" || type === "search" || type === "url" || type === "tel" || type === "email";
      return textual && !el.readOnly && !el.disabled;
    }
    return false;
  }

  /** INJECTE la valeur « comme une frappe » : setter natif (les proxys de valeur posés par des
      frameworks éventuels sont contournés proprement) + `input`/`change` qui bullent, flash de
      confirmation (maquette) et focus rendu au champ. */
  static injectValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(field, value);
    else (field as { value: string }).value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    // Re-déclenche l'animation même si la classe était déjà posée (reflow forcé, idiome maquette).
    field.classList.remove("scan-flash");
    void field.offsetWidth;
    field.classList.add("scan-flash");
    try { field.focus(); } catch { /* champ non focusable : sans conséquence */ }
  }

  private static openViewfinder(spec: ScanAttachSpec): void {
    const host = ScanControl.host;
    if (!host) return;
    ScanViewfinder.open(host, {
      kind: "field",
      parser: spec.parser,
      fieldKey: spec.fieldKey,
      label: spec.label,
      onValidate: (value) => ScanControl.injectValue(spec.input, value),
    });
  }

  /** Sonde caméra + contexte, mémoïsée (cf. déclaration de `probePromise`). */
  private static probe(): Promise<{ hasCamera: boolean; secureContext: boolean }> {
    if (!ScanControl.probePromise) {
      const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      const secureContext = !!(media && media.getUserMedia);
      ScanControl.probePromise = BarcodeDetection.listCameras()
        .then((cameras) => ({ hasCamera: cameras.length > 0, secureContext }));
    }
    return ScanControl.probePromise;
  }

  /** Prédicats d'AFFICHAGE bruts (les requêtes média vivent dans `core/ScanAffordance`). */
  private static mediaFlags(): { coarsePointer: boolean; narrowScreen: boolean } {
    try {
      return {
        coarsePointer: window.matchMedia(ScanAffordance.COARSE_POINTER_QUERY).matches,
        narrowScreen: window.matchMedia(ScanAffordance.NARROW_SCREEN_QUERY).matches,
      };
    } catch { return { coarsePointer: false, narrowScreen: false }; }
  }

  /** Libellé du champ : le <label> de sa rangée de formulaire (vide hors formulaire). */
  private static labelOf(field: HTMLElement): string {
    const row = field.closest(".form-field");
    const label = row ? row.querySelector("label") : null;
    return ((label && label.textContent) || "").trim();
  }

  /** Clé de mémoire de ROI d'un champ NON déclaré : dérivée du libellé de sa rangée — stable
      d'une ouverture à l'autre du même formulaire, ce que demande la mémoire par champ. (Elle
      suit la langue de l'UI : accepté, la mémoire de zone est un confort.) */
  private static genericKeyOf(field: HTMLElement): string {
    const label = ScanControl.labelOf(field);
    return label ? "field:" + label.toLowerCase().replace(/\s+/g, "-").slice(0, 64) : "field:generic";
  }
}
