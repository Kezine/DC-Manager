/* Forms a été découpé en classes dédiées sous `views/forms/` :
   - `forms/shared.ts`     : helpers + `FormHost`
   - `forms/FormBase.ts`   : classe mère (singleton `images` + helpers privés partagés)
   - `forms/EquipmentForms.ts` · `CableForms.ts` · `RackForms.ts` · `IpamForms.ts` : implémentations filles
   - `forms/Forms.ts`      : classe finale `Forms` (agrège la chaîne d'héritage)
   Ce fichier reste un POINT D'ENTRÉE stable (ré-export) pour ne pas toucher les importeurs. */
export { Forms } from "./forms/Forms";
export type { FormHost } from "./forms/shared";
