import type { Store } from "../../store";
import type { ModalOptions } from "../../ui/Modal";
import type { InterventionFicheHooks } from "../InterventionFicheHooks";
import type { CertFicheHooks } from "../CertFicheHooks";
import type { IssueTargetSource } from "../IssueTargetSource";
import type { IssueFicheHooks } from "../IssueFicheHooks";
import type { UserDirectory } from "../../core/UserDirectory";
import { FLOORS } from "../../domain/constants";
import { Ip } from "../../core/Ip";
import { FormControls } from "../../ui/FormControls";
import type { SelectOption } from "../../ui/FormControls";
import { I18n } from "../../i18n/I18n";

/* Helpers et types PARTAGÉS par les formulaires (extraits de l'ancien Forms.ts monolithique). */

/** Libellés de forme de waypoint (réplique WAYPOINT_KIND_LABELS du monolithe). */
export const WAYPOINT_KIND_LABELS: Record<string, string> = { point: "Pin (point de passage)", segment: "Chemin de câbles (rail)", brush: "Brosse de brassage (baie)" };

/** Options d'orientation au sol (0/90/180/270) — partagées par les formulaires baie / équipement libre. */
export const ORIENT_OPTS = [{ value: "0", label: "0°" }, { value: "90", label: "90°" }, { value: "180", label: "180°" }, { value: "270", label: "270°" }];

/** Briques d'UI et listes d'options PARTAGÉES par les formulaires — classe sémantique à méthodes statiques
    (principe n°2 : pas de fonctions libres exportées ; les DONNÉES ci-dessus restent de simples exports). */
export class FormUi {
  /** Options « site / bâtiment » (— aucun — en tête). */
  static locOptions(store: Store): Array<{ value: string; label: string }> {
    return [{ value: "", label: I18n.t("forms.opt.none") }].concat(store.sitesSorted().map((s: any) => ({ value: s.id, label: s.name || s.id })));
  }
  /** Options « étage » (une valeur courante hors liste est conservée, marquée). */
  static floorOptions(sel: string): Array<{ value: string; label: string }> {
    const s = String(sel == null ? "" : sel);
    const o = [{ value: "", label: I18n.t("forms.opt.floorNone") }].concat(FLOORS.map((f) => ({ value: f, label: I18n.t("lists.ph.floorLabel", { n: f }) })));
    if (s && !FLOORS.includes(s)) o.push({ value: s, label: I18n.t("forms.opt.outOfList", { value: s }) });
    return o;
  }
  /** Intercalaire de section. */
  static divider(txt: string): HTMLElement { const d = document.createElement("div"); d.className = "section-divider"; d.textContent = txt; return d; }
  /** Rangée de champs côte à côte. */
  static row2(...fields: HTMLElement[]): HTMLElement { const r = document.createElement("div"); r.className = "form-row"; fields.forEach((f) => r.appendChild(f)); return r; }
  /** Remplace les options d'un <select> existant (préserve l'élément + ses handlers). Délègue au primitif
      partagé `FormControls.fillSelect` → gère aussi les `group` (regroupement en `<optgroup>` par famille). */
  static setOptions(sel: HTMLSelectElement, opts: SelectOption[], value?: string): void {
    FormControls.fillSelect(sel, opts, value);
  }
  /** Options « réseau IP » triées par libellé. */
  static ipNetOptions(store: Store): Array<{ value: string; label: string }> {
    return store.all("ipNetworks").slice()
      .sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || ""))
      .map((n: any) => ({ value: n.id, label: Ip.short(n) }));
  }
  /** Options « équipement » triées par nom (`none` en tête). */
  static eqOptions(store: Store, none: string): Array<{ value: string; label: string }> {
    return [{ value: "", label: none }].concat(
      store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || I18n.t("forms.ph.equipment") })));
  }
  /** Options « VM » triées par nom (`none` en tête) — parité stricte avec `eqOptions` (tri identique). */
  static vmOptions(store: Store, none: string): Array<{ value: string; label: string }> {
    return [{ value: "", label: none }].concat(
      store.all("vms").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((v: any) => ({ value: v.id, label: v.name || I18n.t("lists.ph.vm") })));
  }
}

