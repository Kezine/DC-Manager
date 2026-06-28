import { Log } from "../core/Log";

/* PWA (Progressive Web App) : enregistrement du service worker rendant l'app INSTALLABLE et chargeable hors-ligne.
   Le SW (/sw.js) et le manifeste (/manifest.webmanifest) sont des fichiers SÉPARÉS émis dans dist/ par webpack et
   servis par le backend (express.static). Ils n'ont de sens que servis par HTTP(S) :
     · l'export « viewer standalone » mono-fichier ouvert en file:// ne peut PAS exécuter de SW → on garde (protocole) ;
     · `__PWA_ENABLED__` (DefinePlugin) vaut false en build de DEV → pas de SW pendant le HMR (évite un cache parasite).
   On n'enregistre donc que dans un contexte sûr et en build de production. */
declare const __PWA_ENABLED__: boolean;

export class Pwa {
  /** Enregistre le service worker si l'environnement le permet. No-op silencieux sinon (file://, dev, navigateur sans SW). */
  static register(): void {
    if (typeof __PWA_ENABLED__ === "undefined" || !__PWA_ENABLED__) return;   // build de dev / flag absent
    if (!("serviceWorker" in navigator)) return;                              // navigateur sans support SW
    const proto = location.protocol;
    if (proto !== "https:" && proto !== "http:") return;                      // file:// (standalone) → pas de SW
    // enregistrement différé au `load` pour ne pas concurrencer le rendu initial.
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then(() => Log.d("pwa", "service worker enregistré"))
        .catch((err) => Log.d("pwa", "échec d'enregistrement du service worker", err));
    });
  }
}
