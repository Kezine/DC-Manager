/* =============================================================================
   VmHostTip — bloc « VMs HÉBERGÉES » de la bulle de survol d'un ÉQUIPEMENT
   (vue Datacenter). Classe PURE : aucun DOM, aucun store, aucun réseau.

   OÙ ÇA SERT : `DcInteract.equipmentTipHtml`, l'UNIQUE constructeur du contenu de
   la bulle d'équipement — la 2D (`wireOccupant`) et la 3D (`DcBase.webglTipHtml`,
   cible « occ »/« eq ») l'appellent toutes les deux. Il n'y a donc rien à
   mutualiser : enrichir ce builder enrichit les deux vues d'un coup.

   POURQUOI UN MODULE DÉDIÉ plutôt qu'un bloc de plus dans `DcInteract`
   (principes n°2/n°3) : `DcInteract` est un monolithe déclaré (cf. CLAUDE.md,
   « Points d'architecture »), et surtout ces règles — tri, bornage, échappement —
   sont testables EN ISOLATION alors qu'un bloc inline ne l'est pas.

   POURQUOI LE MODULE REND DU HTML et non des données : l'ÉCHAPPEMENT est le point
   critique. Le nom et le statut d'une VM sont des données SOURCE, remontées d'un
   cluster tiers (cf. docs/vm-proxmox.md), et la bulle est posée en `innerHTML`
   (`DcInteract.showTip`). Échapper ICI, une seule fois, rend la garantie TESTABLE ;
   la laisser à l'appelant la rendrait oubliable. Tout ce qui sort de `rows()` est
   donc du HTML SÛR, prêt à être enveloppé tel quel.

   BORNAGE : un hyperviseur peut porter des dizaines de VMs, et la bulle est
   RECONSTRUITE à chaque mouvement de souris sur l'objet. Au-delà de `MAX_LISTED`
   noms, la liste est tronquée et une dernière ligne porte le reste (« … et N
   autres ») — la bulle ne peut donc pas couvrir l'écran.

   VOCABULAIRE ET COULEURS : délégués à `core/VmStatus`, qui porte la règle pour ce
   module, le listing VMs et la fiche VM — statut affiché TEL QUEL et jamais traduit
   (tolérance aux releases Proxmox : un statut inconnu reste lisible), vert = en
   marche, gris = autre, rouge = orpheline (VM disparue du dernier inventaire),
   l'orphelinat primant sur le statut. Ce fichier ne garde que ce qui lui est
   PROPRE : le tri, le bornage et la mise en lignes.

   FEATURE VM AMOVIBLE : supprimer l'inventaire VM = supprimer ce fichier + l'appel
   dans `equipmentTipHtml` + `Store.vmsOfHost` (cf. docs/vm-proxmox.md, §Suppression).
   ============================================================================= */
import { Html } from "./Html";
import { I18n } from "../i18n/I18n";
import { VmStatus, VmStatusVm } from "./VmStatus";

/** Vue MINIMALE d'une VM pour la bulle — le module ne dépend NI du modèle `Vm`, NI du store.
    Forme TOLÉRANTE (champs optionnels) : les enregistrements arrivent d'une synchro tierce.
    Le STATUT et l'ORPHELINAT sont hérités de `VmStatusVm` : c'est `VmStatus` qui en porte la
    règle, ici comme au listing et à la fiche VM. */
export interface VmHostTipVm extends VmStatusVm {
  /** Nom d'affichage remonté par le provider. Vide/absent → placeholder « (VM) ». */
  name?: string | null;
}

export class VmHostTip {
  /** Nombre maximal de VMs NOMMÉES dans la bulle — SEUL endroit à retoucher pour ajuster la longueur.
      Pourquoi 8 : à 12 px / interligne 1,5, chaque ligne pèse ~18 px ; la bulle d'équipement en porte
      déjà 3 à 7 (type, série, U, baie, groupes, ports). 8 noms + la ligne de total + la ligne de reste
      plafonnent l'ajout à ~180 px, soit une bulle d'environ 300 px — encore largement contenue dans la
      scène, y compris sur un petit écran. Au-delà, la bulle deviendrait un listing, ce qu'elle n'est pas :
      le compte TOTAL est donné en tête, la liste complète vit dans l'onglet VMs. */
  static readonly MAX_LISTED = 8;

