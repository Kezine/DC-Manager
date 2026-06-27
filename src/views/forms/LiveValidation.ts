import { DataValidator } from "../../../shared/DataValidation";
import type { ValidationError, EntityFetcher } from "../../../shared/DataValidation";

/* ============================================================================
   VALIDATION LIVE D'UN FORMULAIRE — surlignage des champs en erreur + messages.

   Relie chaque champ d'un formulaire (par son CHEMIN de validation, ex. "name",
   "cidr", "address") à son contrôle DOM, puis s'appuie sur EXACTEMENT la même
   validation PARTAGÉE que le Store et le serveur (`DataValidator.validateRecord`).
   → cohérence totale : ce que le formulaire surligne est ce que l'autorité refuse.

   Le surlignage agit sur la rangée `.form-field` parente du contrôle (cf. FormControls)
   et y insère un message `.field-error`. Le `fetch` optionnel (ex. `store.get`) active
   l'intégrité référentielle (V2) et les règles cross-entité (V5, ex. IP ∈ CIDR).
   ============================================================================ */
export class LiveValidation {
  constructor(
    private readonly collection: string,
    /** chemin de validation → contrôle DOM (input/select/wrapper situé dans une rangée `.form-field`). */
    private readonly fieldsByPath: Record<string, HTMLElement>,
    private readonly fetch?: EntityFetcher,
  ) {}

  /** Valide `record` : efface l'état précédent, surligne les champs fautifs + messages, renvoie les erreurs. */
  check(record: Record<string, any>): ValidationError[] {
    this.clear();
    const errors = DataValidator.validateRecord(this.collection, record, this.fetch);
    for (const error of errors) {
      const row = this.rowOf(error.path);
      if (!row) continue;   // chemin non relié à un champ → non surligné ici (l'autorité le signalera)
      row.classList.add("invalid");
      if (!row.querySelector(".field-error")) {
        const message = document.createElement("div");
        message.className = "field-error";
        message.textContent = error.message;
        row.appendChild(message);
      }
    }
    return errors;
  }

  /** Retire tout surlignage / message d'erreur. */
  clear(): void {
    for (const control of Object.values(this.fieldsByPath)) {
      const row = control.closest(".form-field");
      if (!row) continue;
      row.classList.remove("invalid");
      row.querySelectorAll(".field-error").forEach((node) => node.remove());
    }
  }

  /** UX : efface l'erreur d'un champ dès que l'utilisateur le corrige (saisie / changement). */
  clearOnInput(): void {
    for (const control of Object.values(this.fieldsByPath)) {
      const clearThis = () => {
        const row = control.closest(".form-field");
        if (!row) return;
        row.classList.remove("invalid");
        row.querySelectorAll(".field-error").forEach((node) => node.remove());
      };
      control.addEventListener("input", clearThis);
      control.addEventListener("change", clearThis);
    }
  }

  private rowOf(path: string): HTMLElement | null {
    const control = this.fieldsByPath[path];
    return control ? (control.closest(".form-field") as HTMLElement | null) : null;
  }
}
