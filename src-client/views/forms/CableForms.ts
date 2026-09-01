import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { IconButton } from "../../ui/IconButton";
import { Icons } from "../../ui/Icons";
import { LiveValidation } from "./LiveValidation";
import { ColorPalette } from "../../ui/ColorPalette";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { CableStatuses } from "../../domain/CableStatuses";
import { Waypoint } from "../../models/Waypoint";
import { PortRoles } from "../../registries/PortRoles";
import { I18n } from "../../i18n/I18n";
import {
  POWER_SOURCES,
  CABLE_STATUS_DRAFT, CABLE_STATUS_DEFAULT_NEW
} from "../../domain/constants";
import { FormUi } from "./shared";
import { FormSave } from "./FormSave";   // écriture + garde-fou « ne jamais annoncer un succès refusé »
import type { FormHost } from "./shared";
import { PlacementContainers } from "../../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../../src-shared/PlacementContainers";
import { EquipmentForms } from "./EquipmentForms";
import { RouteChainEditor } from "./RouteChainEditor";   // la ROUTE comme chaîne ordonnée — MÊME composant câble ⇄ faisceau
import type { RouteChainCandidate, RouteChainStep } from "./RouteChainEditor";
import type { RouteCandidateType } from "../../core/RouteEligibility";

/** Contrainte de placement imposée à un bout de câble par la route : les conteneurs ACCEPTABLES
    (`null` = aucune contrainte), ou « seuls les équipements sans conteneur » quand la route est en
    chantier. Remplace le couple `{ dcIds, onlyUnplaced }` : un id de salle ne pouvait pas désigner un
    étage (doctrine §6.31). */
interface ContrainteConteneur { containers: PlacementContainer[] | null; onlyUnplaced: boolean }

export class CableForms extends EquipmentForms {

