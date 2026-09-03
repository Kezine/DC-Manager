import type { Store } from "../../store";
import type { ImageStore } from "../../data/ImageStore";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Depths } from "../../registries/Depths";
import { PortTypes } from "../../registries/PortTypes";
import { PortRoles } from "../../registries/PortRoles";
import { EquipFaces } from "../../registries/EquipFaces";
import { RackGeometry } from "../../geometry/RackGeometry";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { FacePanelBands } from "../../geometry/FacePanelBands";   // bandes boîtier/oreilles du panneau 19″ (partagé avec l'éditeur de façade)
import { RackScene } from "../../geometry/RackScene";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { RackItemKinds } from "../../domain/RackItemKinds";
import {
  RACK_FACES,
  SIDE_U_STEP,
  BREAKOUT_SPANS,
  EQUIP_FACE_IMG_FIELD,
  U_MM,
  RACK_MOUNT_WIDTH,
  RACK_EAR_MM
} from "../../domain/constants";
import { Schema } from "../../../src-shared/Schema";   // types MIME d'images acceptés — liste PARTAGÉE (le serveur applique la même)
import { TerminationSpareSource } from "../../core/TerminationSpareSource";   // candidats du sélecteur de PIÈCE du dialogue de terminaison (spares lazy — G7)
import { I18n } from "../../i18n/I18n";

/** Résultat du dialogue de breakout (`FormBase.configureBreakout`) : de quoi créer le trunk (mode `new`) ou
    retrouver le port éclaté (mode `split` — `name`/`trunkTypeId` sont alors ceux du port, renvoyés tels quels)
    et ses `count` lanes de type `laneTypeId`. Les noms des lanes se dérivent par `BreakoutRules.laneNames`. */
export interface BreakoutConfig {
  name: string;
  trunkTypeId: string;
  laneTypeId: string;
  count: number;
}

/** Mode du dialogue de breakout — cf. `FormBase.configureBreakout`. */
export type BreakoutDialogOptions =
  /** Trunk NEUF : nom et type du trunk saisis dans le dialogue. */
  | { mode: "new" }
  /** Port EXISTANT à éclater : nom et type AFFICHÉS, figés (clause C5 — le port garde son identité). */
  | { mode: "split"; trunk: { name: string; portTypeId: string | null } };

/** Options du dialogue de TERMINAISON (`FormBase.configureTermination`, docs/terminaisons.md). */
export interface TerminationDialogOptions {
  /** La CAGE : le port qui reçoit le transceiver (son type propre = la cage ; `equipmentId` = l'équipement
      d'accueil de la pièce liée). */
  port: { id: string; name: string; equipmentId: string | null; portTypeId: string | null };
  /** Terminaison DÉJÀ posée (mode « modifier »). `spareId` OMIS = le dialogue retrouve lui-même la pièce qui occupe
      la cage (celle dont `assigned_port_id` = ce port) ; `null` = aucune, déjà su de l'appelant (lien en attente). */
  current?: { typeId: string; label: string; spareId?: string | null } | null;
  /** Média SUGGÉRÉ — formulaire câble : le type EFFECTIF de l'autre bout (« prend automatiquement les bonnes specs »). */
  suggestedTypeId?: string | null;
}
/** Résultat du dialogue de terminaison : le média présenté, le libellé, la pièce liée (`null` = transceiver
    GÉNÉRIQUE, aucune pièce) et la pièce qui occupait la cage à l'OUVERTURE — à DÉTACHER par l'appelant si elle change. */
export interface TerminationConfig {
  typeId: string;
  label: string;
  spareId: string | null;
  previousSpareId: string | null;
}

export class FormBase {
  /** Bibliothèque d'images de façade (injectée au boot) — singleton applicatif (hors modèle). */
  static images: ImageStore | null = null;

  /** Catégorie de bibliothèque d'une face : annexe (top/bottom/left/right) → « autre » ; sinon front/rear. */
  protected static faceAnnex(face: string): boolean { return face !== "front" && face !== "rear"; }
  /** Images éligibles pour une face. En mode LIBRE (`free`), AUCUN filtre : toute la bibliothèque (toute face, tout U).
      Sinon : annexe → « autre » ; front/rear → même face + même U (contrainte de baie 19″). */
  protected static eligibleImages(u: number, face: string, free = false): any[] {
    const im = this.images; if (!im) return [];
    if (free) return im.list();
    if (this.faceAnnex(face)) return im.list().filter((fi: any) => fi.face === "autre");
    const f = (face === "rear") ? "rear" : "front";
    return im.list().filter((fi: any) => fi.face === f && fi.u_height === (u || 1));
  }

