import { DataValidator } from "../../../src-shared/DataValidation";
import type { ValidationError, EntityFetcher, RecordFinder } from "../../../src-shared/DataValidation";
import { OverlayA11y } from "../../ui/OverlayA11y";

/* ============================================================================
   VALIDATION LIVE D'UN FORMULAIRE — surlignage des champs en erreur + messages.

   Relie chaque champ d'un formulaire (par son CHEMIN de validation, ex. "name",
   "cidr", "address") à son contrôle DOM, puis s'appuie sur EXACTEMENT la même
   validation PARTAGÉE que le Store et le serveur (`DataValidator.validateRecord`).
   → cohérence totale : ce que le formulaire surligne est ce que l'autorité refuse.

   Le surlignage agit sur la rangée `.form-field` parente du contrôle (cf. FormControls)
   et y insère un message `.field-error`. Le `fetch` optionnel (ex. `store.get`) active
   l'intégrité référentielle (V2) et les règles cross-entité (V5, ex. IP ∈ CIDR).

   ACCESSIBILITÉ : le contrôle fautif reçoit `aria-invalid="true"` et un
   `aria-describedby` vers l'ID du message d'erreur (annoncé par les lecteurs
   d'écran) ; à la SOUMISSION invalide (`check`, appelé au save), le focus va sur
   le PREMIER champ en erreur. Les attributs sont retirés dès que l'erreur
   disparaît (`clear` / `clearOnInput`).
   ============================================================================ */
export class LiveValidation {
  constructor(
    private readonly collection: string,
    /** chemin de validation → contrôle DOM (input/select/wrapper situé dans une rangée `.form-field`). */
    private readonly fieldsByPath: Record<string, HTMLElement>,
    private readonly fetch?: EntityFetcher,
    private readonly find?: RecordFinder,   // pour les règles de PORTÉE (V6, ex. unicité d'adresse)
  ) {}

  /** Valide `record` : efface l'état précédent, surligne les champs fautifs + messages, relie l'ARIA,
      pose le focus sur le 1er champ en erreur, renvoie les erreurs. */
  check(record: Record<string, any>): ValidationError[] {
    this.clear();
    const errors = DataValidator.validateRecord(this.collection, record, this.fetch, this.find);
    let firstControl: HTMLElement | null = null;
    for (const error of errors) {
      const row = this.rowOf(error.path);
      if (!row) continue;   // chemin non relié à un champ → non surligné ici (l'autorité le signalera)
      row.classList.add("invalid");
      let message = row.querySelector(".field-error") as HTMLElement | null;
      if (!message) {
        message = document.createElement("div");
        message.className = "field-error";
        message.id = OverlayA11y.nextId("field-error");   // ID stable pour aria-describedby
        message.textContent = error.message;
        row.appendChild(message);
      }
      // Relie le CONTRÔLE focusable (pas forcément la valeur mappée : un wrapper de date enveloppe l'input).
      const control = this.controlOf(error.path);
      if (control) {
        control.setAttribute("aria-invalid", "true");
        if (message.id) control.setAttribute("aria-describedby", message.id);
        if (!firstControl) firstControl = control;
      }
    }
    // Soumission invalide → focus sur le PREMIER champ fautif (ergonomie + accessibilité).
    if (firstControl) { try { firstControl.focus(); } catch (_) { /* sans effet */ } }
    return errors;
  }

  /** Retire tout surlignage / message d'erreur / attribut ARIA d'invalidité. */
  clear(): void {
    for (const control of Object.values(this.fieldsByPath)) {
      const row = control.closest(".form-field");
      if (!row) continue;
      LiveValidation.clearRow(row as HTMLElement);
    }
  }

  /** UX : efface l'erreur d'un champ dès que l'utilisateur le corrige (saisie / changement). */
  clearOnInput(): void {
    for (const control of Object.values(this.fieldsByPath)) {
      const clearThis = () => {
        const row = control.closest(".form-field");
        if (row) LiveValidation.clearRow(row as HTMLElement);
      };
      control.addEventListener("input", clearThis);
      control.addEventListener("change", clearThis);
    }
  }

  /** Nettoie une rangée `.form-field` : classe `invalid`, messages `.field-error`, et attributs ARIA
      d'invalidité (`aria-invalid` / `aria-describedby`) posés par une passe précédente. */
  private static clearRow(row: HTMLElement): void {
    row.classList.remove("invalid");
    row.querySelectorAll(".field-error").forEach((node) => node.remove());
    row.querySelectorAll("[aria-invalid]").forEach((c) => { c.removeAttribute("aria-invalid"); c.removeAttribute("aria-describedby"); });
  }

  private rowOf(path: string): HTMLElement | null {
    const control = this.fieldsByPath[path];
    return control ? (control.closest(".form-field") as HTMLElement | null) : null;
  }

  /** Contrôle FOCUSABLE d'un chemin : l'élément mappé s'il est un champ, sinon le 1er input/select/
      textarea qu'il enveloppe (cas des composants composés : date, chips…), sinon l'élément lui-même. */
  private controlOf(path: string): HTMLElement | null {
    const el = this.fieldsByPath[path];
    if (!el) return null;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return el;
    return el.querySelector<HTMLElement>("input, select, textarea") || el;
  }
}
