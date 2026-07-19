import { Html } from "../core/Html";
import { Notify } from "./Notify";
import { Fullscreen } from "./Fullscreen";
import { OverlayA11y } from "./OverlayA11y";
import { I18n } from "../i18n/I18n";

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
  /** CHOIX EMPILÉS (cf. Dialog.choice) : remplace le bouton « Confirmer » par un bouton par choix
      dans le corps — cliquer résout avec `value`. Le pied ne garde que « Annuler » (→ cancelValue). */
  choices?: Array<{ label: string; value: any; hint?: string }>;
}

const ICONS: Record<string, string> = { info: "ⓘ", success: "✓", warning: "⚠", error: "✕", danger: "⚠" };

/* =============================================================================
   Dialogues EMPILABLES (confirm / alert / custom / prompt). Chaque dialogue
   construit sa propre overlay et se résout par Promise. Remplace les fonctions
   libres `_openDialog`/`confirmDialog`/`alertDialog`/`customDialog`.

   ACCESSIBILITÉ (socle partagé avec Modal, cf. ui/OverlayA11y) : boîte
   `role="dialog"` + `aria-modal="true"` + `aria-labelledby` (titre) +
   `aria-describedby` (message d'une confirmation) ; focus capturé/restitué ;
   Échap (déjà présent) + PIÈGE de focus (Tab boucle dans la boîte) ; verrou de
   défilement de la page (compteur ScrollLock, empilement dialogue-sur-modale).
   CONFIRMATION DANGER : le focus initial va sur « Annuler » (jamais sur l'action
   destructrice) — un Entrée réflexe annule au lieu de détruire.
   ============================================================================= */
export class Dialog {
  private static stack: Array<{ overlay: HTMLElement }> = [];

  /** Un dialogue est-il ouvert ? (Modal l'interroge pour SUSPENDRE Échap/Tab quand un dialogue,
      empilé plus haut, doit capter le clavier — cf. Modal._build.) */
  static isOpen(): boolean { return Dialog.stack.length > 0; }

