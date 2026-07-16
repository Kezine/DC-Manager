import { Notify } from "./Notify";
import { Icons } from "./Icons";
import { Dialog } from "./Dialog";
import { Fullscreen } from "./Fullscreen";

export interface ModalOptions {
  title?: string;
  subtitle?: string;
  body: HTMLElement;
  onSave?: () => any | Promise<any>;
  onCancel?: () => void;
  hideFooter?: boolean;
  saveLabel?: string;
  confirmClose?: boolean;
  wide?: boolean;
}

/* =============================================================================
   MODALE UNIQUE d'édition. Construit sa propre DOM (classes du thème) et la
   réutilise. Détecte les modifications par INSTANTANÉ des champs (pas de faux
   positifs au focus). Remplace les fonctions libres openModal/closeModal/
   requestCloseModal/markModalDirty. Services app injectés/optionnels :
     - `editLocked` (mode viewer : bloque les modales d'édition) ;
     - confirmation de fermeture déléguée à Dialog.confirm.
   ============================================================================= */
export class Modal {
  /** Mode visualiseur : bloque les modales d'ÉDITION (laisse passer les fiches hideFooter). */
  editLocked = false;

  private overlay!: HTMLElement;
  private elTitle!: HTMLElement;
  private elSubtitle!: HTMLElement;
  private elBody!: HTMLElement;
  private elFooter!: HTMLElement;
  private elBox!: HTMLElement;
  private btnSave!: HTMLButtonElement;
  private cancelCb: (() => void) | null = null;
  private confirmClose = false;
  private dirty = false;
  private snapshot = "";

  constructor() { this._build(); }

  private _build(): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <div class="modal-header-left"><div class="modal-titles">
            <div class="modal-title"></div><div class="modal-subtitle"></div>
          </div></div>
          <button type="button" class="modal-close" aria-label="Fermer">${Icons.CLOSE}</button>
        </div>
        <div class="modal-body"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost modal-cancel">Annuler</button>
          <button type="button" class="btn btn-primary modal-save">Enregistrer</button>
        </div>
      </div>`;
    Fullscreen.host().appendChild(overlay);   // plein écran : dans l'élément FS courant (sinon <body>)
    this.overlay = overlay;
    this.elBox = overlay.querySelector(".modal") as HTMLElement;
    this.elTitle = overlay.querySelector(".modal-title") as HTMLElement;
    this.elSubtitle = overlay.querySelector(".modal-subtitle") as HTMLElement;
    this.elBody = overlay.querySelector(".modal-body") as HTMLElement;
    this.elFooter = overlay.querySelector(".modal-footer") as HTMLElement;
    this.btnSave = overlay.querySelector(".modal-save") as HTMLButtonElement;
    (overlay.querySelector(".modal-close") as HTMLElement).onclick = () => this.requestClose();
    (overlay.querySelector(".modal-cancel") as HTMLElement).onclick = () => this.requestClose();
    let down = false;
    overlay.addEventListener("mousedown", (e) => { down = (e.button === 0 && e.target === overlay); });
    overlay.addEventListener("mouseup", (e) => { if (down && e.button === 0 && e.target === overlay) this.requestClose(); down = false; });
  }

  /** Signale une modification NON-SAISIE (ajout de port, glisser un marqueur…). */
  markDirty(): void { this.dirty = true; }

  private _snapshot(): string {
    const parts: string[] = [];
    this.elBody.querySelectorAll("input, select, textarea").forEach((el: any, i) => {
      if (el.hasAttribute("data-nosnap")) return;
      const v = (el.type === "checkbox" || el.type === "radio") ? (el.checked ? "1" : "0") : (el.value != null ? String(el.value) : "");
      parts.push(i + ":" + v);
    });
    return parts.join("");
  }
  private _differs(): boolean { return this._snapshot() !== this.snapshot; }

  open(opts: ModalOptions): void {
    const { title, subtitle, body, onSave, onCancel, hideFooter, saveLabel, confirmClose, wide } = opts;
    if (this.editLocked && !hideFooter) return;   // viewer : bloque l'édition
    this.elTitle.textContent = title || "—";
    this.elSubtitle.innerHTML = subtitle || "";
    this.elBody.innerHTML = "";
    this.elBody.appendChild(body);
    this.elFooter.style.display = hideFooter ? "none" : "flex";
    this.elBox.classList.toggle("wide", !!wide);
    this.btnSave.textContent = saveLabel || "Enregistrer";
    this.cancelCb = (typeof onCancel === "function") ? onCancel : null;
    this.confirmClose = (typeof confirmClose === "boolean") ? confirmClose : (typeof onSave === "function");
    this.dirty = false;
    this.snapshot = this._snapshot();
    this.btnSave.disabled = false;
    this.btnSave.onclick = async () => {
      if (this.btnSave.disabled) return;
      this.btnSave.disabled = true;
      try {
        if (onSave) { const ok = await onSave(); if (ok !== false) this.closeQuiet(); }
        else this.closeQuiet();
      } catch (e: any) { console.error(e); Notify.toast("Erreur : " + e.message, "err"); }
      finally { this.btnSave.disabled = false; }
    };
    this.overlay.classList.add("open");
  }

  close(): void {
    const cb = this.cancelCb;
    this.cancelCb = null; this.confirmClose = false; this.dirty = false;
    this.overlay.classList.remove("open");
    if (cb) { try { cb(); } catch (e) { console.warn(e); } }
  }
  closeQuiet(): void {
    this.cancelCb = null; this.confirmClose = false; this.dirty = false;
    this.overlay.classList.remove("open");
  }
  async requestClose(): Promise<void> {
    const changed = this.dirty || this._differs();
    if (!this.confirmClose || !changed) { this.close(); return; }
    const ok = await Dialog.confirm({
      title: "Fermer sans enregistrer ?",
      message: "Les modifications non enregistrées de ce formulaire seront perdues.",
      confirmLabel: "Fermer", cancelLabel: "Continuer l'édition", danger: true,
    });
    if (ok) this.close();
  }
}