  /** Ratio l/h RÉEL d'une image de façade (préréglage du redressement de perspective) : panneau 19″ complet
      (avec oreilles) ou corps seul, hauteur U × 44,45 mm. Face « autre » → null (aucun format imposé). */
  protected static faceImageRatio(face: string, u: number, withEars: boolean): number | null {
    if (face !== "front" && face !== "rear") return null;
    const w = (face === "front" && withEars) ? RACK_MOUNT_WIDTH : (RACK_MOUNT_WIDTH - 2 * RACK_EAR_MM);
    return w / (Math.max(1, u || 1) * U_MM);
  }
  /** Libellé du préréglage façade (bouton de l'éditeur de perspective). */
  protected static faceImageRatioLabel(face: string, u: number, withEars: boolean): string {
    const uu = Math.max(1, u || 1);
    if (face !== "front") return I18n.t("forms.faceRatio.rear", { u: uu });
    return I18n.t(withEars ? "forms.faceRatio.frontEars" : "forms.faceRatio.frontNoEars", { u: uu });
  }
  /** Dialogue de configuration d'un BREAKOUT (docs/breakout.md § Formulaire). Deux MODES, un seul dialogue :
        • `new`   (bouton « + Breakout ») : trunk NEUF — on saisit son nom et son type, le type des lanes, leur nombre ;
        • `split` (menu ⋮ d'une ligne de port, retour terrain T2-B2) : le trunk est un port EXISTANT — son nom et son
          type sont AFFICHÉS, pas saisis (clause C5 : le port garde son identité), on ne choisit que le type des
          lanes et leur nombre. Le calcul du ratio trunk/lane (`BREAKOUT_SPANS`, `PortTypes.speedGbps`) est le même.
      Rend `null` si annulé ; en mode `split`, `name`/`trunkTypeId` sont ceux du port, renvoyés tels quels. */
  protected static configureBreakout(store: Store, opts: BreakoutDialogOptions = { mode: "new" }): Promise<BreakoutConfig | null> {
    const split = opts.mode === "split" ? opts.trunk : null;
    // Un breakout est une affaire de ports de DONNÉES (les lanes sont créées en rôle `data`) : les types d'ÉNERGIE
    // n'ont rien à y faire — proposés, ils donnaient des lanes « (hors rôle) » dans le formulaire.
    const types = FormBase.dataPortTypes(store);
    if (!types.length) { Notify.toast(I18n.t("forms.breakout.needPortTypes"), "err"); return Promise.resolve(null); }
    const connOf = (t: any) => (t.connector || t.family || "").toUpperCase();
    const guessTrunk = types.find((t: any) => connOf(t).startsWith("QSFP")) || types[0];
    const guessLane = types.find((t: any) => connOf(t) === "SFP+") || types.find((t: any) => connOf(t).startsWith("SFP")) || types[0];
    // Sélecteurs À RECHERCHE (principe n°14) : `entityPicker` prend la MÊME liste que `select`, mais n'a pas
    // d'<optgroup> (un popover de recherche n'en a pas) → la FAMILLE entre dans le LIBELLÉ, où elle devient
    // CHERCHABLE (cf. `portTypeOptionLabel`, partagé avec le dialogue de terminaison).
    // L'option de tête vide porte le libellé de l'état « rien de choisi » : c'est là que le contrôle le lit.
    const typeLabel = (t: any) => FormBase.portTypeOptionLabel(t);
    const typeOpts = [{ value: "", label: I18n.t("equipment.equip.typeQ") }].concat(types.map((t: any) => ({ value: t.id, label: typeLabel(t) })));
    const nameI = FormControls.text("QSFP1", I18n.t("forms.breakout.namePlaceholder"));
    const trunkSel = FormControls.entityPicker(typeOpts, guessTrunk ? guessTrunk.id : "");
    const laneSel = FormControls.entityPicker(typeOpts, guessLane ? guessLane.id : "");
    // Mode `split` : le trunk est FIGÉ — nom et type du port, montrés comme une pastille (aucun contrôle de saisie).
    const trunkName = () => (split ? split.name : nameI.value).trim();
    const trunkTypeId = () => (split ? (split.portTypeId || "") : trunkSel.value);
    const trunkInfo = document.createElement("div");
    if (split) {
      const splitType: any = split.portTypeId ? store.get("portTypes", split.portTypeId) : null;
      const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = split.name.trim() || I18n.t("equipment.common.portParen");
      const typePill = document.createElement("span"); typePill.className = "pill"; typePill.textContent = splitType ? typeLabel(splitType) : I18n.t("equipment.detail.typeUnknown");
      trunkInfo.append(chip, document.createTextNode(" "), typePill);
    }
    const spanWrap = document.createElement("div");
    let span: number | null = null;   // nb de lanes retenu (null = combinaison invalide)
    const speedOf = (id: string) => { const t: any = store.get("portTypes", id); return { g: t ? PortTypes.speedGbps(t.speed) : null, s: t ? (t.speed || "") : "" }; };
    const refreshSpan = () => {
      spanWrap.innerHTML = "";
      const tk = speedOf(trunkTypeId()), ln = speedOf(laneSel.value);
      if (tk.g && ln.g) {
        const ratio = tk.g / ln.g;
        const h = document.createElement("div"); h.className = "form-hint";
        if (Number.isInteger(ratio) && BREAKOUT_SPANS.includes(ratio)) {
          span = ratio;
          h.innerHTML = I18n.t("forms.breakout.lanes", { n: ratio, trunk: Html.escape(tk.s), lane: Html.escape(ln.s) });
        } else {
          span = null; h.style.color = "var(--err)";
          h.textContent = I18n.t("forms.breakout.nonStandard", { trunk: tk.s, lane: ln.s, ratio: (Number.isInteger(ratio) ? ratio : ratio.toFixed(2)), spans: "{" + BREAKOUT_SPANS.join(", ") + "}" });
        }
        spanWrap.appendChild(h);
      } else {   // débit non renseigné (fibre, USB…) → choix manuel
        const sel = FormControls.select(BREAKOUT_SPANS.map((n) => ({ value: String(n), label: I18n.t("forms.breakout.laneOpt", { n }) })), String(span && BREAKOUT_SPANS.includes(span) ? span : 4));
        span = parseInt(sel.value, 10);
        sel.onchange = () => { span = parseInt(sel.value, 10); };
        spanWrap.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.lanesField"), sel, I18n.t("forms.breakout.lanesManualHint")));
      }
    };
    // `entityPicker` émet un `change` (bubbles) à chaque pick/effacement — même contrat qu'un <select>.
    trunkSel.addEventListener("change", refreshSpan); laneSel.addEventListener("change", refreshSpan); refreshSpan();
    return Dialog.custom({
      title: I18n.t(split ? "forms.breakout.splitTitle" : "forms.breakout.title"),
      confirmLabel: I18n.t(split ? "forms.breakout.splitConfirm" : "forms.breakout.create"),
      build: (root) => {
        if (split) {
          root.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.splitPortField"), trunkInfo, I18n.t("forms.breakout.splitPortHint")));
        } else {
          root.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.nameField"), nameI, I18n.t("forms.breakout.nameHint")));
          root.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.trunkField"), trunkSel, I18n.t("forms.breakout.trunkHint")));
        }
        root.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.laneField"), laneSel, I18n.t("forms.breakout.laneHint")));
        root.appendChild(spanWrap);
        return {
          validate: () => {
            // Le nom du trunk est la RACINE du nom des lanes (`BreakoutRules.laneNames`) : requis dans les deux
            // modes. En mode `split` il ne se corrige pas ici mais sur la ligne du port — le message le dit.
            if (!trunkName()) return I18n.t(split ? "forms.breakout.errSplitName" : "forms.breakout.errName");
            if (!split && !trunkSel.value) return I18n.t("forms.breakout.errTrunk");
            if (!laneSel.value) return I18n.t("forms.breakout.errLane");
            if (!span) return I18n.t("forms.breakout.errCombo", { spans: "{" + BREAKOUT_SPANS.join(", ") + "}" });
            return true as const;
          },
          collect: (): BreakoutConfig => ({ name: trunkName(), trunkTypeId: trunkTypeId(), laneTypeId: laneSel.value, count: span as number }),
        };
      },
    });
  }

