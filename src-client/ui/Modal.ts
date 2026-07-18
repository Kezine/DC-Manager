import { Notify } from "./Notify";
import { Icons } from "./Icons";
import { Dialog } from "./Dialog";
import { Fullscreen } from "./Fullscreen";
import { I18n } from "../i18n/I18n";

export interface ModalOptions {
  title?: string;
  subtitle?: string;
  body: HTMLElement;
  onSave?: () => any | Promise<any>;
  onCancel?: () => void;
  /** Rappelé à TOUTE fermeture de la modale (annulation, croix, clic hors-modale, OU enregistrement réussi) —
      contrairement à `onCancel` (annulation seule). Signal GÉNÉRIQUE de « la modale a disparu », utile pour
      enchaîner un retour (ex. aller-retour vers une fiche liée : `Modal` est un overlay UNIQUE, sans
      empilement). Ré-armé à chaque `open` (l'omettre le remet à null) et invoqué une seule fois. */
  onClose?: () => void;
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
   RAPPELS de fermeture (options d'`open`) : `onCancel` = annulation SEULE ;
   `onClose` = fermeture GÉNÉRIQUE (toute cause, y compris enregistrement réussi).
   `onClose` sert les ALLERS-RETOURS entre modales (overlay UNIQUE, pas
   d'empilement) : rouvrir la modale d'origine à la disparition d'une modale
   ouverte par-dessus.
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
  /** Rappel de fermeture GÉNÉRIQUE (cf. ModalOptions.onClose) — invoqué quelle que soit la cause. */
  private closeCb: (() => void) | null = null;
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
          <button type="button" class="modal-close" aria-label="${I18n.t("ui.action.close")}">${Icons.CLOSE}</button>
        </div>
        <div class="modal-body"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost modal-cancel">${I18n.t("ui.action.cancel")}</button>
          <button type="button" class="btn btn-primary modal-save">${I18n.t("ui.action.save")}</button>
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
    const { title, subtitle, body, onSave, onCancel, onClose, hideFooter, saveLabel, confirmClose, wide } = opts;
    if (this.editLocked && !hideFooter) return;   // viewer : bloque l'édition
    this.elTitle.textContent = title || "—";
    this.elSubtitle.innerHTML = subtitle || "";
    this.elBody.innerHTML = "";
    this.elBody.appendChild(body);
    this.elFooter.style.display = hideFooter ? "none" : "flex";
    this.elBox.classList.toggle("wide", !!wide);
    this.btnSave.textContent = saveLabel || I18n.t("ui.action.save");
    this.cancelCb = (typeof onCancel === "function") ? onCancel : null;
    this.closeCb = (typeof onClose === "function") ? onClose : null;   // ré-armé à chaque open (omission → null)
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
      } catch (e: any) { console.error(e); Notify.toast(I18n.t("ui.modal.errorPrefix", { message: e.message }), "err"); }
      finally { this.btnSave.disabled = false; }
    };
    this.overlay.classList.add("open");
  }

  close(): void {
    // Capture PUIS neutralise les rappels avant de les invoquer : un onClose qui rouvre une modale
    // (aller-retour) ne doit pas se re-déclencher en boucle sur la nouvelle ouverture.
    const cancel = this.cancelCb; const closed = this.closeCb;
    this.cancelCb = null; this.closeCb = null; this.confirmClose = false; this.dirty = false;
    this.overlay.classList.remove("open");
    if (cancel) { try { cancel(); } catch (e) { console.warn(e); } }
    if (closed) { try { closed(); } catch (e) { console.warn(e); } }
  }
  closeQuiet(): void {
    const closed = this.closeCb;
    this.cancelCb = null; this.closeCb = null; this.confirmClose = false; this.dirty = false;
    this.overlay.classList.remove("open");
    if (closed) { try { closed(); } catch (e) { console.warn(e); } }   // fermeture après enregistrement = fermeture aussi
  }
  async requestClose(): Promise<void> {
    const changed = this.dirty || this._differs();
    if (!this.confirmClose || !changed) { this.close(); return; }
    const ok = await Dialog.confirm({
      title: I18n.t("ui.modal.confirmCloseTitle"),
      message: I18n.t("ui.modal.confirmCloseMessage"),
      confirmLabel: I18n.t("ui.modal.confirmCloseConfirm"), cancelLabel: I18n.t("ui.modal.confirmCloseCancel"), danger: true,
    });
    if (ok) this.close();
  }
}