  /** Nom BRUT (trimé) d'une VM, "" si absent — sert au tri comme à l'affichage. */
  private static nameOf(vm: VmHostTipVm): string {
    return typeof vm.name === "string" ? vm.name.trim() : "";
  }

  /** Couleur de pastille d'une VM. DÉLÈGUE à `VmStatus` : les couleurs et la priorité de l'orphelinat
      sur le statut sont la MÊME règle qu'au listing et à la fiche, elle ne vit qu'à un endroit.
      Conservée ici comme point d'appel nommé (la bulle demande « la couleur de CETTE VM », pas une
      classification), et parce que c'est l'API que le rendu 2D/3D appelle. */
  static swatchColor(vm: VmHostTipVm): string {
    return VmStatus.swatchColor(vm);
  }

  /** Lignes de la bulle décrivant les VMs hébergées par un équipement — HTML SÛR (tout est échappé),
      à envelopper par l'appelant dans SA primitive de ligne (`DcInteract.tipRow`).

      - `vms` : les VMs de CET hôte, telles que rendues par `Store.vmsOfHost` (index `host_equipment_id`).
        Liste vide/absente → **`[]`** : aucune ligne, donc aucune section vide ni « 0 VM » dans la bulle.
      - `swatch` : fabrique de pastille INJECTÉE — l'appelant passe sa propre primitive (`tipSwatch`),
        pour que le module n'ait pas à redire le balisage d'un contrôle qui existe déjà (principe n°14).
      - `limit` : nombre de noms listés (défaut `MAX_LISTED`) ; une valeur < 1 est ramenée à 1, une bulle
        qui ne nommerait aucune VM n'ayant aucun intérêt.

      Ordre STABLE par nom (une bulle dont l'ordre saute d'un survol à l'autre est déroutante) ; à noms
      égaux, l'ordre d'entrée est conservé (tri stable). */
  static rows(vms: readonly VmHostTipVm[] | null | undefined, swatch: (color: string) => string, limit: number = VmHostTip.MAX_LISTED): string[] {
    const list = (Array.isArray(vms) ? vms : []).filter((vm): vm is VmHostTipVm => !!vm);
    if (!list.length) return [];
    const max = Math.max(1, Math.floor(limit));
    const sorted = list.slice().sort((a, b) => VmHostTip.nameOf(a).localeCompare(VmHostTip.nameOf(b)));
    const shown = sorted.slice(0, max), hidden = list.length - shown.length;

    // Ligne de TÊTE : le compte TOTAL (pas le nombre affiché) — même forme que la ligne « N ports »
    // qui la précède dans la bulle d'équipement.
    const rows: string[] = [Html.escape(I18n.t("dc.interact.vmCount", { count: list.length }))];
    for (const vm of shown) {
      const name = Html.escape(VmHostTip.nameOf(vm) || I18n.t("lists.ph.vm"));
      // Suffixe d'état : « orpheline » d'abord (elle prime), puis le statut brut du provider. Les deux
      // sont échappés — le statut est une donnée SOURCE, tolérée telle quelle donc jamais présumée sûre.
      const bits = [VmStatus.isOrphan(vm) ? I18n.t("lists.ph.orphan") : "", VmStatus.raw(vm)].filter((b) => b !== "");
      const suffix = bits.length ? ` <span style="color:var(--fg-dimmer)">· ${Html.escape(bits.join(" · "))}</span>` : "";
      rows.push(`${swatch(VmHostTip.swatchColor(vm))}${name}${suffix}`);
    }
    if (hidden > 0) rows.push(`<span style="color:var(--fg-dimmer)">${Html.escape(I18n.t("dc.interact.vmMore", { count: hidden }))}</span>`);
    return rows;
  }
}