/** Services applicatifs des formulaires (câblés par le shell). */
export interface FormHost {
  openModal(opts: ModalOptions): void;
  setDirty?(v: boolean): void;
  /** Signale au NIVEAU DE MODALE courant qu'il porte une modification non enregistrée (relais de
      `Modal.markDirty`). À ne pas confondre avec `setDirty`, qui parle du DOCUMENT (état de
      sauvegarde de l'application) : celui-ci ne parle que de la garde « modifications non
      enregistrées » posée quand on ferme ou dépile la modale.

      POURQUOI CE CANAL EXISTE. `Modal` détecte la saisie en comparant un INSTANTANÉ des
      `input`/`select`/`textarea` du corps. Un éditeur qui n'a AUCUN champ — la chaîne de route,
      qui n'est que des boutons — est donc totalement invisible à cette détection : on pouvait
      remanier toute une route puis fermer la modale sans la moindre confirmation. L'ancien nuage
      de CASES À COCHER, lui, y était visible ; le drapeau manuel rétablit la garde que la refonte
      aurait sinon supprimée. `Modal.markDirty` existait mais n'avait aucun appelant. */
  markDirty?(): void;
  /** Ferme le NIVEAU courant de la pile de modales (revient donc au précédent s'il y en a un). Utile
      quand une action DEPUIS une fiche détruit l'entité affichée (ex. purge d'une VM orpheline dans
      `DetailForms.vmDetail`) : la fiche n'a plus rien à montrer. */
  closeModal?(): void;
  /** Redemande à la modale COURANTE de se reconstruire EN PLACE (elle rejoue l'`onResume` déclaré à
      son ouverture). À utiliser quand une action déclenchée DEPUIS une fiche la rend périmée sans
      pour autant dépiler quoi que ce soit : éditeur de façade (un `Dialog`, pas un niveau de pile),
      suppression d'une ligne de sous-équipement, rattachement d'une adresse IP…
      ⚠ NE PAS ré-appeler la fiche elle-même pour ça : depuis que `Modal` est une PILE, une
      ré-ouverture EMPILE un niveau de plus au lieu de remplacer le contenu affiché. */
  refreshModal?(): void;
  /** « Localiser » : ferme la modale, bascule en vue 3D et centre la caméra sur l'objet.
      `returnAction` (optionnel) = ce qu'exécute le bouton « Retour » de la vue 3D (ex. rouvrir la fiche). */
  locate?(kind: "equipment" | "rack" | "cable" | "port", id: string, returnAction?: () => void): void;
  /** Nb MAX de suggestions d'autocomplétion des formulaires (réglage global — cf. Prefs.autocompleteMaxResults). */
  autocompleteLimit?(): number;
  /** Intégration « fiches » de la feature interventions (AMOVIBLE) — null hors mode API : les fiches détail
      (équipement/VM/spare) n'affichent alors AUCUNE rangée « Interventions ». Injecté par `main.ts`. */
  interventionHooks?: InterventionFicheHooks | null;
  /** Intégration « fiches » du rapprochement CERTIFICAT ↔ équipement/VM (AMOVIBLE) — null hors mode API : les
      fiches détail (équipement/VM) n'affichent alors AUCUNE rangée « Certificats TLS ». Injecté par `main.ts`. */
  certHooks?: CertFicheHooks | null;
  /** Annuaire utilisateurs (résolution des auteurs d'audit — cf. `AuditLine`, docs/user-resolver.md). null en
      mode fichier → aucune ligne « Créé/Modifié par » dans les fiches. Injecté par `main.ts` (mode REST). */
  userDirectory?: UserDirectory | null;
  /** Cibles liables d'un TICKET (feature `issues` AMOVIBLE) — alimente l'éditeur de liens de la fiche
      et résout les libellés affichés. ⚠ Injecté dans les DEUX modes de données, contrairement aux
      hooks interventions/certs : `targets` est une donnée DU DOCUMENT, pas du tracker, et reste donc
      éditable sans serveur (décision D9 du cadrage). `main.ts` y passe le MÊME descripteur que la
      dimension « Cible » du listing (`ListTargets.issueTarget`) — une seule table de familles. */
  issueTargets?: IssueTargetSource | null;
  /** Intégration « fiches » de la feature TICKETS (AMOVIBLE) — rangée « Tickets » des fiches détail
      (équipement/VM/spare/sous-équipement). ⚠ Injecté dans les DEUX modes de données, contrairement
      aux hooks interventions/certs : `issues` est une collection DU DOCUMENT, donc le badge et le
      mini-listing se lisent SYNCHRONEMENT dans le Store et marchent en mode fichier. Seule l'action
      « Ouvrir un ticket » (`createFor`) est conditionnée au mode API. Injecté par `main.ts`. */
  issueHooks?: IssueFicheHooks | null;
}