  /** Réseau logique (data/power). */
  static network(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("networks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", I18n.t("cable.net.labelPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("cable.net.label"), labelI));
    let color: string | null = net ? net.color : null;
    root.appendChild(FormControls.fieldRow(I18n.t("cable.net.color"), ColorPalette.build(color, (c) => { color = c; }), I18n.t("cable.net.colorHint")));
    const kindSel = FormControls.select([{ value: "data", label: I18n.t("cable.net.optData") }, { value: "power", label: I18n.t("cable.net.optPower") }], net ? (net.kind === "power" ? "power" : "data") : "data");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.net.type"), kindSel, I18n.t("cable.net.typeHint")));

    const voltI = FormControls.number((net && net.voltage != null) ? net.voltage : "", { min: 0, step: 1, placeholder: I18n.t("cable.net.voltPlaceholder") });
    const ampI = FormControls.number((net && net.max_amp != null) ? net.max_amp : "", { min: 0, step: 1, placeholder: I18n.t("cable.net.ampPlaceholder") });
    const srcSel = FormControls.select([{ value: "", label: I18n.t("cable.net.sourceNone") }].concat(POWER_SOURCES.map((s) => ({ value: s.id, label: I18n.t(s.labelKey) }))), net ? (net.power_source || "") : "");
    const powerBox = document.createElement("div");
    const rowP = document.createElement("div"); rowP.className = "form-row";
    rowP.appendChild(FormControls.fieldRow(I18n.t("cable.net.voltage"), voltI)); rowP.appendChild(FormControls.fieldRow(I18n.t("cable.net.ampMax"), ampI));
    powerBox.appendChild(rowP);
    powerBox.appendChild(FormControls.fieldRow(I18n.t("cable.net.supply"), srcSel, I18n.t("cable.net.supplyHint")));
    root.appendChild(powerBox);

    const ipOpts = [{ value: "", label: I18n.t("cable.net.ipNone") }].concat(
      store.all("ipNetworks").slice().sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || "")).map((n: any) => ({ value: n.id, label: n.label || n.cidr || I18n.t("cable.net.ipFallback") })));
    const ipSel = FormControls.select(ipOpts, net ? (net.ip_network_id || "") : "");
    const ipField = FormControls.fieldRow(I18n.t("cable.net.ipField"), ipSel, I18n.t("cable.net.ipHint"));
    root.appendChild(ipField);

    const syncKind = () => { const power = kindSel.value === "power"; powerBox.style.display = power ? "" : "none"; ipField.style.display = power ? "none" : ""; };
    kindSel.addEventListener("change", syncKind); syncKind();
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.common.description"), descI));
    const live = new LiveValidation("networks", { label: labelI, kind: kindSel, power_source: srcSel, ip_network_id: ipSel }, (c, i) => store.get(c, i) || null);
    live.clearOnInput();

    host.openModal({
      title: net ? I18n.t("cable.net.titleEdit") : I18n.t("cable.net.titleNew"),
      subtitle: net ? Html.escape(net.label) : "",
      body: root,
      onSave: async () => {
        const power = kindSel.value === "power";
        const payload = {
          label: labelI.value.trim(), color: color || null, kind: power ? "power" : "data",
          ip_network_id: power ? null : (ipSel.value || null),
          voltage: power && voltI.value !== "" ? Math.max(0, parseInt(voltI.value, 10) || 0) : null,
          max_amp: power && ampI.value !== "" ? Math.max(0, parseInt(ampI.value, 10) || 0) : null,
          power_source: power ? (srcSel.value || null) : null,
          description: descI.value.trim(),
        };
        if (live.check(payload).length) return false;   // label requis (surligné)
        if (!await FormSave.record(store, "networks", net && net.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
        host.setDirty?.(true); Notify.toast(net ? I18n.t("cable.net.updated") : I18n.t("cable.net.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }
  /* ---- ADAPTATEURS de l'éditeur de ROUTE (partagés par les formulaires CÂBLE et FAISCEAU) ----

     `RouteChainEditor` ne connaît ni le store ni le modèle : ces trois méthodes sont tout ce qui les
     relie. Elles vivent ici, à côté des deux seuls appelants, plutôt que dans le composant — l'y
     mettre y ferait entrer un import de `Store`, exactement ce que son interface hôte évite. */

  /** Libellé d'une ANCRE de câble : « équipement · port », l'équipement seul si le port n'est pas
      encore choisi, vide si rien ne l'est (l'éditeur affiche alors son propre repli). */
  private static portAnchorLabel(store: Store, portId: string, eqId: string): string {
    const port: any = portId ? store.get("ports", portId) : null;
    const eq: any = store.get("equipments", port ? port.equipment_id : (eqId || null));
    if (!eq) return "";
    const nom = eq.name || I18n.t("lists.ph.noName");
    return port ? (nom + " · " + (port.name || I18n.t("cable.cable.port"))) : nom;
  }

  /** Libellé d'une ANCRE de faisceau : le nom du patch d'extrémité (vide si non renseigné). */
  private static equipAnchorLabel(store: Store, equipmentId: string): string {
    const eq: any = equipmentId ? store.get("equipments", equipmentId) : null;
    return eq ? (eq.name || I18n.t("cable.bundle.equipment")) : "";
  }

  /** TOUS les waypoints du document, décrits pour l'éligibilité et pour l'affichage.

      ⚠ CONTENEUR, TYPE et POSE sont LUS SUR LA GRAMMAIRE, pas recalculés : une analyse portant sur ce
      SEUL waypoint rend exactement ce que l'automate dira de lui (`steps[0].container`/`.type`, et
      l'erreur `unplaced` s'il n'est pas posé). Les recopier ici — « pin d'étage ⇒ conteneur étage,
      sinon la salle de rattachement » — aurait dupliqué `CableRouteAnalyzer.waypointContainer`, avec
      la garantie de le voir diverger : c'est très exactement la dette que la doctrine (§6.7) décrit.
      Le coût est une analyse d'UNE étape par waypoint, payée à l'ouverture du popover.

      ⚠ Les waypoints NON POSÉS sont désormais LISTÉS (grisés, motif à l'appui) au lieu d'être
      masqués comme dans l'ancien nuage : « grisé ≠ caché » — on apprend la règle en lisant. */
  private static routeCandidates(store: Store): RouteChainCandidate[] {
    return store.all("waypoints").slice()
      .map((wp: any) => {
        const sonde = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [wp.id] });
        const step = sonde.steps[0];
        return {
          id: wp.id,
          container: step ? step.container : null,
          type: (step ? step.type : "datacenter") as RouteCandidateType,
          placed: !sonde.errors.some((e) => e.code === "unplaced"),
          glyph: Waypoint.glyph(wp),
          name: wp.name || I18n.t("cable.common.waypoint"),
        };
      })
      // Ordre d'ENTRÉE = conteneur puis nom. Le classement par PERTINENCE (et la remontée des exits)
      // est ensuite l'affaire de `RouteEligibility`, qui préserve cet ordre à pertinence égale.
      .sort((a, b) => (store.containerLabel(a.container) || "").localeCompare(store.containerLabel(b.container) || "") || a.name.localeCompare(b.name));
  }

  /** Habillage d'une ÉTAPE (glyphe + nom) ; null pour un id qui ne résout aucun waypoint. */
  private static describeWaypoint(store: Store, waypointId: string): RouteChainStep | null {
    const wp: any = store.get("waypoints", waypointId);
    return wp ? { glyph: Waypoint.glyph(wp), name: wp.name || I18n.t("cable.common.waypoint") } : null;
  }

  static cable(store: Store, host: FormHost, id: string | null, onSaved?: () => void, opts: any = {}): void {
    const cable: any = id ? store.get("cables", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(cable ? cable.name : "", I18n.t("cable.cable.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.nameField"), nameI));

    // ---- options d'équipement (contrainte famille + CONTENEUR) / de port (famille + occupation) ----
    // Le FILTRE compare aux conteneurs imposés par la route — salles ET étages depuis la généralisation de
    // la grammaire (doctrine §6.31) —, par comparaison STRUCTURELLE : un étage n'a pas d'id.
    const eqOpts = (fam: string | null, keepEqId: string | null, contrainte: ContrainteConteneur | null) => {
      let eqs = store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
      if (fam) eqs = eqs.filter((e: any) => e.id === keepEqId || store.portsOf(e.id).some((p: any) => !store.isBreakoutParent(p) && store.portFamily(p) === fam));
      const autorises = contrainte ? contrainte.containers : null;
      if (contrainte && (autorises || contrainte.onlyUnplaced)) {
        eqs = eqs.filter((e: any) => {
          if (e.id === keepEqId) return true;
          const c = store.equipmentNamedContainer(e);
          if (contrainte.onlyUnplaced) return !c;
          return !c || !autorises || autorises.some((a) => PlacementContainers.same(a, c));
        });
      }
      // Le SUFFIXE d'emplacement nomme le conteneur (salle, ou « Bât. X · ét. 1 » pour un posé d'étage —
      // décision D4, doctrine §6.29).
      return [{ value: "", label: I18n.t("cable.cable.pickEquip") }].concat(eqs.map((e: any) => { const emplacement = store.equipmentContainerLabel(e); return { value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + (emplacement ? " · " + emplacement : "") }; }));
    };
    const portOpts = (eqId: string, selectedPortId: string | null, fam: string | null) => {
      if (!eqId) return [{ value: "", label: I18n.t("cable.cable.pickEquipFirst") }];
      let ports = store.portsOf(eqId).filter((p: any) => !store.isBreakoutParent(p));
      if (fam) ports = ports.filter((p: any) => store.portFamily(p) === fam || p.id === selectedPortId);
      if (!ports.length) return [{ value: "", label: fam ? I18n.t("cable.cable.noCompatPort") : I18n.t("cable.cable.noPortOnEquip") }];
      ports = ports.slice().sort((a: any, b: any) => ((store.cableOnPort(a.id, cable ? cable.id : null) ? 1 : 0) - (store.cableOnPort(b.id, cable ? cable.id : null) ? 1 : 0)) || (a.name || "").localeCompare(b.name || ""));
      return [{ value: "", label: I18n.t("cable.cable.pickPort") }].concat(ports.map((p: any) => {
        const pt: any = store.get("portTypes", p.port_type_id);
        let label = (p.name || I18n.t("cable.cable.port")) + " · " + (pt ? pt.family : I18n.t("cable.cable.unknownType")) + " · " + PortRoles.label(p.role);
        if (p.parent_port_id) { const par: any = store.get("ports", p.parent_port_id); label += I18n.t("cable.cable.laneOf") + (par ? (par.name || I18n.t("cable.cable.trunk")) : I18n.t("cable.cable.trunk")); }
        const occ = store.cableOnPort(p.id, cable ? cable.id : null);
        if (occ) { const otherId = occ.from_port_id === p.id ? occ.to_port_id : occ.from_port_id; const other: any = store.get("ports", otherId); const otherEq: any = other ? store.get("equipments", other.equipment_id) : null; label += I18n.t("cable.cable.occupied") + (other ? ((otherEq ? otherEq.name : "?") + " : " + (other.name || I18n.t("cable.cable.port"))) : "?"); return { value: p.id, label, disabled: true }; }
        return { value: p.id, label };
      }));
    };

    // ---- état initial (édition / pré-remplissage depuis un port — routage 3D) ----
    let eqA = "", eqB = "", preA: string | null = null, preB: string | null = null;
    if (cable) {
      const pa: any = store.get("ports", cable.from_port_id), pb: any = store.get("ports", cable.to_port_id);
      if (pa) eqA = pa.equipment_id; if (pb) eqB = pb.equipment_id;
      // affectation d'un BROUILLON-candidat depuis un port libre → préremplit le bout vide dont la salle imposée accepte le port
      if (opts.assignPortId) {
        const pp: any = store.get("ports", opts.assignPortId);
        if (pp) {
          const missA = !cable.from_port_id, missB = !cable.to_port_id, cP = store.equipmentNamedContainer(pp.equipment_id);
          const fits = (side: "A" | "B") => { const k = store.cableSideConstraint(cable, side); return k.onlyUnplaced ? !cP : (!k.container || !cP || PlacementContainers.same(k.container, cP)); };
          let side: "A" | "B" | null = null;
          if (missA && missB) side = fits("A") ? "A" : (fits("B") ? "B" : "A");
          else if (missA) side = "A"; else if (missB) side = "B";
          if (side === "A") { eqA = pp.equipment_id; preA = opts.assignPortId; }
          else if (side === "B") { eqB = pp.equipment_id; preB = opts.assignPortId; }
        }
      }
    } else if (opts.fromPortId) { const pp: any = store.get("ports", opts.fromPortId); if (pp) { eqA = pp.equipment_id; preA = opts.fromPortId; } }
    else if (opts.fromEqId) { eqA = opts.fromEqId; }
    if (!cable && opts.toPortId) { const pq: any = store.get("ports", opts.toPortId); if (pq) { eqB = pq.equipment_id; preB = opts.toPortId; } }
    const initPortA = cable ? (cable.from_port_id || preA || "") : (preA || "");
    const initPortB = cable ? (cable.to_port_id || preB || "") : (preB || "");

    // ÉQUIPEMENT et PORT sont des ENTITÉS : leur sélection passe par le sélecteur À RECHERCHE
    // (principe n°14), et non par un `<select>` qui ne se filtre au clavier que par PRÉFIXE. Les
    // listes ci-dessus (`eqOpts`/`portOpts`) sont INCHANGÉES — le contrôle change, pas la règle.
    const selEqA = FormControls.entityPicker(eqOpts(null, eqA, null), eqA);
    const selPortA = FormControls.entityPicker(portOpts(eqA, initPortA || null, null), initPortA);
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.cable.equipA"), selEqA), FormControls.fieldRow(I18n.t("cable.cable.portA"), selPortA)));
    // INVERSION A ⇄ B : bouton-icône DISCRET, centré entre les deux rangées symétriques. Il permute équipements
    // ET ports du BROUILLON (aucune écriture store avant Enregistrer). Le clic est câblé plus bas (`swapEnds`),
    // une fois définies les fonctions de resynchronisation (refresh/syncRoute/syncStatus/renderNets) qu'il réutilise.
    const swapBtn = IconButton.build({ icon: Icons.SWAP, label: I18n.t("cable.cable.swapEnds") });
    const swapRow = document.createElement("div"); swapRow.style.cssText = "display:flex;justify-content:center;margin:-2px 0 2px;";
    swapRow.appendChild(swapBtn); root.appendChild(swapRow);
    const selEqB = FormControls.entityPicker(eqOpts(null, eqB, null), eqB);
    const selPortB = FormControls.entityPicker(portOpts(eqB, initPortB || null, null), initPortB);
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.cable.equipB"), selEqB), FormControls.fieldRow(I18n.t("cable.cable.portB"), selPortB)));

    const selType = FormControls.select([{ value: "", label: I18n.t("cable.common.pickCableType") }], cable ? (cable.cable_type_id || "") : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.typeField"), selType, I18n.t("cable.cable.typeHint")));

    const lenI = FormControls.number((cable && cable.length_m != null) ? cable.length_m : "", { min: 0, step: 0.1, placeholder: I18n.t("cable.cable.lenPlaceholder") });
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.lenField"), lenI, I18n.t("cable.cable.lenHint")));

    // ---- réseau : DÉDUIT des ports terminaux (le câble ne porte plus de réseau ; source UNIQUE = les ports) ----
    // Lecture seule : on affiche le(s) réseau(x) qui transitent par ce câble, calculés depuis ses 2 ports (et
    // propagés le long du chemin : patchs, brassages). Pour l'assigner : sur le port d'un équipement terminal.
    const netInfo = document.createElement("div"); netInfo.className = "form-hint";
    const renderNets = () => {
      const { ids, primary } = store.deducedNetwork([selPortA.value || null, selPortB.value || null]);
      if (!ids.length) { netInfo.textContent = I18n.t("cable.cable.netNone"); return; }
      const nameOf = (nid: string) => { const n: any = store.get("networks", nid); return n ? (n.label || I18n.t("cable.cable.netFallback")) : nid; };
      // P6 : la couleur suit le PRINCIPAL déterministe (deducedNetwork.primary), PAS « le 1er » de la liste. On nomme
      // le principal réel quand il y a ambiguïté (>1 réseau) — le hint « le 1er pilote la couleur » était périmé/faux.
      const suffix = (ids.length > 1 && primary) ? I18n.t("cable.cable.netPrimary", { name: nameOf(primary) }) : "";
      netInfo.textContent = I18n.t("cable.cable.netDeduced", { list: ids.map(nameOf).join(", "), suffix });
    };
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.netField"), netInfo, I18n.t("cable.cable.netFieldHint")));

    // ---- ROUTE : waypoints ORDONNÉS A→B, édités comme une CHAÎNE (views/forms/RouteChainEditor) ----
    // A REMPLACÉ les trois champs historiques — nuage de cases groupé par TYPE, hint de route texte,
    // liste « Ordre des points » — qui disaient la même chose deux fois (sélection d'un côté, ordre de
    // l'autre) alors qu'une route EST une séquence. Le BROUILLON, lui, ne bouge pas d'un octet :
    // `wpState.ids` reste le tableau que lit `onSave`, et le composant se contente de le remplacer.
    const wpState = { ids: cable ? (cable.waypoint_ids || []).slice() : ((opts.waypointIds || []).slice()) };
    // RELAIS DIFFÉRÉS : le composant est construit ICI (sa place dans le formulaire est ici) mais ses
    // collaborateurs — `refresh`, `syncStatus`, `endContainerOf` — ne sont déclarés que plus
    // bas. Aucun n'est appelé avant le premier `wpChain.render()`, joué en fin de construction avec le
    // reste des synchronisations. Le composant ne se peint donc PAS dans son constructeur (cf. son
    // en-tête) : c'est ce qui rend cet ordre tenable sans dupliquer du câblage.
    const wpChain = new RouteChainEditor({
      ids: () => wpState.ids,
      setIds: (next) => { wpState.ids = next; },
      analyze: (ids) => store.cableRoute({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, waypoint_ids: ids }),
      summary: (analysis) => store.cableRouteSummary(analysis),
      containerLabel: (container) => store.containerLabel(container),
      anchorA: () => ({ tag: I18n.t("cable.route.anchorTagA"), subject: I18n.t("cable.route.anchorSubjectA"), label: CableForms.portAnchorLabel(store, selPortA.value, selEqA.value), container: endContainerOf("A") }),
      anchorB: () => ({ tag: I18n.t("cable.route.anchorTagB"), subject: I18n.t("cable.route.anchorSubjectB"), label: CableForms.portAnchorLabel(store, selPortB.value, selEqB.value), container: endContainerOf("B") }),
      candidates: () => CableForms.routeCandidates(store),
      describe: (id) => CableForms.describeWaypoint(store, id),
      // La chaîne n'a AUCUN champ : sans ce signal, l'instantané de la modale ne verrait RIEN changer
      // et laisserait fermer sur une route remaniée, sans confirmation (cf. `FormHost.markDirty`).
      // On ne re-peint PAS la chaîne ici : le composant le fait lui-même juste après ce rappel.
      changed: () => { host.markDirty?.(); refresh(); syncStatus(true); },
    });
    /** Re-peint la chaîne — la route est inchangée, mais les ANCRES (donc leurs alertes) dépendent des
        ports choisis. A remplacé l'ancien hint texte `syncRoute`, dont il garde le nom et les sites d'appel. */
    const syncRoute = () => { wpChain.render(); };
    root.appendChild(FormControls.fieldRow(I18n.t("cable.route.field"), wpChain.element, I18n.t("cable.route.fieldHint")));

    const statusSel = FormControls.select(CableStatuses.ALL.map((s) => ({ value: s.id, label: I18n.t(s.labelKey) })), cable ? cable.status : CABLE_STATUS_DEFAULT_NEW);
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.statusField"), statusSel, I18n.t("cable.cable.statusHint")));
    const descI = FormControls.textArea(cable ? cable.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.common.description"), descI));
    const hint = document.createElement("div"); hint.className = "form-hint"; root.appendChild(hint);

    // ---- contraintes (famille + salle) & cohérence ----
    const familyOf = (portId: string) => store.portFamily(store.get("ports", portId));
    const cableTypeFamily = (ctId: string) => { const ct: any = ctId ? store.get("cableTypes", ctId) : null; return ct ? ct.family : null; };
    const constraintFor = (end: "A" | "B") => { const other = end === "A" ? selPortB.value : selPortA.value; return familyOf(other) || cableTypeFamily(selType.value) || null; };
    const typeFilterFamily = () => familyOf(selPortA.value) || familyOf(selPortB.value) || null;
    const endContainerOf = (end: "A" | "B") => { const pid = end === "A" ? selPortA.value : selPortB.value; if (pid) { const p: any = store.get("ports", pid); if (p) return store.equipmentNamedContainer(p.equipment_id); } const eid = end === "A" ? selEqA.value : selEqB.value; return eid ? store.equipmentNamedContainer(eid) : null; };
    const routeConteneurs = () => { const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: wpState.ids }); if (!r.valid) return null; if (!r.hasExits) return { intra: true, conteneurs: [] as PlacementContainer[] }; return { intra: false, conteneurs: [r.startContainer, r.endContainer].filter(Boolean) as PlacementContainer[] }; };
    const contrainteFor = (end: "A" | "B"): ContrainteConteneur => {
      const rr = routeConteneurs();
      if (!rr) return { containers: [], onlyUnplaced: true };
      const autre = endContainerOf(end === "A" ? "B" : "A");
      if (rr.intra) return autre ? { containers: [autre], onlyUnplaced: false } : { containers: null, onlyUnplaced: false };
      // Dédoublonnage STRUCTUREL (un `Set` ne saurait pas qu'un étage est un couple), puis on retire le
      // conteneur DÉJÀ occupé par l'autre bout quand il en reste un autre à proposer — logique inchangée.
      let autorises = rr.conteneurs.filter((c, i, arr) => arr.findIndex((x) => PlacementContainers.same(x, c)) === i);
      if (autorises.length > 1 && autre && autorises.some((c) => PlacementContainers.same(c, autre))) autorises = autorises.filter((c) => !PlacementContainers.same(c, autre));
      return { containers: autorises, onlyUnplaced: false };
    };
    const orientEnds = (fromP: string | null, toP: string | null): [string | null, string | null] => {
      const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: wpState.ids });
      if (!r.valid || !r.hasExits || !r.startContainer || !r.endContainer || PlacementContainers.same(r.startContainer, r.endContainer)) return [fromP, toP];
      const conteneurDe = (pid: string | null) => { if (!pid) return null; const p: any = store.get("ports", pid); return p ? store.equipmentNamedContainer(p.equipment_id) : null; };
      const cf = conteneurDe(fromP), ct = conteneurDe(toP);
      const fromWrong = !!cf && PlacementContainers.same(cf, r.endContainer) && !PlacementContainers.same(cf, r.startContainer);
      const toWrong = !!ct && PlacementContainers.same(ct, r.startContainer) && !PlacementContainers.same(ct, r.endContainer);
      return (fromWrong || toWrong) ? [toP, fromP] : [fromP, toP];
    };
    const rebuildTypeSelect = () => {
      const fam = typeFilterFamily();
      const kindTarget = store.portKind(store.get("ports", selPortA.value)) || store.portKind(store.get("ports", selPortB.value)) || null;
      const cur = selType.value;
      let list = store.all("cableTypes").slice();
      if (fam) list = list.filter((ct: any) => ct.family === fam);
      else if (kindTarget) list = list.filter((ct: any) => (ct.kind === "power" ? "power" : "data") === kindTarget);
      // tri par FAMILLE puis nom → les <optgroup> (par famille) apparaissent groupés et ordonnés.
      list.sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name));
      if (cur && !list.some((ct: any) => ct.id === cur)) { const c: any = store.get("cableTypes", cur); if (c) list.push(c); }
      let next = cur;
      if (fam) { const cc: any = cur ? store.get("cableTypes", cur) : null; if (!cc || cc.family !== fam) { const f = list.find((ct: any) => ct.family === fam); next = f ? f.id : ""; } }
      // famille portée par l'<optgroup> (regroupement visuel) → le libellé garde juste le nom (+ média si présent).
      FormUi.setOptions(selType, [{ value: "", label: I18n.t("cable.common.pickCableType") }].concat(list.map((ct: any) => ({ value: ct.id, label: ct.name + (ct.medium ? " · " + ct.medium : ""), group: ct.family || I18n.t("cable.common.noFamily") }))), next);
    };
    const refresh = () => {
      rebuildTypeSelect();
      selEqA.setOptions(eqOpts(constraintFor("A"), selEqA.value, contrainteFor("A")), selEqA.value);
      selEqB.setOptions(eqOpts(constraintFor("B"), selEqB.value, contrainteFor("B")), selEqB.value);
      const pa = selPortA.value, pb = selPortB.value;
      selPortA.setOptions(portOpts(selEqA.value, pa, constraintFor("A")), pa);
      selPortB.setOptions(portOpts(selEqB.value, pb, constraintFor("B")), pb);
    };
    const curDraft = () => ({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, cable_type_id: selType.value || null, waypoint_ids: wpState.ids });
    const updateHint = (max: string) => {
      hint.classList.remove("warn", "err");
      const a = selPortA.value, b = selPortB.value, fa = familyOf(a), fb = familyOf(b);
      if (a && b && a === b) { hint.textContent = I18n.t("cable.cable.selfLoop"); hint.classList.add("err"); return; }
      if (a && b && fa && fb && fa !== fb) { hint.textContent = I18n.t("cable.cable.famDiffer", { a: fa, b: fb }); hint.classList.add("warn"); return; }
      const r = store.cableRoute(curDraft());
      if (!r.valid) { hint.textContent = I18n.t("cable.cable.routeInvalidDraft", { message: r.errors[0].message }); hint.classList.add("warn"); return; }
      if (max === CABLE_STATUS_DRAFT) { hint.textContent = I18n.t("cable.cable.incompleteDraft"); hint.classList.add("warn"); return; }
      if (max === "planifie") { hint.textContent = I18n.t("cable.cable.unplacedPlanned"); return; }
      hint.textContent = I18n.t("cable.cable.complete", { family: (fa || "?") });
    };
    const syncStatus = (userChange: boolean) => {
      const max = store.cableMaxStatus(curDraft());
      Array.from(statusSel.options).forEach((op) => { op.disabled = !store.cableStatusFits(op.value, max); });
      if (!store.cableStatusFits(statusSel.value, max)) statusSel.value = (max === CABLE_STATUS_DRAFT) ? CABLE_STATUS_DRAFT : CABLE_STATUS_DEFAULT_NEW;
      else if (userChange && statusSel.value === CABLE_STATUS_DRAFT && max !== CABLE_STATUS_DRAFT) statusSel.value = CABLE_STATUS_DEFAULT_NEW;
      updateHint(max);
    };

    selEqA.onchange = () => { selPortA.setOptions(portOpts(selEqA.value, null, constraintFor("A"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selEqB.onchange = () => { selPortB.setOptions(portOpts(selEqB.value, null, constraintFor("B"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selPortA.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selPortB.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selType.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };

    // INVERSION A ⇄ B : mémorise les 4 valeurs puis les échange. On reconstruit d'abord les options
    // d'ÉQUIPEMENT sans contrainte de famille en gardant la valeur échangée (`keepEqId` → l'option reste
    // présente même si le filtre l'aurait exclue), puis les options de PORT du nouvel équipement (`portOpts`
    // conserve toujours le port sélectionné, même hors filtre famille), avant de re-sélectionner. Enfin
    // `refresh()` ré-applique les contraintes famille/salle en préservant ces valeurs — EXACTEMENT l'état
    // qu'aurait produit un double changement manuel. Cas « bout vide » géré nativement : un côté à "" déplace
    // simplement le bout rempli vers l'autre (les valeurs "" restent sélectionnables). Aucune écriture store.
    const swapEnds = () => {
      const aEq = selEqA.value, aPort = selPortA.value, bEq = selEqB.value, bPort = selPortB.value;
      selEqA.setOptions(eqOpts(null, bEq, null), bEq);
      selEqB.setOptions(eqOpts(null, aEq, null), aEq);
      selPortA.setOptions(portOpts(bEq, bPort || null, null), bPort);
      selPortB.setOptions(portOpts(aEq, aPort || null, null), aPort);
      refresh(); syncRoute(); syncStatus(true); renderNets();
    };
    swapBtn.onclick = swapEnds;
    // NB : l'action « ⇅ Inverser la route » proposée SUR L'ANCRE par la chaîne est DISTINCTE de ce
    // bouton-ci : elle inverse l'ORDRE DES ÉTAPES (les bouts sont la vérité saisie — décision
    // utilisateur 2026-07-31), là où ce ⇅ permute les BOUTS. La chaîne la porte elle-même (commit).

    refresh(); renderNets(); syncRoute(); syncStatus(false);

    // validation live (invariant câble partagé : un port ne se relie pas à lui-même) — surligne le port B.
    // `name` mappé pour que l'unicité V6h (règle de PORTÉE) puisse surligner le champ si l'autorité la signale.
    // NB : `cableLive` ne reçoit ni `fetch` ni `find` → les règles de portée NE tournent PAS en live (comme V6g
    // dans EquipmentForms) ; l'unicité du nom est jouée au SAVE par le Store/serveur (create/update → null →
    // toast d'échec). Le mapping reste utile si un `find` est un jour injecté ici.
    const cableLive = new LiveValidation("cables", { name: nameI, from_port_id: selPortA, to_port_id: selPortB, status: statusSel });
    cableLive.clearOnInput();

    host.openModal({
      title: cable ? I18n.t("cable.cable.titleEdit") : I18n.t("cable.cable.titleNew"),
      subtitle: cable ? Html.escape(cable.name || "") : I18n.t("cable.cable.subtitleNew"),
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast(I18n.t("cable.common.nameRequired"), "err"); return false; }
        let fromP = selPortA.value || null, toP = selPortB.value || null;
        const ctId = selType.value || null;
        const wpIds = wpState.ids.slice();
        const lenV0 = parseFloat(String(lenI.value));
        const lenOut = (isFinite(lenV0) && lenV0 >= 0) ? lenV0 : null;
        // self-loop (invariant cable partagé) : surligné directement sur le port B au lieu d'un toast.
        if (cableLive.check({ from_port_id: fromP, to_port_id: toP, status: statusSel.value || "planifie" }).some((e) => e.code === "invariant")) return false;
        if (fromP && store.cableOnPort(fromP, cable ? cable.id : null)) { Notify.toast(I18n.t("cable.cable.portABusy"), "err"); return false; }
        if (toP && store.cableOnPort(toP, cable ? cable.id : null)) { Notify.toast(I18n.t("cable.cable.portBBusy"), "err"); return false; }
        // T9 : un câble d'alimentation relie source↔sink. Deux prises de MÊME sens (source↔source, sink↔sink) sont
        // refusées par le Store (crossEntity T9, HORS live-check faute de `fetch`) → on pré-vérifie ici pour un message
        // clair. Sans ça, le refus reviendrait en `null` au save et serait avalé (défaut #3 / N4). Miroir de
        // DataValidation cables/T9 (source de vérité côté serveur+import).
        if (fromP && toP) {
          const pa: any = store.get("ports", fromP), pb: any = store.get("ports", toP);
          const dirA = pa ? pa.direction : "", dirB = pb ? pb.direction : "";
          if ((dirA === "source" || dirA === "sink") && dirA === dirB) { Notify.toast(I18n.t("cable.cable.powerDir"), "err"); return false; }
        }
        [fromP, toP] = orientEnds(fromP, toP);
        // EXIT TERMINAL & cohérence de route : refuse d'enregistrer une route de waypoints incohérente.
        if (wpIds.length) {
          const bad = store.routeStructuralError({ from_port_id: fromP, to_port_id: toP, waypoint_ids: wpIds });
          if (bad) { Notify.toast(I18n.t("cable.cable.routeInvalid", { message: bad.message }), "err"); return false; }
        }
        const max = store.cableMaxStatus({ from_port_id: fromP, to_port_id: toP, cable_type_id: ctId, waypoint_ids: wpIds });
        let status = statusSel.value;
        if (!CableStatuses.isStatus(status) || !store.cableStatusFits(status, max)) status = (max === CABLE_STATUS_DRAFT) ? CABLE_STATUS_DRAFT : CABLE_STATUS_DEFAULT_NEW;
        else if (status === CABLE_STATUS_DRAFT && max !== CABLE_STATUS_DRAFT) status = CABLE_STATUS_DEFAULT_NEW;
        // réseau NON écrit ici : il est déduit des ports terminaux (source unique). Champs réseau du câble dormants.
        const payload = { name, cable_type_id: ctId, from_port_id: fromP, to_port_id: toP, waypoint_ids: wpIds, length_m: lenOut, status, description: descI.value.trim() };
        // Store.update/create renvoient null si la validation refuse (pas de throw). On GARDE ce retour (N4) : sinon un
        // refus réel (ex. T9 non pré-vérifiable en live) fermerait la modale sur un « Câble mis à jour » mensonger,
        // saisie perdue — exactement le défaut #3.
        if (cable) {
          const saved = await store.update("cables", cable.id, payload);
          if (!saved) { Notify.toast(I18n.t("cable.cable.saveFailed"), "err"); return false; }
        } else {
          const created: any = await store.create("cables", payload);
          if (!created) { Notify.toast(I18n.t("cable.cable.saveFailed"), "err"); return false; }
          if (created.id) opts.onCreated?.(created.id);   // ex. routage : rend le câble tout juste créé visible
        }
        host.setDirty?.(true); Notify.toast(cable ? I18n.t("cable.cable.updated") : (max !== CABLE_STATUS_DRAFT ? I18n.t("cable.cable.created") : I18n.t("cable.cable.draftCreated"))); onSaved?.(); return true;
      },
    });
    // FOCUS D'OUVERTURE : le premier champ NON RENSEIGNÉ, jamais un champ qu'on vient de remplir pour
    // l'utilisateur (retour terrain T7, 2026-09-01). La règle historique était « édition → le nom ;
    // création → l'équipement A » : juste pour une création à froid, FAUSSE dès que le formulaire arrive
    // PRÉ-REMPLI — ce que fait exactement le traçage de route, qui pose les DEUX bouts (`RouteTool.finish`
    // → `fromPortId`/`toPortId`). L'utilisateur atterrissait alors sur un champ déjà rempli pendant que le
    // seul champ vide — le nom — n'avait pas le focus. Formulée ainsi, la règle reste juste pour les
    // ouvertures pré-remplies qu'on n'a pas encore inventées (clic de port, affectation d'un brouillon).
    // ⚠ CONSÉQUENCE ASSUMÉE : une création À FROID (tout est vide) focalise désormais le NOM et non plus
    // l'équipement A — c'est le premier champ vide du formulaire, et c'est déjà ce que fait l'édition.
    const champsDansLOrdre: Array<{ value: string; focus: () => void }> = [nameI, selEqA, selPortA, selEqB, selPortB];
    const premierVide = champsDansLOrdre.find((c) => !String(c.value || "").trim());
    setTimeout(() => (premierVide || nameI).focus(), 30);
  }

  /** Faisceau / trunk : créé À L'AVANCE (nom + type + nb de brins) entre 2 PATCHS. Ses fibres sont piochées
      par les PORTS des patchs d'extrémité ; sa route + sa longueur portent le tracé 2D/3D. */
  static cableBundle(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const bnd: any = id ? store.get("cableBundles", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(bnd ? bnd.name : "", I18n.t("cable.bundle.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("cable.bundle.nameField"), nameI, I18n.t("cable.bundle.nameHint")));
    // 2 EXTRÉMITÉS = PATCH PANELS uniquement (règle partagée T11) : le trunk se rattache à 2 patchs et forme un
    // POOL de brins, piochés ensuite par les ports de ces équipements (cf. formulaire Équipement d'un patch).
    // Le tracé du faisceau peut exister dès que ces 2 extrémités sont posées, même si aucun port ne pioche encore.
    // Un même patch ne porte pas les 2 bouts (T10) → chaque select EXCLUT la sélection de l'autre et se rebâtit
    // quand l'autre change. Une extrémité STOCKÉE non patch (donnée d'avant la règle) reste visible dans SON
    // select (signalée « NON patch ») : la validation partagée refusera l'enregistrement tant qu'elle y est.
    const initEpA = bnd ? (bnd.endpoint_a_equipment_id || "") : "";
    const initEpB = bnd ? (bnd.endpoint_b_equipment_id || "") : "";
    const patchEndpointOpts = (excludeId: string, keepId: string) =>
      [{ value: "", label: I18n.t("cable.bundle.endpointNone") }].concat(
        store.all("equipments")
          .filter((e: any) => (e.type === "patch_panel" || (keepId && e.id === keepId)) && e.id !== excludeId)
          .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""))
          .map((e: any) => { const emplacement = store.equipmentContainerLabel(e); return { value: e.id, label: (e.name || I18n.t("cable.bundle.equipment")) + (emplacement ? " · " + emplacement : "") + (e.type === "patch_panel" ? "" : I18n.t("cable.bundle.notPatch")) }; }));
    // Extrémités = des ENTITÉS (des patchs) → sélecteur à recherche (principe n°14), liste inchangée.
    const epaI = FormControls.entityPicker(patchEndpointOpts(initEpB, initEpA), initEpA);
    const epbI = FormControls.entityPicker(patchEndpointOpts(initEpA, initEpB), initEpB);
    const refreshEndpointOpts = () => {
      epaI.setOptions(patchEndpointOpts(epbI.value, initEpA), epaI.value);
      epbI.setOptions(patchEndpointOpts(epaI.value, initEpB), epbI.value);
      syncBundleRoute();   // changer une extrémité change le verdict extrémités ⇄ route (déclaré plus bas ; n'est appelé qu'aux événements)
    };
    epaI.onchange = refreshEndpointOpts; epbI.onchange = refreshEndpointOpts;
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.bundle.endpointAField"), epaI, I18n.t("cable.bundle.endpointAHint")), FormControls.fieldRow(I18n.t("cable.bundle.endpointBField"), epbI, I18n.t("cable.bundle.endpointBHint"))));
    // types de câble GROUPÉS par famille (<optgroup>) : tri famille→nom, la famille passe dans le groupe.
    const typeOpts = [{ value: "", label: I18n.t("cable.common.pickCableType") }].concat(store.all("cableTypes").slice().sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name)).map((ct: any) => ({ value: ct.id, label: ct.name + (ct.medium ? " · " + ct.medium : ""), group: ct.family || I18n.t("cable.common.noFamily") })));
    const typeI = FormControls.select(typeOpts, bnd ? (bnd.cable_type_id || "") : "");
    const fcI = FormControls.number(bnd ? bnd.fiber_count : 12, { min: 1, step: 1 });
    const lenI = FormControls.number((bnd && bnd.length_m != null) ? bnd.length_m : "", { min: 0, step: 0.1, placeholder: I18n.t("cable.bundle.lenPlaceholder") });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.bundle.fiberField"), typeI, I18n.t("cable.bundle.fiberHint")), FormControls.fieldRow(I18n.t("cable.bundle.strandField"), fcI, I18n.t("cable.bundle.strandHint")), FormControls.fieldRow(I18n.t("cable.bundle.lenField"), lenI, I18n.t("cable.bundle.lenHint"))));

    // ---- ROUTE PARTAGÉE : le MÊME composant que le formulaire câble (carton §4.5, décision D6) ----
    // A REMPLACÉ le nuage de cases PLAT + le hint texte + la liste « Ordre du trajet ». Le faisceau
    // hérite d'un coup de ce qui lui manquait : les erreurs rattachées à LEUR étape, l'état « transit »
    // visible, les ancres en alerte et l'action d'inversion. Seules les ANCRES diffèrent du câble —
    // des patchs plutôt que des ports —, et c'est tout ce que ce bloc a de spécifique.
    const wpState = { ids: bnd ? (bnd.waypoint_ids || []).slice() : [] as string[] };
    const wpChain = new RouteChainEditor({
      ids: () => wpState.ids,
      setIds: (next) => { wpState.ids = next; },
      // La source du verdict reste UNIQUE : `store.bundleRoute` (grammaire + cohérence des EXTRÉMITÉS,
      // inversion tolérée) — la MÊME analyse que celle qui décide du tracé (`TrunkRouting.trunkRoute`).
      analyze: (ids) => store.bundleRoute({ endpoint_a_equipment_id: epaI.value || null, endpoint_b_equipment_id: epbI.value || null, waypoint_ids: ids }),
      summary: (analysis) => store.cableRouteSummary(analysis),
      containerLabel: (container) => store.containerLabel(container),
      anchorA: () => ({ tag: I18n.t("cable.route.endpointTagA"), subject: I18n.t("cable.route.endpointSubjectA"), label: CableForms.equipAnchorLabel(store, epaI.value), container: epaI.value ? store.equipmentNamedContainer(epaI.value) : null }),
      anchorB: () => ({ tag: I18n.t("cable.route.endpointTagB"), subject: I18n.t("cable.route.endpointSubjectB"), label: CableForms.equipAnchorLabel(store, epbI.value), container: epbI.value ? store.equipmentNamedContainer(epbI.value) : null }),
      candidates: () => CableForms.routeCandidates(store),
      describe: (id) => CableForms.describeWaypoint(store, id),
      changed: () => { host.markDirty?.(); },
    });
    /** Re-peint la chaîne : la route n'a pas bougé, mais les ANCRES (donc leurs alertes) dépendent des
        extrémités choisies. A remplacé l'ancien hint texte, dont il garde le nom et les sites d'appel. */
    const syncBundleRoute = () => { wpChain.render(); };
    root.appendChild(FormControls.fieldRow(I18n.t("cable.route.field"), wpChain.element, I18n.t("cable.route.fieldHint")));
    syncBundleRoute();
    const descI = FormControls.textArea(bnd ? bnd.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.common.description"), descI));
    if (bnd) { const oc = store.bundleOccupancy(bnd.id); const maxStrand = store.maxUsedStrandOfBundle(bnd.id); const info = document.createElement("div"); info.className = "form-hint"; const suffix = maxStrand ? I18n.t("cable.bundle.occupancyReduce", { max: maxStrand }) : I18n.t("cable.bundle.occupancyEnd"); info.textContent = I18n.t("cable.bundle.occupancy", { used: oc.used, capacity: oc.capacity, suffix }); root.appendChild(info); }

    // validation live PARTAGÉE (T10 : A ≠ B · T11 : extrémité = patch panel) — surligne le champ fautif au save.
    // Le `fetch` adossé au Store active la règle cross-entité T11 (lecture du type de l'équipement pointé).
    const bundleLive = new LiveValidation("cableBundles", { endpoint_a_equipment_id: epaI, endpoint_b_equipment_id: epbI }, (coll, entityId) => store.get(coll, entityId) || null);
    bundleLive.clearOnInput();

    host.openModal({
      title: bnd ? I18n.t("cable.bundle.titleEdit") : I18n.t("cable.bundle.titleNew"),
      subtitle: bnd ? Html.escape(bnd.name || "") : I18n.t("cable.bundle.subtitleNew"),
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim(); if (!name) { Notify.toast(I18n.t("cable.common.nameRequired"), "err"); return false; }
        const fc = Math.max(1, parseInt(fcI.value, 10) || 12);
        // Refuser la réduction sous le NUMÉRO MAX de brin pioché (pas le simple compte : un port peut piocher le
        // brin 24 seul → used=1 mais on ne peut pas réduire à 12 sans laisser un brin hors plage).
        if (bnd) { const maxStrand = store.maxUsedStrandOfBundle(bnd.id); if (fc < maxStrand) { Notify.toast(I18n.t("cable.bundle.strandBelow", { fc, max: maxStrand }), "err"); return false; } }
        // COHÉRENCE DE ROUTE (parité câble) : une route STRUCTURELLEMENT mal formée (exit non appairé,
        // rupture de salle, pin d'étage en salle) n'est pas enregistrable. Les erreurs d'EXTRÉMITÉS
        // (`endpoints_split`/`endpoint_route_mismatch`), elles, restent enregistrables : ce sont des
        // données complétables plus tard — le hint de route les signale déjà.
        if (wpState.ids.length) {
          const bad = store.routeStructuralError({ from_port_id: null, to_port_id: null, waypoint_ids: wpState.ids });
          if (bad) { Notify.toast(I18n.t("cable.bundle.routeInvalid", { message: bad.message }), "err"); return false; }
        }
        const lenV = parseFloat(String(lenI.value));
        const payload = { name, cable_type_id: typeI.value || null, fiber_count: fc, waypoint_ids: wpState.ids.slice(), length_m: (isFinite(lenV) && lenV >= 0) ? lenV : null, endpoint_a_equipment_id: epaI.value || null, endpoint_b_equipment_id: epbI.value || null, description: descI.value.trim() };
        // T10/T11 (extrémités) surlignés PAR CHAMP avant d'écrire — même validation que le Store/serveur.
        if (bundleLive.check(payload).length) return false;
        // Store.create/update renvoient null si la validation refuse (pas de throw) : on GARDE ce retour (N4,
        // parité formulaire câble) — sinon la modale se fermerait sur un « Faisceau créé » mensonger, saisie perdue.
        if (bnd) {
          const saved = await store.update("cableBundles", bnd.id, payload);
          if (!saved) { Notify.toast(I18n.t("cable.bundle.saveFailed"), "err"); return false; }
        } else {
          const created: any = await store.create("cableBundles", payload);
          if (!created) { Notify.toast(I18n.t("cable.bundle.saveFailed"), "err"); return false; }
        }
        host.setDirty?.(true); Notify.toast(bnd ? I18n.t("cable.bundle.updated") : I18n.t("cable.bundle.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Baie (rack) — identité · localisation · cage · dims · side-mount · portes (avant/arrière) ·
      capots (emplacements waypoint toit/sol, tamponnés et appliqués à l.enregistrement). */
}
