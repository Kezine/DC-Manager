/* Imports d'assets non-JS (gérés par webpack via loaders). */
declare module "*.css";
/* Binaire .wasm inliné par webpack (`asset/inline`) : l'import vaut son data: URI.
   Filet de sécurité — zxing-wasm type déjà son propre sous-chemin .wasm (typesVersions),
   mais tout autre .wasm importé un jour doit rester typé « chaîne data: » à l'identique. */
declare module "*.wasm" { const uri: string; export default uri; }
