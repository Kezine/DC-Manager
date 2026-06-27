import { Fullscreen } from "./Fullscreen";

/** Notifications éphémères (toasts). Crée son conteneur au besoin. */
export class Notify {
  private static container(): HTMLElement {
    let cont = document.getElementById("toast-container");
    if (!cont) { cont = document.createElement("div"); cont.id = "toast-container"; document.body.appendChild(cont); }
    Fullscreen.home(cont);   // plein écran : suit l'élément FS courant (sinon <body>)
    return cont;
  }

  /** Affiche un toast `msg` ; `type` = "ok" (défaut) | "err" | … (classe CSS). */
  static toast(msg: string, type: string = "ok"): void {
    const cont = Notify.container();
    const el = document.createElement("div");
    el.className = "toast " + (type === "ok" ? "" : type);
    el.textContent = msg;
    cont.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s"; el.style.opacity = "0";
      setTimeout(() => el.remove(), 320);
    }, 2600);
  }

  /** Overlay « occupé » (spinner) recouvrant l'app pendant un traitement BLOQUANT (reload SSE + rebuild 3D
      ≈ 1 s) : capte les clics et signale que l'UI travaille au lieu de paraître figée. `busy()`/`idle()`
      s'équilibrent ; un second `busy()` ne fait que mettre à jour le message. */
  private static busyEl: HTMLElement | null = null;
  static busy(msg: string = "Chargement…"): void {
    if (Notify.busyEl) { const t = Notify.busyEl.querySelector(".busy-msg"); if (t) t.textContent = msg; return; }
    const ov = document.createElement("div");
    ov.className = "busy-overlay";
    ov.innerHTML = '<div class="busy-box"><div class="busy-spinner"></div><div class="busy-msg"></div></div>';
    (ov.querySelector(".busy-msg") as HTMLElement).textContent = msg;
    document.body.appendChild(ov);
    Fullscreen.home(ov);   // plein écran : suit l'élément FS courant (sinon <body>)
    Notify.busyEl = ov;
  }
  static idle(): void { if (Notify.busyEl) { Notify.busyEl.remove(); Notify.busyEl = null; } }
}
