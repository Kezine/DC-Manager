/** Notifications éphémères (toasts) dans #toast-container. */
export class Notify {
  /** Affiche un toast `msg` ; `type` = "ok" (défaut) | "err" | … (classe CSS). */
  static toast(msg: string, type: string = "ok"): void {
    const cont = document.getElementById("toast-container");
    if (!cont) return;
    const el = document.createElement("div");
    el.className = "toast " + (type === "ok" ? "" : type);
    el.textContent = msg;
    cont.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s"; el.style.opacity = "0";
      setTimeout(() => el.remove(), 320);
    }, 2600);
  }
}
