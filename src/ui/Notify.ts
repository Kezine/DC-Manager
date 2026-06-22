/** Notifications éphémères (toasts). Crée son conteneur au besoin. */
export class Notify {
  private static container(): HTMLElement {
    let cont = document.getElementById("toast-container");
    if (!cont) { cont = document.createElement("div"); cont.id = "toast-container"; document.body.appendChild(cont); }
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
}
