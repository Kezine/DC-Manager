import { Html } from "../core/Html";
import { Notify } from "./Notify";
import { Fullscreen } from "./Fullscreen";

/** API optionnelle renvoyée par un `build(root)` de dialogue personnalisé. */
export interface DialogBuildApi {
  validate?: () => true | string;
  collect?: () => any;
}
export interface DialogOptions {
  title?: string;
  message?: string;
  variant?: "info" | "success" | "warning" | "error" | "danger";
  build?: ((root: HTMLElement) => DialogBuildApi | void) | null;
  confirmLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
  danger?: boolean;
  cancelValue?: any;
  confirmValueFromBuild?: boolean;
  wide?: boolean;
}

const ICONS: Record<string, string> = { info: "ⓘ", success: "✓", warning: "⚠", error: "✕", danger: "⚠" };

/* =============================================================================
   Dialogues EMPILABLES (confirm / alert / custom / prompt). Chaque dialogue
   construit sa propre overlay et se résout par Promise. Remplace les fonctions
   libres `_openDialog`/`confirmDialog`/`alertDialog`/`customDialog`.
   ============================================================================= */
export class Dialog {
  private static stack: Array<{ overlay: HTMLElement }> = [];

  private static open(opts: DialogOptions): Promise<any> {
    return new Promise((resolve) => {
      const {
        title = "", message = "", variant = "info", build = null,
        confirmLabel = "Confirmer", cancelLabel = "Annuler",
        hideCancel = false, danger = false, cancelValue = false,
        confirmValueFromBuild = false, wide = false,
      } = opts || {};
      const prevFocus = document.activeElement as HTMLElement | null;
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";
      overlay.style.zIndex = String(300 + Dialog.stack.length * 10);
      const box = document.createElement("div");
      box.className = "dialog-box" + (wide ? " dialog-wide" : "");
      box.setAttribute("role", "dialog");
      const iconChar = ICONS[variant] || "";
      box.innerHTML = `
        <div class="dialog-header">
          ${iconChar ? `<span class="dialog-icon variant-${Html.escape(variant)}">${iconChar}</span>` : ""}
          <div class="dialog-title">${Html.escape(title)}</div>
        </div>
        <div class="dialog-body"></div>
        <div class="dialog-footer">
          ${hideCancel ? "" : `<button type="button" class="btn btn-ghost" data-dlg="cancel">${Html.escape(cancelLabel)}</button>`}
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-dlg="confirm">${Html.escape(confirmLabel)}</button>
        </div>`;
      const bodyEl = box.querySelector(".dialog-body") as HTMLElement;
      if (message) { const p = document.createElement("p"); p.className = "dialog-message"; p.textContent = message; bodyEl.appendChild(p); }
      let api: DialogBuildApi | null = null;
      if (typeof build === "function") {
        const root = document.createElement("div");
        bodyEl.appendChild(root);
        try { api = build(root) || null; } catch (e) { console.error(e); }
      }
      overlay.appendChild(box);
      Fullscreen.host().appendChild(overlay);   // plein écran : dans l'élément FS courant (sinon <body>)
      let settled = false;
      const entry = { overlay };
      const teardown = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        const i = Dialog.stack.indexOf(entry); if (i >= 0) Dialog.stack.splice(i, 1);
        if (prevFocus && document.contains(prevFocus)) { try { prevFocus.focus(); } catch (_) {} }
      };
      const doConfirm = () => {
        if (settled) return;
        let value: any = true;
        if (api) {
          if (typeof api.validate === "function") {
            const v = api.validate();
            if (v !== true) { if (typeof v === "string" && v) Notify.toast(v, "err"); return; }
          }
          if (confirmValueFromBuild) { try { value = api.collect ? api.collect() : true; } catch (e) { value = null; } }
        }
        settled = true; teardown(); resolve(value);
      };
      const doCancel = () => { if (settled) return; settled = true; teardown(); resolve(cancelValue); };
      (box.querySelector('[data-dlg="confirm"]') as HTMLElement).addEventListener("click", doConfirm);
      const cancelBtn = box.querySelector('[data-dlg="cancel"]');
      if (cancelBtn) cancelBtn.addEventListener("click", doCancel);
      let down = false;
      overlay.addEventListener("mousedown", (e) => { down = (e.button === 0 && e.target === overlay); });
      overlay.addEventListener("mouseup", (e) => { if (down && e.button === 0 && e.target === overlay) doCancel(); down = false; });
      function onKey(e: KeyboardEvent) {
        if (Dialog.stack[Dialog.stack.length - 1] !== entry) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideCancel ? doConfirm() : doCancel(); }
        else if (e.key === "Enter") {
          const t = e.target as HTMLElement;
          if (t && (t.tagName === "TEXTAREA" || t.tagName === "BUTTON")) return;
          e.preventDefault(); e.stopPropagation(); doConfirm();
        }
      }
      document.addEventListener("keydown", onKey, true);
      Dialog.stack.push(entry);
      setTimeout(() => {
        if (overlay.contains(document.activeElement) && document.activeElement !== document.body) return;
        (box.querySelector('[data-dlg="confirm"]') as HTMLElement).focus();
      }, 0);
    });
  }

  /** Confirmation oui/non → Promise<boolean>. */
  static confirm(o: Partial<DialogOptions> & { danger?: boolean } = {}): Promise<boolean> {
    return Dialog.open({ title: o.title || "Confirmation", message: o.message || "", variant: o.variant || (o.danger ? "danger" : "info"), confirmLabel: o.confirmLabel || "Confirmer", cancelLabel: o.cancelLabel || "Annuler", danger: !!o.danger, cancelValue: false });
  }

  /** Information (un seul bouton) → Promise. */
  static alert(o: Partial<DialogOptions> = {}): Promise<any> {
    return Dialog.open({ title: o.title || "Information", message: o.message || "", variant: o.variant || "info", confirmLabel: o.confirmLabel || "OK", hideCancel: true, cancelValue: true });
  }

  /** Dialogue personnalisé (corps construit par `build`) → Promise<valeur collectée|null>. */
  static custom(o: Partial<DialogOptions> = {}): Promise<any> {
    return Dialog.open({ title: o.title || "", message: o.message || "", variant: o.variant || (o.danger ? "danger" : "info"), build: o.build || null, confirmLabel: o.confirmLabel || "Confirmer", cancelLabel: o.cancelLabel || "Annuler", hideCancel: !!o.hideCancel, danger: !!o.danger, wide: !!o.wide, cancelValue: null, confirmValueFromBuild: true });
  }

  /** Saisie d'une ligne de texte → Promise<string|null>. */
  static prompt(title: string, initial: string = ""): Promise<string | null> {
    let input: HTMLInputElement;
    return Dialog.custom({
      title,
      build: (root) => {
        input = document.createElement("input");
        input.type = "text"; input.value = initial; input.style.width = "100%";
        root.appendChild(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
        return { collect: () => input.value.trim() || null };
      },
    });
  }
}