  /** Types de port de DONNÉES, triés famille puis nom — la liste des deux dialogues (breakout, terminaison) : un type
      d'énergie n'a rien à y faire (lanes « hors rôle » ; média présenté refusé par la règle partagée T-TERM1). */
  private static dataPortTypes(store: Store): any[] {
    return store.all("portTypes").filter((t: any) => t.kind !== "power").sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name));
  }
  /** Libellé d'un type de port dans un sélecteur À RECHERCHE : `entityPicker` n'a pas d'<optgroup>, la FAMILLE entre donc
      dans le libellé, où elle devient CHERCHABLE (taper « SFP » remonte toute la famille) ; le connecteur, s'il diffère
      de la famille, y reste — c'est lui qu'on lit pour distinguer une cage (SFP28) d'un média présenté (LC). */
  private static portTypeOptionLabel(t: any): string {
    return t.name + (t.connector && t.connector !== t.family ? " (" + t.connector + ")" : "") + " · " + (t.family || I18n.t("equipment.equip.noFamily"));
  }
  /** Date du jour en ISO court (YYYY-MM-DD) — le format des dates d'attribution des pièces (`assigned_date`). Écrite
      UNE fois : le formulaire d'équipement et le formulaire câble la posent tous deux en liant une pièce à une cage. */
  protected static todayIso(): string { return new Date().toISOString().slice(0, 10); }

  /** Dialogue de TERMINAISON (docs/terminaisons.md § Les gestes) : un transceiver dans la cage. Trois champs —
        • le MÉDIA PRÉSENTÉ au câble : un type de port de DONNÉES (Q5.10), sélecteur à recherche ; valeur initiale =
          la terminaison posée, sinon le média SUGGÉRÉ (formulaire câble : le type effectif de l'autre bout), sinon,
          pour une cage SFP/QSFP, un type fibre LC — monomode d'abord (« Fibre SM (LC) », le cas T5) ; sinon rien de
          présélectionné (brief §1.3) ;
        • le LIBELLÉ du module, libre (vide ⇒ « Générique ») ;
        • la PIÈCE inventoriée, FACULTATIVE — sélecteur ASYNC (`spares` est paresseuse, garde G7 : jamais
          `all("spares")`) dont l'entrée de tête « Transceiver générique (non inventorié) » est le choix PAR DÉFAUT —
          le DUMMY n'a AUCUNE existence en base. Une pièce logée dans une AUTRE cage est listée grisée, cage nommée.
          Si les `tx_*` de la pièce contredisent la cage ou le média, on AVERTIT sous le champ, jamais bloquant (§1.4).
      Rien n'est ÉCRIT ici : le résultat est appliqué par l'appelant — brouillon du formulaire d'équipement (lien de
      pièce appliqué au save, même lot), ou écriture IMMÉDIATE depuis le formulaire câble (Q5.4). `null` si annulé. */
  protected static configureTermination(store: Store, opts: TerminationDialogOptions): Promise<TerminationConfig | null> {
    const port = opts.port, current = opts.current || null;
    const types = FormBase.dataPortTypes(store);
    if (!types.length) { Notify.toast(I18n.t("forms.termination.needPortTypes"), "err"); return Promise.resolve(null); }
    const cage: any = port.portTypeId ? store.get("portTypes", port.portTypeId) : null;
    const connOf = (t: any) => String(t.connector || t.family || "").toUpperCase();
    // Défaut du média (§1.3) : une cage SFP/QSFP reçoit d'ordinaire un module optique LC — monomode d'abord (le cas T5
    // mot pour mot), à défaut n'importe quel LC ; une autre cage (RJ45, SAS…) n'a pas de défaut raisonnable.
    const cageIsSfp = !!cage && /^Q?SFP/.test(connOf(cage));
    const defaultLc = cageIsSfp ? (types.find((t: any) => connOf(t) === "LC" && /SM/i.test(String(t.family || ""))) || types.find((t: any) => connOf(t) === "LC")) : null;
    const initialTypeId = (current && current.typeId) || opts.suggestedTypeId || (defaultLc ? defaultLc.id : "");
    const typeOpts = [{ value: "", label: I18n.t("equipment.equip.typeQ") }].concat(types.map((t: any) => ({ value: t.id, label: FormBase.portTypeOptionLabel(t) })));
    const mediaSel = FormControls.entityPicker(typeOpts, initialTypeId);
    const labelI = FormControls.text(current ? current.label : "", I18n.t("forms.termination.labelPlaceholder"));
    // La CAGE, montrée comme une pastille (aucune saisie — même forme que le trunk figé du dialogue breakout) : la
    // distinction cage ⇄ média est tout le sens de ce dialogue, elle doit se lire d'un coup d'œil.
    const cageInfo = document.createElement("div");
    const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = (port.name || "").trim() || I18n.t("equipment.common.portParen");
    const cagePill = document.createElement("span"); cagePill.className = "pill"; cagePill.textContent = cage ? FormBase.portTypeOptionLabel(cage) : I18n.t("equipment.detail.typeUnknown");
    cageInfo.append(chip, document.createTextNode(" "), cagePill);
    // PIÈCE : source ASYNC dédiée — transceivers affectés à l'équipement + stock, par les jumeaux async du Store.
    const spareLabel = (record: any): string => (typeof record.displayName === "function" ? record.displayName() : (record.name || record.id));
    const source = new TerminationSpareSource({
      candidates: async () => {
        const [assigned, available] = await Promise.all([port.equipmentId ? store.sparesOfEquipmentAsync(port.equipmentId) : Promise.resolve([] as any[]), store.sparesAvailableAsync()]);
        return assigned.concat(available);
      },
      get: (id) => store.get("spares", id) || null,
      fetchOne: (id) => store.fetchOne("spares", id),
      portName: (portId) => { const p: any = store.get("ports", portId); return p ? (p.name || null) : null; },
    }, port.id, {
      generic: I18n.t("forms.termination.genericSpare"),
      spare: spareLabel,
      otherCage: (spare, cageName) => I18n.t("forms.termination.spareOtherCage", { spare, port: cageName }),
    });
    const knownSpare = !!current && current.spareId !== undefined;   // l'appelant SAIT quelle pièce est liée (lien en attente)
    const spareSel = FormControls.entityPickerAsync(source, knownSpare ? (current!.spareId || "") : "", { placeholder: I18n.t("forms.termination.genericSpare"), fallbackLabel: (id) => id });
    // Pièce qui occupe la cage à l'OUVERTURE — sue de l'appelant, ou retrouvée dans les candidats (async) ; dans ce
    // second cas elle devient la valeur du sélecteur, sauf si l'utilisateur a déjà choisi (sa décision prime).
    let previousSpareId: string | null = knownSpare ? (current!.spareId || null) : null;
    let userPicked = false;
    // AVERTISSEMENT doux (§1.4) : `tx_form` vs connecteur de la CAGE, `tx_media` vs connecteur du MÉDIA — insensible
    // à la casse, sur le premier mot (« LC (fibre) » vaut « LC ») ; contradiction ⇒ texte sous le champ, rien de bloquant.
    const warn = document.createElement("div"); warn.className = "form-hint warn"; warn.style.display = "none";
    const head = (s: unknown) => String(s || "").trim().toUpperCase().split(/[\s(]/)[0];
    const refreshWarn = () => {
      const spare: any = spareSel.value ? source.record(spareSel.value) : null;
      const media: any = mediaSel.value ? store.get("portTypes", mediaSel.value) : null;
      const issues: string[] = [];
      if (spare && cage && head(spare.tx_form) && head(spare.tx_form) !== head(cage.connector || cage.family)) issues.push(I18n.t("forms.termination.warnForm", { form: spare.tx_form, cage: cage.connector || cage.family }));
      if (spare && media && head(spare.tx_media) && head(spare.tx_media) !== head(media.connector || media.family)) issues.push(I18n.t("forms.termination.warnMedia", { media: spare.tx_media, connector: media.connector || media.family }));
      warn.style.display = issues.length ? "" : "none";
      warn.textContent = issues.length ? I18n.t("forms.termination.warnMismatch", { issues: issues.join(" ") }) : "";
    };
    if (!knownSpare) source.currentSpareId().then((id) => { previousSpareId = id; if (id && !userPicked && !spareSel.value) spareSel.value = id; refreshWarn(); });
    spareSel.addEventListener("change", () => { userPicked = true; refreshWarn(); });
    mediaSel.addEventListener("change", refreshWarn);
    refreshWarn();
    return Dialog.custom({
      title: I18n.t(current ? "forms.termination.editTitle" : "forms.termination.title"),
      confirmLabel: I18n.t(current ? "forms.termination.editConfirm" : "forms.termination.confirm"),
      build: (root) => {
        root.appendChild(FormControls.fieldRow(I18n.t("forms.termination.portField"), cageInfo, I18n.t("forms.termination.portHint")));
        root.appendChild(FormControls.fieldRow(I18n.t("forms.termination.mediaField"), mediaSel, I18n.t("forms.termination.mediaHint")));
        root.appendChild(FormControls.fieldRow(I18n.t("forms.termination.labelField"), labelI, I18n.t("forms.termination.labelHint")));
        const spareRow = FormControls.fieldRow(I18n.t("forms.termination.spareField"), spareSel, I18n.t("forms.termination.spareHint"));
        spareRow.appendChild(warn);
        root.appendChild(spareRow);
        return {
          validate: () => (mediaSel.value ? true as const : I18n.t("forms.termination.errMedia")),
          collect: (): TerminationConfig => ({ typeId: mediaSel.value, label: labelI.value.trim(), spareId: spareSel.value || null, previousSpareId }),
        };
      },
    });
  }

  /* ---- détail d'équipement (fiche riche : identité · façade · ports · agrégats · câbles + Modifier) ---- */
  protected static dt(label: string): HTMLElement { const e = document.createElement("div"); e.className = "dt"; e.textContent = label; return e; }
  protected static dd(html: string): HTMLElement { const e = document.createElement("div"); e.className = "dd"; e.innerHTML = html; return e; }
  /** Mode VISUALISEUR autonome (lecture seule) ? → on retire les entrées d'ÉDITION des fiches (façade, « Modifier »…). */
  protected static isViewer(): boolean { return typeof document !== "undefined" && document.body.classList.contains("viewer-mode"); }

  /** ÉTAT D'AUTORISATION du client, POSÉ par le bootstrap — même point d'accroche que `FormBase.images` :
      la chaîne des fiches est un ensemble de méthodes STATIQUES appelées par leur nom, sans constructeur où
      injecter quoi que ce soit. Le contrat est réduit à ce dont les fiches ont besoin (structurel, aucun
      import de `core/AccessState` ici) et la fonction relit l'état COURANT à chaque appel — un changement de
      droits à chaud est donc pris en compte à la prochaine ouverture de fiche.
      `null` = aucune restriction : c'est l'état des tests headless et de tout appelant qui n'a pas câblé
      l'autorisation. En mode FICHIER, le bootstrap câble malgré tout un état « tout permis » (injection
      nulle) — le comportement est le même, mais par une source unique plutôt que par un trou. */
  static access: {
    canCreateCollection(collection: string): boolean;
    canUpdateCollection(collection: string): boolean;
    canDeleteCollection(collection: string): boolean;
  } | null = null;

  /** Socle des trois prédicats ci-dessous : mode visualiseur ⇒ NON (règle historique, inchangée) ;
      collection non nommée ou autorisation non câblée ⇒ OUI (comportement historique). */
  private static allowedOn(collection: string | undefined, verb: (collection: string) => boolean): boolean {
    if (this.isViewer()) return false;
    if (!collection || !FormBase.access) return true;
    return verb(collection);
  }
  /** Le geste d'ÉDITION d'une fiche de `collection` est-il proposable ? (permission de MISE À JOUR) */
  protected static canEditCollection(collection?: string): boolean {
    return this.allowedOn(collection, (c) => FormBase.access!.canUpdateCollection(c));
  }
  /** Le geste de CRÉATION depuis une fiche (« + Ajouter un sous-équipement »…) est-il proposable ? */
  protected static canCreateInCollection(collection?: string): boolean {
    return this.allowedOn(collection, (c) => FormBase.access!.canCreateCollection(c));
  }
  /** Le geste de SUPPRESSION depuis une fiche (VM orpheline, sous-équipement…) est-il proposable ? */
  protected static canDeleteInCollection(collection?: string): boolean {
    return this.allowedOn(collection, (c) => FormBase.access!.canDeleteCollection(c));
  }

  /* ---- primitives de FICHE DÉTAIL, communes à toutes les fiches ----
     Elles vivaient `private` dans `DetailForms` ; elles sont ici parce que `SubEquipmentForms` en a besoin
     sans appartenir à cette chaîne d'héritage (même position que `FaceEditor` : étend `FormBase`, appelé par
     son nom). Les remonter était le seul moyen de ne pas les dupliquer (principe n°3) ; les points d'appel de
     `DetailForms` ne changent pas d'un caractère, ils les héritent. */
  /** Grille clé→valeur (valeurs = HTML déjà échappé par l'appelant). */
  protected static grid(pairs: Array<[string, string]>): HTMLElement {
    const g = document.createElement("div"); g.className = "detail-grid";
    pairs.forEach(([k, v]) => { g.appendChild(this.dt(k)); g.appendChild(this.dd(v)); });
    return g;
  }
  /** Intercalaire de section (avec compte optionnel). */
  protected static sect(root: HTMLElement, label: string): void {
    const d = document.createElement("div"); d.className = "section-divider"; d.textContent = label; root.appendChild(d);
  }
  /** Tableau compact (cellules = HTML). `empty` affiché à la place si aucune ligne. */
  protected static tbl(root: HTMLElement, headers: string[], rows: string[][], empty: string): HTMLElement | null {
    if (!rows.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = empty; root.appendChild(e); return null; }
    const tw = document.createElement("div"); tw.className = "table-wrap";
    const head = headers.map((h) => `<th>${Html.escape(h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    tw.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    root.appendChild(tw); return tw;
  }
  /** Actions du PIED d'une fiche : bouton « Modifier » (si un éditeur est fourni, hors mode visualiseur, et
      avec le droit de MISE À JOUR de `collection` quand elle est nommée).
      RETOURNE les boutons à passer à `openModal({ footerActions })` — plutôt que de les appendre au bas du
      corps DÉFILANT — pour qu'ils vivent dans le pied FIXE, toujours visible sur une fiche longue. Tableau
      VIDE en mode visualiseur ou sans le droit : le pied reste alors masqué, la fiche n'ayant aucune action.
      C'est LE point commun du geste « Modifier » des fiches — le gater ici le gate partout. */
  protected static footer(edit?: () => void, collection?: string): HTMLElement[] {
    if (edit && this.canEditCollection(collection)) { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-primary"; b.textContent = I18n.t("lists.chrome.rowEdit"); b.onclick = edit; return [b]; }
    return [];
  }
  /** Bits de localisation d'un équipement (hérités du rack / de la salle, ou saisis). */
  protected static equipLocationBits(store: Store, e: any): string[] {
    const bits = (loc: any, fl: any, rm: any) => [store.siteLabel(loc || ""), fl, rm].filter((x) => x && x !== "—");
    if ((e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id) { const rk: any = store.get("racks", e.rack_id); return rk ? bits(rk.location, rk.floor, rk.room) : []; }
    if (e.dim_mode === "free" && e.dc_id) { const dc: any = store.get("datacenters", e.dc_id); if (dc) return bits(dc.location, dc.floor, dc.room); }
    return bits(e.location, e.floor, e.room);
  }
  /** Aperçu d'une face : fond image (si attachée) + ports posés. null si rien.
      Deux rendus (fiche détail, lecture seule) :
      - CLASSIQUE (défaut) : étiquettes posées SUR les ports (peut se chevaucher si façade dense) ;
      - HAUTE DENSITÉ (`dense`) : pastilles seules + RANGÉE DE CHIPS sous la face (même présentation que la
        palette « ports à poser » de l'éditeur) ; survol CROISÉ pastille ↔ chip avec bulle déportée reliée.

      ⚠ DEUX BOÎTES, et c'est le cœur du rendu : le PANNEAU (19″ en mode U, la face réelle en libre) et,
      dedans, le BOÎTIER. Un équipement plus étroit que 19″ (`u_width_mm` + `u_align`) n'occupe qu'une BANDE
      du panneau, le reste étant ses oreilles de montage — et `face_x`/`face_y` d'un port sont des fractions
      du BOÎTIER, pas du panneau. Les confondre dessinait la coque en pleine largeur ET décalait tous les
      ports. Le découpage est celui de l'éditeur de façade, source unique `geometry/FacePanelBands`. */
  protected static facePreview(store: Store, eq: any, face: string, dense = false): HTMLElement | null {
    const imageId = eq[(EQUIP_FACE_IMG_FIELD as any)[face]];
    const image: any = (this.images && imageId) ? (this.images.get(imageId) || null) : null;
    const url: string | null = image ? (image.url || null) : null;
    const ports = store.portsOf(eq.id).filter((p: any) => p.face_x != null && p.face_y != null && EquipFaces.norm(p.face_side) === face);
    if (!url && !ports.length) return null;
    const isFree = eq.dim_mode === "free";
    // Aspect-ratio PAR FACE (libre) : dessus/dessous = l×p, gauche/droite = p×h, etc. — sinon toutes les faces
    // prenaient les proportions avant/arrière. En mode U : panneau 19″ × hauteur en U. Largeur bornée par MAXVH×ratio
    // pour PRÉSERVER le ratio (width:100% + max-height seul l'aplatissait).
    const wh = isFree ? FreeEquipGeometry.faceWH(eq, face) : { W: 19, H: 1.75 * Math.max(1, eq.u_height || 1) };
    const MAXVH = 60;
    const panel = document.createElement("div"); panel.className = "face-preview";
    panel.style.aspectRatio = wh.W + " / " + wh.H;
    panel.style.maxHeight = MAXVH + "vh";
    panel.style.maxWidth = "calc(" + MAXVH + "vh * " + (wh.W / wh.H).toFixed(4) + ")";
    panel.style.margin = "0 auto";
    // En LIBRE, la face n'a ni oreilles ni boîtier rétréci : le boîtier EST le panneau (bande pleine).
    const band = isFree ? { left: 0, width: 1 } : FacePanelBands.body(eq, face);
    const body = document.createElement("div");
    body.style.cssText = "position:absolute;top:0;height:100%;left:" + (band.left * 100) + "%;width:" + (band.width * 100) + "%;";
    // OREILLES : face AVANT d'un équipement racké uniquement (l'arrière n'en a jamais). Une image « avec
    // oreilles » couvre le panneau COMPLET ; une image « face seule » se confine au boîtier — parité avec
    // l'éditeur de façade, sans quoi l'image et les ports ne se superposeraient plus.
    const hasEars = !isFree && face === "front";
    const withEars = hasEars && (image ? image.with_ears !== false : true);
    if (url) {
      const im = document.createElement("img"); im.className = "face-bg"; im.src = url; im.alt = "";
      const imageBand = withEars ? { left: 0, width: 1 } : band;
      im.style.cssText = "top:0;height:100%;left:" + (imageBand.left * 100) + "%;width:" + (imageBand.width * 100) + "%;right:auto;bottom:auto;";
      panel.appendChild(im);
    }
    if (hasEars) FacePanelBands.ears(eq, face).forEach((ear) => { const e = document.createElement("div"); e.className = "face-ear"; e.style.cssText = "left:" + (ear.left * 100) + "%;width:" + (ear.width * 100) + "%;top:0;height:100%;bottom:auto;"; panel.appendChild(e); });
    panel.appendChild(body);
    const roleCls = (p: any) => PortRoles.markerRoleClass(p.role);   // "" (data) · role-mgmt/power/poe
    if (!dense) {
      ports.forEach((p: any) => { const mk = document.createElement("div"); mk.className = "face-marker" + roleCls(p); mk.style.left = (p.face_x * 100) + "%"; mk.style.top = (p.face_y * 100) + "%"; mk.textContent = p.name || "(port)"; body.appendChild(mk); });
      return panel;
    }
    return this.facePreviewDense(panel, body, ports, roleCls);
  }

  /** Rendu HAUTE DENSITÉ de l'aperçu (cf. facePreview) : pastilles + chips + survol croisé avec bulle déportée.
      La bulle reste DANS le cadre (overflow:hidden du PANNEAU) : repli sous/au-dessus du port + clamp horizontal.
      ⚠ Deux boîtes distinctes (cf. facePreview) : `panel` est le cadre visible et clippant, `body` le BOÎTIER
      dont les fractions `face_x`/`face_y` sont issues — pastilles, bulles et lignes vivent donc dans `body`. */
  private static facePreviewDense(panel: HTMLElement, body: HTMLElement, ports: any[], roleCls: (p: any) => string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(panel);
    // couche du survol (ligne SVG + bulle) — au-dessus des pastilles, transparente aux événements.
    const NS = "http://www.w3.org/2000/svg";
    const hoverLayer = document.createElement("div"); hoverLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:5;"; body.appendChild(hoverLayer);
    const dots = ports.map((p: any) => {
      const dot = document.createElement("div"); dot.className = "face-dot" + roleCls(p);
      dot.style.cursor = "default"; dot.title = p.name || "(port)";
      dot.style.left = (p.face_x * 100) + "%"; dot.style.top = (p.face_y * 100) + "%";
      body.appendChild(dot); return dot;
    });
    // chips sous la face — même présentation que la palette « ports à poser » de l'éditeur de façade.
    const chipsRow = document.createElement("div"); chipsRow.className = "face-palette"; chipsRow.style.marginTop = "6px";
    const chips = ports.map((p: any) => { const c = document.createElement("span"); c.className = "face-chip"; c.style.cursor = "default"; c.textContent = p.name || "(port)"; chipsRow.appendChild(c); return c; });
    if (ports.length) wrap.appendChild(chipsRow);

    const show = (i: number) => {
      const p = ports[i];
      dots.forEach((d, j) => d.classList.toggle("dim", j !== i));
      dots[i].classList.add("hi"); chips[i].classList.add("hi");
      // bulle déportée DANS le cadre : sous le port s'il est en haut, au-dessus sinon (déport ∝ hauteur, borné).
      const by = p.face_y < 0.5 ? Math.min(0.9, p.face_y + 0.35) : Math.max(0.1, p.face_y - 0.35);
      const bubble = document.createElement("div"); bubble.className = "face-leader-label" + roleCls(p);
      bubble.textContent = p.name || "(port)";
      bubble.style.left = (p.face_x * 100) + "%"; bubble.style.top = (by * 100) + "%";
      hoverLayer.appendChild(bubble);
      // clamp HORIZONTAL (le panneau clippe) : re-mesure puis borne le centre à [demi-largeur, 100%−demi-largeur].
      const sw = body.clientWidth || 1, bw = bubble.getBoundingClientRect().width;
      const half = (bw / sw) / 2 + 0.005;
      const bx = Math.max(half, Math.min(1 - half, p.face_x));
      bubble.style.left = (bx * 100) + "%";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "face-leader-lines"); svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", String(p.face_x * 100)); ln.setAttribute("y1", String(p.face_y * 100));
      ln.setAttribute("x2", String(bx * 100)); ln.setAttribute("y2", String(by * 100));
      ln.classList.add("hi"); svg.appendChild(ln);
      hoverLayer.insertBefore(svg, bubble);   // ligne sous la bulle
    };
    const clear = () => { hoverLayer.innerHTML = ""; dots.forEach((d) => d.classList.remove("dim", "hi")); chips.forEach((c) => c.classList.remove("hi")); };
    ports.forEach((_p: any, i: number) => {
      const on = () => { clear(); show(i); };
      dots[i].addEventListener("mouseenter", on); dots[i].addEventListener("mouseleave", clear);
      chips[i].addEventListener("mouseenter", on); chips[i].addEventListener("mouseleave", clear);
    });
    return wrap;
  }
  /** Éditeur de CAPOT (toit/sol) : grille SVG multi-sélection au glisser. Les cellules sont éditées dans un
      TAMPON fourni par l'appelant (`cells`) et ne sont PERSISTÉES qu'à l'enregistrement du formulaire de baie —
      l'ancienne sauvegarde immédiate doublait l'écriture (un save au changement de capot + un au bouton
      « Enregistrer ») et créait des pas d'undo/écritures REST parasites. Une cellule portant un pin (◆, waypoint
      posé) n'est pas retirable. */
  protected static capEditor(store: Store, rack: any, face: string, cells: { get: () => string[]; set: (v: string[]) => void }): { el: HTMLElement; refresh: () => void } {
    const NS = "http://www.w3.org/2000/svg";
    const wrap = document.createElement("div"); wrap.className = "cap-grid-wrap";
    const g = RackGeometry.capGrid(rack), nx = g.nx, ny = g.ny;
    const cellPx = Math.max(9, Math.min(26, Math.floor(340 / Math.max(nx, ny, 1))));
    const W = nx * cellPx, Hh = ny * cellPx;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(Hh)); svg.setAttribute("viewBox", "0 0 " + W + " " + Hh);
    svg.setAttribute("class", "cap-grid"); svg.style.cssText = "display:block;background:var(--bg-1,#15171c);border:1px solid var(--line-2,#333);border-radius:6px;touch-action:none;";
    wrap.appendChild(svg);
    const mk = (tag: string, attrs: Record<string, string | number>): SVGElement => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, String(attrs[k])); return n; };
    const cellsSet = () => new Set(cells.get());
    const occSet = () => { const s = new Set<string>(); store.all("waypoints").forEach((w: any) => { if (w.kind === "point" && w.rack_id === rack.id && w.cap_face === face) s.add((w.cap_cx | 0) + "," + (w.cap_cy | 0)); }); return s; };
    let prevRect: SVGElement | null = null;
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
    // AFFICHAGE : façade EN BAS de la grille (rangée cy=0 en bas). Le stockage garde sa convention (cx → +X,
    // cy → +Y = vers l'arrière) : seule la rangée d'ÉCRAN est retournée (rowY). Ce retournement rend la vue de
    // dessus NON-MIROIR : « à droite » dans l'éditeur = « à droite » en 3D face à la baie (avant, l'ancienne
    // façade-en-haut affichait une vue en miroir → G/D inversés).
    const rowY = (cy: number) => (ny - 1 - cy) * cellPx;
    const cellAt = (clientX: number, clientY: number) => { const rb = svg.getBoundingClientRect(); return { cx: clamp(Math.floor((clientX - rb.left) / cellPx), nx), cy: clamp(ny - 1 - Math.floor((clientY - rb.top) / cellPx), ny) }; };
    const applyRange = (cx0: number, cy0: number, cx1: number, cy1: number): void => {
      const set = cellsSet(), occ = occSet();
      const add = !set.has(cx0 + "," + cy0);   // mode déduit de la 1re cellule
      let skipped = 0;
      for (let cx = Math.min(cx0, cx1); cx <= Math.max(cx0, cx1); cx++)
        for (let cy = Math.min(cy0, cy1); cy <= Math.max(cy0, cy1); cy++) {
          const k = cx + "," + cy;
          if (add) set.add(k); else { if (occ.has(k)) { skipped++; continue; } set.delete(k); }
        }
      cells.set([...set]);   // TAMPON local — persisté au clic sur « Enregistrer » du formulaire de baie
      if (skipped) Notify.toast(I18n.t("forms.cap.kept", { count: skipped }), "err");
      draw();
    };
    // « Supprimer tout » : retire tous les trous de ce capot. Les cellules portant un PIN sont conservées (comme la
    // suppression au glisser) — un pin exige un trou sous lui.
    const clearAll = (): void => {
      const occ = occSet();
      if (!cellsSet().size) return;   // rien à retirer
      cells.set([...occ]);   // TAMPON local — persisté au clic sur « Enregistrer » du formulaire de baie
      if (occ.size) Notify.toast(I18n.t("forms.cap.kept", { count: occ.size }), "err");
      draw();
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return; e.preventDefault();
      const c0 = cellAt(e.clientX, e.clientY);
      prevRect = mk("rect", { class: "cap-cell-sel-preview", x: c0.cx * cellPx, y: rowY(c0.cy), width: cellPx, height: cellPx });
      svg.appendChild(prevRect);
      let c1 = c0;
      // y d'écran du rectangle = rangée AFFICHÉE la plus haute = cy MAX (l'axe écran est retourné, cf. rowY).
      const drawSel = (c: { cx: number; cy: number }) => { const x0 = Math.min(c0.cx, c.cx), cyMax = Math.max(c0.cy, c.cy); prevRect!.setAttribute("x", String(x0 * cellPx)); prevRect!.setAttribute("y", String(rowY(cyMax))); prevRect!.setAttribute("width", String((Math.abs(c.cx - c0.cx) + 1) * cellPx)); prevRect!.setAttribute("height", String((Math.abs(c.cy - c0.cy) + 1) * cellPx)); };
      const move = (ev: MouseEvent) => { c1 = cellAt(ev.clientX, ev.clientY); drawSel(c1); };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); if (prevRect) { prevRect.remove(); prevRect = null; } applyRange(c0.cx, c0.cy, c1.cx, c1.cy); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
    function draw(): void {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const auth = cellsSet(), occ = occSet();
      auth.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; svg.appendChild(mk("rect", { x: cx * cellPx, y: rowY(cy), width: cellPx, height: cellPx, class: "cap-cell-auth" })); });
      occ.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; const mx = (cx + 0.5) * cellPx, my = rowY(cy) + 0.5 * cellPx, rr = cellPx * 0.3; svg.appendChild(mk("polygon", { points: `${mx},${my - rr} ${mx + rr},${my} ${mx},${my + rr} ${mx - rr},${my}`, class: "cap-cell-pin" })); });
      for (let i = 0; i <= nx; i++) svg.appendChild(mk("line", { x1: i * cellPx, y1: 0, x2: i * cellPx, y2: Hh, class: "cap-grid-line" }));
      for (let j = 0; j <= ny; j++) svg.appendChild(mk("line", { x1: 0, y1: j * cellPx, x2: W, y2: j * cellPx, class: "cap-grid-line" }));
      svg.appendChild(mk("line", { x1: 0, y1: Hh - 1, x2: W, y2: Hh - 1, class: "cap-grid-front" }));   // bord INFÉRIEUR = face AVANT (cf. rowY)
      const ov = mk("rect", { x: 0, y: 0, width: W, height: Hh, class: "cap-grid-ov" });
      ov.addEventListener("mousedown", onDown as EventListener);
      svg.appendChild(ov);
    }
    draw();
    const bar = document.createElement("div"); bar.style.cssText = "display:flex;justify-content:center;margin-top:6px";
    const clearBtn = document.createElement("button"); clearBtn.type = "button"; clearBtn.className = "btn btn-ghost btn-sm";
    clearBtn.textContent = I18n.t("forms.cap.clearAll"); clearBtn.title = I18n.t("forms.cap.clearAllTitle");
    clearBtn.onclick = () => { clearAll(); };
    bar.appendChild(clearBtn); wrap.appendChild(bar);
    return { el: wrap, refresh: draw };
  }

  /** Demande un fichier image à l'utilisateur (input file, JPEG/PNG/WebP). */
  protected static promptImageFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = Schema.IMAGE_MIME_TYPES.join(","); inp.style.display = "none";
      inp.onchange = () => { const f = inp.files && inp.files[0] ? inp.files[0] : null; inp.remove(); resolve(f); };
      document.body.appendChild(inp); inp.click();
    });
  }
  /** Variante MULTI-fichiers (un SEUL dialogue). NE PAS enchaîner deux promptImageFile : le premier
      consomme l'activation utilisateur (le clic) et le navigateur BLOQUE silencieusement le second
      `input.click()` programmatique — la promesse ne se résout jamais (flux suspendu sans erreur). */
  protected static promptImageFiles(): Promise<File[]> {
    return new Promise((resolve) => {
      const inp = document.createElement("input"); inp.type = "file"; inp.multiple = true; inp.accept = Schema.IMAGE_MIME_TYPES.join(","); inp.style.display = "none";
      inp.onchange = () => { const fs = inp.files ? Array.from(inp.files) : []; inp.remove(); resolve(fs); };
      document.body.appendChild(inp); inp.click();
    });
  }
  protected static validImageFile(f: File | null): File | null {
    if (!f) return null;
    if (!Schema.isImageMime(f.type)) { Notify.toast(I18n.t("forms.image.badFormat"), "err"); return null; }
    return f;
  }
  protected static sideGrid(store: Store, scene: RackScene, rack: any, opts: any): { el: HTMLElement; refresh: () => void } {
    const wrap = document.createElement("div"); wrap.className = "rack-grid-wrap side-grid-wrap";
    const refresh = () => {
      const face = opts.face, cols = RackGeometry.sideColumns(rack), colW = RackGeometry.sideColWidthMm(rack);
      const heightU = Math.max(1, opts.heightU || 1), uMax = rack.u_count || 42;
      const fitsW = (opts.width || 0) <= colW + 0.5, sel = opts.selected;
      const occ = scene.sideOccupants(rack.id, face, null);
      const columns: Array<{ lr: string; col: number }> = []; ["left", "right"].forEach((lr) => { for (let c = 0; c < cols; c++) columns.push({ lr, col: c }); });
      const colLabel = (lr: string, c: number) => (lr === "left" ? I18n.t("forms.side.left") : I18n.t("forms.side.right")) + (cols > 1 ? String(c + 1) : "");
      const blockAt = (lr: string, col: number, u: number) => occ.find((e: any) => e.id !== opts.exceptEqId
        && ((e.side_lr === "right" ? "right" : "left") === lr) && ((e.side_col === 1 && cols > 1) ? 1 : 0) === col
        && u >= Math.max(1, e.side_u | 0) && u < Math.max(1, e.side_u | 0) + RackGeometry.sideEquipHeightU(e));
      const tops: number[] = []; for (let u = 1; u + heightU - 1 <= uMax; u += SIDE_U_STEP) tops.push(u);
      let html = '<table class="rack-grid side-grid"><thead><tr><th class="ru">U</th>';
      columns.forEach((cc, i) => { html += `<th>${colLabel(cc.lr, cc.col)}</th>`; if (i === cols - 1) html += `<th class="side-mid">${I18n.t("forms.side.bay")}</th>`; });
      html += "</tr></thead><tbody>";
      for (let ri = tops.length - 1; ri >= 0; ri--) {
        const uTop = tops[ri];
        html += `<tr><td class="ru">${uTop}${heightU > 1 ? "–" + (uTop + heightU - 1) : ""}</td>`;
        columns.forEach((cc, i) => {
          const blk: any = blockAt(cc.lr, cc.col, uTop);
          const isSel = sel && sel.lr === cc.lr && sel.col === cc.col && uTop >= sel.u && uTop < sel.u + heightU;
          if (blk) {
            const hU = RackGeometry.sideEquipHeightU(blk), range = "U" + blk.side_u + (hU > 1 ? "–U" + (blk.side_u + hU - 1) : "");
            html += `<td class="rcell occ" title="${Html.escape((blk.name || I18n.t("forms.ph.equipment")) + " · " + range + " · " + (cc.lr === "left" ? I18n.t("forms.side.marginLeft") : I18n.t("forms.side.marginRight")))}" style="border-left:3px solid var(--accent);"><div class="rcell-in compact"><span class="rcell-name">${Html.escape(blk.name || "")}</span></div></td>`;
          } else {
            const free = fitsW && scene.sideSlotFree(rack.id, face, cc.lr, cc.col, uTop, heightU, opts.exceptEqId || null);
            const cls = "rcell free" + (isSel ? " chosen mount-face" : (free ? " placeable" : ""));
            const attrs = free ? `data-pick-lr="${cc.lr}" data-pick-col="${cc.col}" data-pick-u="${uTop}"` : "";
            html += `<td class="${cls}" ${attrs}>${isSel ? `<div class="rcell-in compact"><span class="rcell-name">${I18n.t("forms.side.here")}</span></div>` : ""}</td>`;
          }
          if (i === cols - 1) html += '<td class="side-mid"></td>';
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      if (!fitsW) html += `<div class="form-hint" style="color:var(--warn);">${I18n.t("forms.side.tooWide", { w: opts.width || 0, col: Math.round(colW) })}</div>`;
      wrap.innerHTML = html;
      if (opts.onPick) wrap.querySelectorAll("[data-pick-u]").forEach((c: any) => {
        c.onclick = () => opts.onPick(c.getAttribute("data-pick-lr"), parseInt(c.getAttribute("data-pick-col"), 10), parseInt(c.getAttribute("data-pick-u"), 10));
      });
    };
    refresh();
    return { el: wrap, refresh };
  }
  /** Grille de sélection d'un trou de CAPOT autorisé (réplique `capPickGrid`) : SVG, cellules autorisées
      cliquables (onPick), cellules portant un pin marquées (◆, non sélectionnables). */
  protected static capPickGrid(store: Store, rack: any, face: string, opts: any): { el: HTMLElement; refresh: () => void } {
    const NS = "http://www.w3.org/2000/svg";
    const wrap = document.createElement("div"); wrap.className = "cap-grid-wrap";
    const g = RackGeometry.capGrid(rack), nx = g.nx, ny = g.ny;
    const cellPx = Math.max(9, Math.min(26, Math.floor(340 / Math.max(nx, ny, 1))));
    const W = nx * cellPx, Hh = ny * cellPx;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(Hh)); svg.setAttribute("viewBox", "0 0 " + W + " " + Hh);
    svg.style.cssText = "display:block;background:var(--bg-1,#15171c);border:1px solid var(--line-2,#333);border-radius:6px;";
    wrap.appendChild(svg);
    const mk = (tag: string, attrs: Record<string, any>, on?: () => void): SVGElement => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, String(attrs[k])); if (on) n.addEventListener("click", on); return n as SVGElement; };
    let sel = opts.selected || null;
    const draw = () => {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const occ = new Set<string>(); store.all("waypoints").forEach((w: any) => { if (w.kind === "point" && w.rack_id === rack.id && w.cap_face === face && w.id !== opts.exceptId) occ.add((w.cap_cx | 0) + "," + (w.cap_cy | 0)); });
      RackGeometry.capCells(rack, face).forEach((k: string) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return;
        const occupied = occ.has(cx + "," + cy), isSel = sel && sel.cx === cx && sel.cy === cy;
        svg.appendChild(mk("rect", { x: cx * cellPx, y: cy * cellPx, width: cellPx, height: cellPx, class: "cap-cell-auth",
          style: "pointer-events:auto;cursor:" + (occupied ? "not-allowed" : "pointer") + ";" + (isSel ? "fill-opacity:0.6;" : "") },
          occupied ? undefined : () => { sel = { cx, cy }; if (opts.onPick) opts.onPick(cx, cy); draw(); }));
        if (occupied) { const mx = (cx + 0.5) * cellPx, my = (cy + 0.5) * cellPx, rr = cellPx * 0.3; svg.appendChild(mk("polygon", { points: `${mx},${my - rr} ${mx + rr},${my} ${mx},${my + rr} ${mx - rr},${my}`, class: "cap-cell-pin" })); }
      });
      for (let i = 0; i <= nx; i++) svg.appendChild(mk("line", { x1: i * cellPx, y1: 0, x2: i * cellPx, y2: Hh, class: "cap-grid-line" }));
      for (let j = 0; j <= ny; j++) svg.appendChild(mk("line", { x1: 0, y1: j * cellPx, x2: W, y2: j * cellPx, class: "cap-grid-line" }));
      svg.appendChild(mk("line", { x1: 0, y1: 1, x2: W, y2: 1, class: "cap-grid-front" }));
    };
    draw();
    return { el: wrap, refresh: draw };
  }

  /** ÉLÉVATION cliquable d'une baie (grille des U) — mode « gérer le contenu ». Sœur de `sideGrid`/`capPickGrid`
      (constructeurs de grille de baie réutilisables). Réplique modulaire de `rackGrid` (monolithe v170) restreinte
      au mode GÉRER : cellule libre → bouton « + » (`onSlotClick(u, face)`) ; occupant → cellule pleine + « × »
      (`onRemove(kind, id)`). L'occupation vient de `RackScene.occupants` (source unique, partagée avec la 3D).
      Le mode « placer » (aperçu d'un gabarit, choix de position) reste au formulaire d'équipement. */
  protected static rackFrontGrid(store: Store, rack: any, opts: { onSlotClick: (u: number, face: string) => void; onRemove: (kind: string, id: string) => void; onEquipInfo?: (id: string) => void }): { el: HTMLElement; refresh: () => void } {
    const scene = new RackScene(store);
    const faces = rack.sides === "dual" ? ["front", "rear"] : ["front"];
    const dual = rack.sides === "dual";
    const wrap = document.createElement("div"); wrap.className = "rack-grid-wrap";
    const faceBadge = (depth: string, side: string, f: string) => {
      if (!dual) return "";
      if (depth === "full") return f === side ? "▸ " + this.faceLabel(side) : this.faceLabel(f) + I18n.t("forms.rack.rearSuffix");
      return "▸ " + this.faceLabel(side);
    };
    const cellInner = (iconInner: string, name: string, sub: string, height: number, eqId?: string) => {
      const icon = iconInner ? `<span class="ricon"><svg viewBox="0 0 24 24">${iconInner}</svg></span>` : "";
      const showSub = height >= 3 && sub;
      // nom CLIQUABLE (équipement) → fiche via opts.onEquipInfo (délégation `data-eq-info`) ; sinon nom nu.
      const nameHtml = eqId
        ? `<span class="rcell-name" role="button" tabindex="0" data-eq-info="${Html.escape(eqId)}" title="${Html.escape(I18n.t("detail.viz.openEquip"))}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${Html.escape(name)}</span>`
        : `<span class="rcell-name">${Html.escape(name)}</span>`;
      return `<div class="rcell-in${height === 1 ? " compact" : ""}">${icon}${nameHtml}${showSub ? `<span class="rcell-sub">${Html.escape(sub)}</span>` : ""}</div>`;
    };
    const refresh = () => {
      const occ = scene.occupants(rack.id);
      let html = '<table class="rack-grid"><thead><tr><th class="ru">U</th>' + faces.map((f) => `<th>${Html.escape(this.faceLabel(f))}</th>`).join("") + "</tr></thead><tbody>";
      for (let u = rack.u_count; u >= 1; u--) {
        html += `<tr><td class="ru">${u}</td>`;
        faces.forEach((f) => {
          const info: any = occ.get(u + ":" + f);
          if (info) {
            if ((info.top + info.height - 1) === u) {   // ne rend qu'à la cellule de TÊTE (rowspan couvre le reste)
              const isEq = info.kind === "equipment";
              const col = info.color || (isEq ? "var(--accent)" : "var(--line-2)");
              const mount = !dual || f === info.side;
              const badge = faceBadge(info.depth, info.side, f);
              const iconInner = isEq ? EquipmentTypes.icon(info.type) : RackItemKinds.icon(info.kind);
              const sub = (isEq ? "" : RackItemKinds.label(info.kind) + " · ") + info.height + " U · " + this.mountDepthLabel(info) + (badge ? " · " + badge : "");
              const uRange = "U" + info.top + (info.height > 1 ? "–U" + (info.top + info.height - 1) : "");
              const title = Html.escape((info.label || "") + " · " + uRange + " · " + info.height + " U");
              html += `<td class="rcell occ${mount ? " mount-face" : " back-face"}" rowspan="${info.height}" title="${title}" style="border-left:3px solid ${col};"><button class="row-btn danger" data-rm-kind="${info.kind}" data-rm-id="${info.id}" title="${I18n.t("forms.rack.remove")}">×</button>${cellInner(iconInner, info.label, sub, info.height, isEq && opts.onEquipInfo ? info.id : undefined)}</td>`;
            }
            return;   // cellule couverte par un rowspan
          }
          html += `<td class="rcell free"><button class="btn btn-ghost btn-sm rcell-add" data-add-u="${u}" data-add-face="${f}" title="${I18n.t("forms.rack.mount")}">+</button></td>`;
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      wrap.innerHTML = html;
      wrap.querySelectorAll("[data-rm-id]").forEach((b) => { (b as HTMLElement).onclick = () => opts.onRemove((b as HTMLElement).dataset.rmKind!, (b as HTMLElement).dataset.rmId!); });
      wrap.querySelectorAll("[data-add-u]").forEach((b) => { (b as HTMLElement).onclick = () => opts.onSlotClick(parseInt((b as HTMLElement).dataset.addU!, 10), (b as HTMLElement).dataset.addFace!); });
      wrap.querySelectorAll("[data-eq-info]").forEach((b) => { const open = (ev: Event) => { ev.stopPropagation(); opts.onEquipInfo?.((b as HTMLElement).dataset.eqInfo!); }; (b as HTMLElement).onclick = open; (b as HTMLElement).onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } }; });
    };
    refresh();
    return { el: wrap, refresh };
  }

  /** Création / édition d'un plan d'étage (réplique `openFloorForm`). `opts.pick` = mode création (sélecteurs
      bâtiment+étage, étages existants exclus) ; `opts.onPicked(loc, fl)` = navigation après création. */

  protected static faceLabel(id: string): string { const f = RACK_FACES.find((x) => x.id === id); return f ? I18n.t(f.labelKey) : (id || "—"); }
  /** Libellé de profondeur d'un montage — DÉLÈGUE à `Depths.mountLabel` (principe n°3 : le corps
      dupliquait exactement le registre ; la méthode reste pour ses nombreux appelants). */
  protected static mountDepthLabel(e: any): string { return Depths.mountLabel(e); }
}