  private static open(opts: DialogOptions): Promise<any> {
    return new Promise((resolve) => {
      const {
        title = "", message = "", variant = "info", build = null,
        confirmLabel = I18n.t("ui.action.confirm"), cancelLabel = I18n.t("ui.action.cancel"),
        hideCancel = false, danger = false, cancelValue = false,
        confirmValueFromBuild = false, wide = false, choices = null,
      } = opts || {};
      const prevFocus = document.activeElement as HTMLElement | null;
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";
      overlay.style.zIndex = String(300 + Dialog.stack.length * 10);
      const box = document.createElement("div");
      box.className = "dialog-box" + (wide ? " dialog-wide" : "");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      const iconChar = ICONS[variant] || "";
      // IDs stables reliant la boîte à son titre (aria-labelledby) et, pour une confirmation, à son
      // message (aria-describedby) — annoncés ensemble par les lecteurs d'écran à la prise de focus.
      const titleId = OverlayA11y.nextId("dcm-dialog-title");
      const msgId = OverlayA11y.nextId("dcm-dialog-msg");
      if (title) box.setAttribute("aria-labelledby", titleId);
      if (message) box.setAttribute("aria-describedby", msgId);
      box.innerHTML = `
        <div class="dialog-header">
          ${iconChar ? `<span class="dialog-icon variant-${Html.escape(variant)}">${iconChar}</span>` : ""}
          <div class="dialog-title" id="${titleId}">${Html.escape(title)}</div>
        </div>
        <div class="dialog-body"></div>
        <div class="dialog-footer">
          ${hideCancel ? "" : `<button type="button" class="btn btn-ghost" data-dlg="cancel">${Html.escape(cancelLabel)}</button>`}
          ${choices ? "" : `<button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-dlg="confirm">${Html.escape(confirmLabel)}</button>`}
        </div>`;
      const bodyEl = box.querySelector(".dialog-body") as HTMLElement;
      if (message) { const p = document.createElement("p"); p.className = "dialog-message"; p.id = msgId; p.textContent = message; bodyEl.appendChild(p); }
      let api: DialogBuildApi | null = null;
      if (typeof build === "function") {
        const root = document.createElement("div");
        bodyEl.appendChild(root);
        try { api = build(root) || null; } catch (e) { console.error(e); }
      }
      overlay.appendChild(box);
      Fullscreen.host().appendChild(overlay);   // plein écran : dans l'élément FS courant (sinon <body>)
      OverlayA11y.lockScroll();   // fige le défilement de la page tant que ce dialogue est ouvert (compteur)
      let settled = false;
      const entry = { overlay };
      const teardown = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        const i = Dialog.stack.indexOf(entry); if (i >= 0) Dialog.stack.splice(i, 1);
        OverlayA11y.unlockScroll();
        if (prevFocus && document.contains(prevFocus)) { try { prevFocus.focus(); } catch (_) {} }
      };
      const doConfirm = () => {
        if (settled || choices) return;   // mode « choix » : seuls les boutons de choix (ou Annuler) résolvent
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
      // CHOIX EMPILÉS : un gros bouton par option dans le corps ; cliquer = résoudre avec sa valeur.
      if (choices) {
        const list = document.createElement("div"); list.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:6px;";
        choices.forEach((c) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost";
          b.style.cssText = "text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:2px;";
          const l = document.createElement("span"); l.textContent = c.label; b.appendChild(l);
          if (c.hint) { const h = document.createElement("span"); h.style.cssText = "font-size:11px;color:var(--fg-dim);font-weight:400;"; h.textContent = c.hint; b.appendChild(h); }
          b.addEventListener("click", () => { if (settled) return; settled = true; teardown(); resolve(c.value); });
          list.appendChild(b);
        });
        bodyEl.appendChild(list);
      }
      const confirmBtn = box.querySelector('[data-dlg="confirm"]') as HTMLElement | null;
      if (confirmBtn) confirmBtn.addEventListener("click", doConfirm);
      const cancelBtn = box.querySelector('[data-dlg="cancel"]');
      if (cancelBtn) cancelBtn.addEventListener("click", doCancel);
      let down = false;
      overlay.addEventListener("mousedown", (e) => { down = (e.button === 0 && e.target === overlay); });
      overlay.addEventListener("mouseup", (e) => { if (down && e.button === 0 && e.target === overlay) doCancel(); down = false; });
      function onKey(e: KeyboardEvent) {
        if (Dialog.stack[Dialog.stack.length - 1] !== entry) return;   // seul le dialogue du SOMMET capte le clavier
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideCancel ? doConfirm() : doCancel(); }
        else if (e.key === "Enter") {
          const t = e.target as HTMLElement;
          if (t && (t.tagName === "TEXTAREA" || t.tagName === "BUTTON")) return;
          e.preventDefault(); e.stopPropagation(); doConfirm();
        }
        else if (e.key === "Tab") OverlayA11y.trapTab(box, e);   // piège de focus : boucle DANS la boîte
      }
      document.addEventListener("keydown", onKey, true);
      Dialog.stack.push(entry);
      setTimeout(() => {
        if (overlay.contains(document.activeElement) && document.activeElement !== document.body) return;   // un build() a déjà ciblé un champ
        // DANGER : focus initial sur « Annuler » (jamais l'action destructrice) — Entrée réflexe = annuler.
        // Sinon : action primaire (bouton « Confirmer »), ou 1er bouton du corps (mode « choix »).
        const primary = confirmBtn || (bodyEl.querySelector("button") as HTMLElement | null);
        const target = (danger && cancelBtn instanceof HTMLElement) ? cancelBtn : primary;
        if (target) target.focus();
      }, 0);
    });
  }

  /** Confirmation oui/non → Promise<boolean>. */
  static confirm(o: Partial<DialogOptions> & { danger?: boolean } = {}): Promise<boolean> {
    return Dialog.open({ title: o.title || I18n.t("ui.dialog.confirmTitle"), message: o.message || "", variant: o.variant || (o.danger ? "danger" : "info"), confirmLabel: o.confirmLabel || I18n.t("ui.action.confirm"), cancelLabel: o.cancelLabel || I18n.t("ui.action.cancel"), danger: !!o.danger, cancelValue: false });
  }

  /** Information (un seul bouton) → Promise. */
  static alert(o: Partial<DialogOptions> = {}): Promise<any> {
    return Dialog.open({ title: o.title || I18n.t("ui.dialog.alertTitle"), message: o.message || "", variant: o.variant || "info", confirmLabel: o.confirmLabel || I18n.t("ui.action.ok"), hideCancel: true, cancelValue: true });
  }

  /** CHOIX parmi N options empilées (label + hint) → Promise<valeur du choix | null (Annuler/Échap)>. */
  static choice(o: Partial<DialogOptions> & { choices: Array<{ label: string; value: any; hint?: string }> }): Promise<any> {
    return Dialog.open({ title: o.title || "", message: o.message || "", variant: o.variant || "info", choices: o.choices, cancelLabel: o.cancelLabel || I18n.t("ui.action.cancel"), cancelValue: null });
  }

  /** Dialogue personnalisé (corps construit par `build`) → Promise<valeur collectée|null>. */
  static custom(o: Partial<DialogOptions> = {}): Promise<any> {
    return Dialog.open({ title: o.title || "", message: o.message || "", variant: o.variant || (o.danger ? "danger" : "info"), build: o.build || null, confirmLabel: o.confirmLabel || I18n.t("ui.action.confirm"), cancelLabel: o.cancelLabel || I18n.t("ui.action.cancel"), hideCancel: !!o.hideCancel, danger: !!o.danger, wide: !!o.wide, cancelValue: null, confirmValueFromBuild: true });
  }

  /** Saisie d'une ligne de texte → Promise<string|null>. */
  static prompt(title: string, initial: string = ""): Promise<string | null> {
    let input: HTMLInputElement;
    return Dialog.custom({
      title,
      build: (root) => {
        // Enveloppé dans `.form-field` : l'input hérite du style STANDARD des champs du thème
        // (fond/bordure/mono/focus) — un input nu n'est stylé nulle part dans l'app.
        const field = document.createElement("div");
        field.className = "form-field";
        input = document.createElement("input");
        input.type = "text"; input.value = initial;
        field.appendChild(input);
        root.appendChild(field);
        setTimeout(() => { input.focus(); input.select(); }, 0);
        return { collect: () => input.value.trim() || null };
      },
    });
  }
}
