/* Le changeset est désormais du code PARTAGÉ front ⇄ back : la définition vit dans `shared/`
   (source de vérité unique). Ce fichier ne fait que ré-exporter pour préserver les imports
   existants (`from "../sync"`). Cf. shared/DocumentChangeset.ts, CLAUDE.md « Code partagé ». */
export type { DocumentChangeset } from "../../shared/DocumentChangeset";
export { Changeset } from "../../shared/DocumentChangeset";
