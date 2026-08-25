/* Imports d'assets non-JS (gérés par webpack via loaders). */
declare module "*.css";
/* Binaire .wasm inliné par webpack (`asset/inline`) : l'import vaut son data: URI.
   Filet de sécurité — zxing-wasm type déjà son propre sous-chemin .wasm (typesVersions),
   mais tout autre .wasm importé un jour doit rester typé « chaîne data: » à l'identique. */
declare module "*.wasm" { const uri: string; export default uri; }
/* Fonte .woff2 inlinée par webpack (`asset/inline`) : l'import vaut son data: URI.
   Sert à EMBARQUER la police dans le document d'impression des étiquettes — celui-ci
   est une iframe isolée, il ne voit ni la feuille de l'app ni ses `url(../fonts/…)`.
   Cf. docs/qr-scan.md § « Rendu d'impression ». */
declare module "*.woff2" { const uri: string; export default uri; }
