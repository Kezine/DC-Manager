import type { Store } from "../store";
import type { ImageStore } from "../data/ImageStore";
import type { ModalOptions } from "../ui/Modal";
import { FormControls } from "../ui/FormControls";
import { ColorPalette } from "../ui/ColorPalette";
import { Notify } from "../ui/Notify";
import { Dialog } from "../ui/Dialog";
import { Html } from "../core/Html";
import { Text } from "../core/Text";
import { Color } from "../core/Color";
import { Format } from "../core/Format";
import { FloorLayout } from "../geometry/FloorLayout";
import { Ip } from "../core/Ip";
import { GroupTypes } from "../domain/GroupTypes";
import { CableStatuses } from "../domain/CableStatuses";
import { SpareTypes } from "../domain/SpareTypes";
import { SpareStatuses } from "../domain/SpareStatuses";
import { Waypoint } from "../models/Waypoint";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { Depths } from "../registries/Depths";
import { PortRoles } from "../registries/PortRoles";
import { PortTypes } from "../registries/PortTypes";
import { EquipFaces } from "../registries/EquipFaces";
import { Id } from "../core/Id";
import { RackGeometry } from "../geometry/RackGeometry";
import { RackScene } from "../geometry/RackScene";
import { RackItemKinds } from "../domain/RackItemKinds";
import { Normalize } from "../core/Normalize";
import {
  POWER_SOURCES, EQUIPMENT_TYPE_DEFAULT, LOCATIONS, FLOORS, RACK_SIDES, RACK_FACES, RACK_DEPTHS,
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_MOUNT_MARGIN_DEFAULT, U_MM, SIDE_U_STEP,
  BREAKOUT_SPANS, CABLE_STATUS_DRAFT, CABLE_STATUS_DEFAULT_NEW,
  EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD, EQUIP_FREE_DEFAULT_MM,
  WAYPOINT_TYPES, OOB_HEIGHT_DEFAULT, WAYPOINT_Z_DEFAULT, CONDUIT_W_DEFAULT, CONDUIT_H_DEFAULT, BRUSH_PADDING_MM,
  FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT,
  SPARE_DISK_TYPES, SPARE_CAP_UNITS, SPARE_HDD_INTERFACES, SPARE_HDD_FORMATS, SPARE_HDD_RPM,
  SPARE_TX_FORMS, SPARE_TX_SPEEDS, SPARE_TX_MEDIA,
} from "../domain/constants";

/** Libellés de forme de waypoint (réplique WAYPOINT_KIND_LABELS du monolithe). */
const WAYPOINT_KIND_LABELS: Record<string, string> = { point: "Pin (point de passage)", segment: "Chemin de câbles (rail)", brush: "Brosse de brassage (baie)" };

const locOptions = (sel: string) => [{ value: "", label: "— aucun —" }].concat(LOCATIONS.map((l) => ({ value: l.id, label: l.label })));
const floorOptions = (sel: string) => { const s = String(sel == null ? "" : sel); const o = [{ value: "", label: "— étage —" }].concat(FLOORS.map((f) => ({ value: f, label: "Étage " + f }))); if (s && !FLOORS.includes(s)) o.push({ value: s, label: s + " (hors liste)" }); return o; };

const divider = (txt: string) => { const d = document.createElement("div"); d.className = "section-divider"; d.textContent = txt; return d; };
const row2 = (...fields: HTMLElement[]) => { const r = document.createElement("div"); r.className = "form-row"; fields.forEach((f) => r.appendChild(f)); return r; };
/** Remplace les options d'un <select> existant (préserve l'élément + ses handlers). */
const setOptions = (sel: HTMLSelectElement, opts: { value: string; label: string; disabled?: boolean }[], value?: string) => {
  sel.innerHTML = "";
  opts.forEach((o) => { const op = document.createElement("option"); op.value = o.value; op.textContent = o.label; if (o.disabled) op.disabled = true; sel.appendChild(op); });
  if (value != null) sel.value = value;
};

const ipNetOptions = (store: Store) => store.all("ipNetworks").slice()
  .sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || ""))
  .map((n: any) => ({ value: n.id, label: Ip.short(n) }));
const eqOptions = (store: Store, none: string) => [{ value: "", label: none }].concat(
  store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })));

/** Services applicatifs des formulaires (câblés par le shell). */
export interface FormHost {
  openModal(opts: ModalOptions): void;
  setDirty?(v: boolean): void;
}

/* =============================================================================
   Formulaires d'édition (création + modification) montés dans la modale partagée.
   Réplique OO des fonctions open*Form du monolithe. `onSaved` rafraîchit l'appelant.
   ============================================================================= */
export class Forms {
  /** Bibliothèque d'images de façade (injectée au boot) — singleton applicatif (hors modèle). */
  static images: ImageStore | null = null;

  /** Catégorie de bibliothèque d'une face : annexe (top/bottom/left/right) → « autre » ; sinon front/rear. */
  private static faceAnnex(face: string): boolean { return face !== "front" && face !== "rear"; }
  /** Images éligibles pour une face : annexe → « autre » (sans filtre U) ; front/rear → même U + même face. */
  private static eligibleImages(u: number, face: string): any[] {
    const im = Forms.images; if (!im) return [];
    if (Forms.faceAnnex(face)) return im.list().filter((fi: any) => fi.face === "autre");
    const f = (face === "rear") ? "rear" : "front";
    return im.list().filter((fi: any) => fi.u_height === (u || 1) && fi.face === f);
  }
  /** Sélecteur d'image éligible (même U ET même face ; image courante toujours visible) → { id } ou null. */
  static faceImagePicker(store: Store, u: number, face: string, current: string | null): Promise<{ id: string | null } | null> {
    const images = Forms.images; if (!images) return Promise.resolve(null);
    const annex = Forms.faceAnnex(face), faceLbl = annex ? EquipFaces.label(face) : EquipFaces.label(face);
    return Dialog.custom({
      title: "Image de façade — " + (annex ? "face " + faceLbl.toLowerCase() + " (catégorie « autre »)" : ((u || 1) + "U · face " + faceLbl.toLowerCase())), confirmLabel: "Choisir",
      build: (root: HTMLElement) => {
        let selected: string | null = current || null, query = "";
        const note = document.createElement("div"); note.className = "form-hint"; note.style.marginBottom = "8px";
        note.textContent = annex ? "Faces annexes (équipement libre) : seules les images marquées « autre » sont éligibles (sans contrainte de U)." : "Seules les images " + (u || 1) + "U marquées « " + faceLbl + " » sont éligibles ici.";
        const search = document.createElement("input"); search.type = "text"; search.className = "search-input"; search.placeholder = "Rechercher une image (nom, description)…"; search.style.cssText = "width:100%;max-width:none;margin-bottom:8px;";
        const grid = document.createElement("div"); grid.className = "fi-grid";
        root.append(note, search, grid);
        const renderGrid = () => {
          grid.innerHTML = "";
          const none = document.createElement("button"); none.type = "button"; none.className = "fi-tile fi-none" + (selected == null ? " sel" : ""); none.textContent = "Aucune"; none.onclick = () => { selected = null; renderGrid(); }; grid.appendChild(none);
          const eligible = Forms.eligibleImages(u, face), cur: any = current ? images.get(current) : null;
          const list = eligible.slice(); if (cur && !eligible.some((fi: any) => fi.id === cur.id)) list.push(cur);
          const q = Text.normSearch(query);
          const shown = q ? list.filter((fi: any) => Text.normSearch((fi.name || "") + " " + (fi.description || "")).includes(q)) : list;
          shown.forEach((fi: any) => {
            const offFilter = annex ? (fi.face !== "autre") : !(fi.u_height === (u || 1) && fi.face === face);
            const t = document.createElement("button"); t.type = "button"; t.className = "fi-tile" + (selected === fi.id ? " sel" : "");
            const im = document.createElement("img"); im.src = fi.url; im.alt = "";
            const cap = document.createElement("span"); cap.className = "fi-cap";
            cap.textContent = (fi.name || "(image)") + (offFilter ? " · " + (fi.face === "autre" ? "autre" : fi.u_height + "U/" + EquipFaces.label(fi.face)) : "") + " · " + store.faceImageUsageCount(fi.id) + "×";
            t.append(im, cap); t.onclick = () => { selected = fi.id; renderGrid(); }; grid.appendChild(t);
          });
          if (q && shown.length === 0) { const empty = document.createElement("div"); empty.className = "fi-grid-empty"; empty.textContent = "Aucune image ne correspond à « " + query.trim() + " »."; grid.appendChild(empty); }
          const imp = document.createElement("button"); imp.type = "button"; imp.className = "fi-tile fi-import"; imp.innerHTML = "<span>+ Importer<br>image " + (annex ? "« autre »" : (u || 1) + "U · " + faceLbl) + "</span>";
          imp.onclick = async () => {
            const f = Forms.validImageFile(await Forms.promptImageFile()); if (!f) return;
            const nm = f.name ? f.name.replace(/\.[^.]+$/, "") : ("Image " + (annex ? "autre" : (u || 1) + "U"));
            const fi = await images.add({ name: nm, u_height: annex ? 1 : (u || 1), face: annex ? "autre" : face, blob: f, type: f.type });
            if (fi) { selected = fi.id; query = ""; search.value = ""; renderGrid(); }
          };
          grid.appendChild(imp);
        };
        search.addEventListener("input", () => { query = search.value; renderGrid(); });
        renderGrid(); setTimeout(() => search.focus(), 30);
        return { validate: () => true as const, collect: () => ({ id: selected }) };
      },
    });
  }

  /** Dialogue de configuration d'un BREAKOUT (trunk + N lanes). Résout
      `{ name, trunkTypeId, laneTypeId, count }` ou null si annulé. Le nombre de
      lanes (span) est dérivé des débits (trunk = N × lane, N ∈ BREAKOUT_SPANS) ;
      à débit absent, choix manuel parmi les spans standard. */
  private static configureBreakout(store: Store): Promise<{ name: string; trunkTypeId: string; laneTypeId: string; count: number } | null> {
    const types = store.all("portTypes").slice().sort((a: any, b: any) => a.name.localeCompare(b.name));
    if (!types.length) { Notify.toast("Créez d'abord des types de port (QSFP+ et SFP+).", "err"); return Promise.resolve(null); }
    const connOf = (t: any) => (t.connector || t.family || "").toUpperCase();
    const guessTrunk = types.find((t: any) => connOf(t).startsWith("QSFP")) || types[0];
    const guessLane = types.find((t: any) => connOf(t) === "SFP+") || types.find((t: any) => connOf(t).startsWith("SFP")) || types[0];
    const typeOpts = types.map((t: any) => ({ value: t.id, label: t.name + " · " + t.family + (t.connector && t.connector !== t.family ? " (" + t.connector + ")" : "") }));
    const nameI = FormControls.text("QSFP1", "ex. QSFP1");
    const trunkSel = FormControls.select(typeOpts, guessTrunk ? guessTrunk.id : "");
    const laneSel = FormControls.select(typeOpts, guessLane ? guessLane.id : "");
    const spanWrap = document.createElement("div");
    let span: number | null = null;   // nb de lanes retenu (null = combinaison invalide)
    const speedOf = (id: string) => { const t: any = store.get("portTypes", id); return { g: t ? PortTypes.speedGbps(t.speed) : null, s: t ? (t.speed || "") : "" }; };
    const refreshSpan = () => {
      spanWrap.innerHTML = "";
      const tk = speedOf(trunkSel.value), ln = speedOf(laneSel.value);
      if (tk.g && ln.g) {
        const ratio = tk.g / ln.g;
        const h = document.createElement("div"); h.className = "form-hint";
        if (Number.isInteger(ratio) && BREAKOUT_SPANS.includes(ratio)) {
          span = ratio;
          h.innerHTML = "Nombre de lanes : <b>×" + ratio + "</b>  (" + Html.escape(tk.s) + " ÷ " + Html.escape(ln.s) + " = " + ratio + " — breakout standard).";
        } else {
          span = null; h.style.color = "var(--err)";
          h.textContent = "Combinaison non standard : " + tk.s + " ÷ " + ln.s + " = " + (Number.isInteger(ratio) ? ratio : ratio.toFixed(2)) + ". Un breakout valide impose débit(trunk) = N × débit(lane) avec N ∈ {" + BREAKOUT_SPANS.join(", ") + "}.";
        }
        spanWrap.appendChild(h);
      } else {   // débit non renseigné (fibre, USB…) → choix manuel
        const sel = FormControls.select(BREAKOUT_SPANS.map((n) => ({ value: String(n), label: "×" + n + " lanes" })), String(span && BREAKOUT_SPANS.includes(span) ? span : 4));
        span = parseInt(sel.value, 10);
        sel.onchange = () => { span = parseInt(sel.value, 10); };
        spanWrap.appendChild(FormControls.fieldRow("Nombre de lanes", sel, "Débit non renseigné sur ces types → choix manuel parmi les breakouts standard."));
      }
    };
    trunkSel.onchange = refreshSpan; laneSel.onchange = refreshSpan; refreshSpan();
    return Dialog.custom({
      title: "Nouveau breakout", confirmLabel: "Créer",
      build: (root) => {
        root.appendChild(FormControls.fieldRow("Nom du trunk", nameI, "Les lanes seront nommées « nom/1 », « nom/2 », …"));
        root.appendChild(FormControls.fieldRow("Type du trunk (connecteur physique)", trunkSel, "Ex. 400G QSFP-DD — le trunk ne porte pas de câble lui-même."));
        root.appendChild(FormControls.fieldRow("Type des lanes", laneSel, "Identique pour TOUTES les lanes — chacune porte un câble 1:1."));
        root.appendChild(spanWrap);
        return {
          validate: () => {
            if (!nameI.value.trim()) return "Donnez un nom au trunk.";
            if (!trunkSel.value) return "Choisissez le type du trunk.";
            if (!laneSel.value) return "Choisissez le type des lanes.";
            if (!span) return "Combinaison trunk/lane non standard : ajustez les types (débit trunk = N × débit lane, N ∈ {" + BREAKOUT_SPANS.join(", ") + "}).";
            return true as const;
          },
          collect: () => ({ name: nameI.value.trim(), trunkTypeId: trunkSel.value, laneTypeId: laneSel.value, count: span as number }),
        };
      },
    });
  }

  /* ---- détail d'équipement (fiche riche : identité · façade · ports · agrégats · câbles + Modifier) ---- */
  private static dt(label: string): HTMLElement { const e = document.createElement("div"); e.className = "dt"; e.textContent = label; return e; }
  private static dd(html: string): HTMLElement { const e = document.createElement("div"); e.className = "dd"; e.innerHTML = html; return e; }
  /** Bits de localisation d'un équipement (hérités du rack / de la salle, ou saisis). */
  private static equipLocationBits(store: Store, e: any): string[] {
    const bits = (loc: any, fl: any, rm: any) => [FloorLayout.locationLabel(loc || ""), fl, rm].filter((x) => x && x !== "—");
    if ((e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id) { const rk: any = store.get("racks", e.rack_id); return rk ? bits(rk.location, rk.floor, rk.room) : []; }
    if (e.dim_mode === "free" && e.dc_id) { const dc: any = store.get("datacenters", e.dc_id); if (dc) return bits(dc.location, dc.floor, dc.room); }
    return bits(e.location, e.floor, e.room);
  }
  /** Aperçu d'une face : fond image (si attachée) + pastilles des ports posés. null si rien. */
  private static facePreview(store: Store, eq: any, face: string): HTMLElement | null {
    const url = (Forms.images && eq[(EQUIP_FACE_IMG_FIELD as any)[face]]) ? (Forms.images.get(eq[(EQUIP_FACE_IMG_FIELD as any)[face]]) || {}).url || null : null;
    const ports = store.portsOf(eq.id).filter((p: any) => p.face_x != null && p.face_y != null && EquipFaces.norm(p.face_side) === face);
    if (!url && !ports.length) return null;
    const isFree = eq.dim_mode === "free";
    const ar = isFree ? (Math.max(1, eq.free_w_mm || 100) + " / " + Math.max(1, eq.free_h_mm || 100)) : ("19 / " + (1.75 * Math.max(1, eq.u_height || 1)));
    const stage = document.createElement("div"); stage.className = "face-preview"; stage.style.aspectRatio = ar;
    if (url) { const im = document.createElement("img"); im.className = "face-bg"; im.src = url; im.alt = ""; stage.appendChild(im); }
    ports.forEach((p: any) => { const mk = document.createElement("div"); mk.className = "face-marker" + (p.role === "mgmt" ? " role-mgmt" : (p.role === "power" ? " role-power" : "")); mk.style.left = (p.face_x * 100) + "%"; mk.style.top = (p.face_y * 100) + "%"; mk.textContent = p.name || "(port)"; stage.appendChild(mk); });
    return stage;
  }
  /** Fiche DÉTAIL d'un équipement (lecture) + bouton « Modifier » → formulaire d'édition. */
  static equipmentDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const eq: any = store.get("equipments", id);
    if (!eq) { Notify.toast("Équipement introuvable", "err"); return; }
    const root = document.createElement("div");
    const grid = document.createElement("div"); grid.className = "detail-grid";
    const add = (label: string, html: string) => { grid.appendChild(Forms.dt(label)); grid.appendChild(Forms.dd(html)); };
    add("Nom", Html.escape(eq.name || "(sans nom)"));
    add("Type", `<span class="pill">${Html.escape(EquipmentTypes.label(eq.type))}</span>` + (eq.inventory_only ? ` <span class="pill" style="color:var(--fg-dim)">inventaire seul</span>` : ""));
    add("Marque", eq.brand ? Html.escape(eq.brand) : "—");
    add("Modèle", eq.model ? Html.escape(eq.model) : "—");
    add("N° de série", eq.serial ? Html.escape(eq.serial) : "—");
    const grp: any = eq.group_id ? store.get("groups", eq.group_id) : null;
    add("Groupe", grp ? `<span class="pill colored-pill" ${Color.pillStyle(grp.color)}>${Html.escape(grp.label)}</span>` : "—");
    if (eq.type === "pdu") add("Capacité PDU", eq.pdu_max_a != null ? `<span class="pill">${eq.pdu_max_a} A</span>` : "—");
    if (eq.purchase_date || eq.po_ref) add("Achat", [eq.purchase_date ? Html.escape(eq.purchase_date) : null, eq.po_ref ? "BC " + Html.escape(eq.po_ref) : null].filter(Boolean).join(" · ") || "—");
    if (eq.warranty_end) add("Fin de garantie", Html.escape(eq.warranty_end));
    if (eq.assigned_to || eq.assigned_date) add("Attribué à", [eq.assigned_to ? Html.escape(eq.assigned_to) : null, eq.assigned_date ? "le " + Html.escape(eq.assigned_date) : null].filter(Boolean).join(" · ") || "—");
    const dimHtml = eq.dim_mode === "free"
      ? `<span class="pill">Libre</span> ${eq.free_l_mm != null ? eq.free_l_mm : "?"} × ${eq.free_w_mm != null ? eq.free_w_mm : "?"} × ${eq.free_h_mm != null ? eq.free_h_mm : "?"} mm <span style="color:var(--fg-dimmer)">(L × l × h)</span>`
      : `<span class="pill">U</span> ${eq.u_height || 1} U · ${Html.escape(Forms.mountDepthLabel(eq))}${eq.locks_u ? " · U verrouillé" : ""}`;
    add("Dimensions", dimHtml);
    let placeHtml: string;
    if (eq.placement_mode === "rack") {
      const rk: any = eq.rack_id ? store.get("racks", eq.rack_id) : null;
      if (!eq.rack_id) placeHtml = `<span class="pill">Non placé</span>`;
      else if (rk) { const pos = eq.rack_u ? ("U" + eq.rack_u + ((eq.u_height || 1) > 1 ? "–U" + (eq.rack_u + (eq.u_height || 1) - 1) : "")) : "position libre"; placeHtml = `<span class="pill">Rack</span> ${Html.escape(rk.name || "(sans nom)")} · ${pos} · ${Html.escape(Forms.mountDepthLabel(eq))}`; }
      else placeHtml = `<span class="pill">Rack</span> <span style="color:var(--err)">rack introuvable</span>`;
    } else if (eq.dim_mode === "free" && eq.dc_id) { const dc: any = store.get("datacenters", eq.dc_id); placeHtml = `<span class="pill">Salle</span> ${Html.escape(dc ? (dc.name || "(sans nom)") : "(datacenter introuvable)")}`; }
    else placeHtml = `<span class="pill">Manuel</span>`;
    add("Emplacement", placeHtml);
    const locBits = Forms.equipLocationBits(store, eq);
    add("Lieu", locBits.length ? `<span class="loc-pill">${Html.escape(locBits.join(" · "))}</span>` : `<span style="color:var(--fg-dimmer)">— non renseigné —</span>`);
    add("Description", eq.description ? Html.escape(eq.description) : "—");
    add("Créé", Html.escape(Format.dateTime(eq.created_date)));
    add("Modifié", Html.escape(Format.dateTime(eq.updated_date)));
    root.appendChild(grid);

    // façade : bouton éditer + aperçus des faces avec contenu
    const dF = document.createElement("div"); dF.className = "section-divider"; dF.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
    const dFlabel = document.createElement("span"); dFlabel.textContent = "Façade"; dF.appendChild(dFlabel);
    const editFaceBtn = document.createElement("button"); editFaceBtn.type = "button"; editFaceBtn.className = "btn btn-ghost btn-sm"; editFaceBtn.textContent = "Éditer la façade";
    editFaceBtn.onclick = () => Forms.faceEditor(store, host, eq.id, { onApply: undefined });
    dF.appendChild(editFaceBtn); root.appendChild(dF);
    const faces = eq.dim_mode === "free" ? EQUIP_FACE_IDS.slice() : ["front", "rear"];
    const previews = faces.map((f) => ({ f, pv: Forms.facePreview(store, eq, f) })).filter((x) => x.pv);
    if (previews.length) previews.forEach(({ f, pv }) => { const cap = document.createElement("div"); cap.className = "form-hint"; cap.style.margin = "2px 0 4px"; cap.textContent = "Face " + EquipFaces.label(f).toLowerCase(); root.appendChild(cap); root.appendChild(pv!); });
    else { const fh = document.createElement("div"); fh.className = "form-hint"; fh.textContent = "Aucune façade définie. « Éditer la façade » pour importer une image et y placer les ports."; root.appendChild(fh); }

    // ports
    const ports = store.portsOf(eq.id);
    const dP = document.createElement("div"); dP.className = "section-divider"; dP.textContent = "Ports (" + ports.length + ")"; root.appendChild(dP);
    if (ports.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const rows = ports.map((p: any) => {
        const pt: any = store.get("portTypes", p.port_type_id), ag: any = p.aggregate_id ? store.get("aggregates", p.aggregate_id) : null;
        let bk = "";
        if (store.isBreakoutParent(p)) bk = ` <span class="pill">trunk ×${store.breakoutLanes(p.id).length}</span>`;
        else if (p.parent_port_id) { const par: any = store.get("ports", p.parent_port_id); bk = ` <span class="pill">lane ${p.lane || "?"} · ${Html.escape(par ? (par.name || "trunk") : "trunk")}</span>`; }
        return `<tr><td class="cell-name">${Html.escape(p.name || "(port)")}${bk}</td><td>${pt ? Html.escape(pt.name) + ' <span style="color:var(--fg-dimmer)">· ' + Html.escape(pt.family) + "</span>" : '<span style="color:var(--err)">type ?</span>'}</td><td><span class="pill role-${p.role === "mgmt" ? "mgmt" : (p.role === "power" ? "power" : "data")}">${Html.escape(PortRoles.label(p.role))}</span></td><td>${ag ? Html.escape(ag.name || "(agrégat)") : '<span style="color:var(--fg-dimmer)">—</span>'}</td></tr>`;
      }).join("");
      tw.innerHTML = `<table><thead><tr><th>Port</th><th>Type</th><th>Rôle</th><th>Agrégat</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun port."; root.appendChild(e); }

    // câbles connectés
    const cables = store.cablesOfPorts(ports.map((p: any) => p.id));
    const dC = document.createElement("div"); dC.className = "section-divider"; dC.textContent = "Câbles connectés (" + cables.length + ")"; root.appendChild(dC);
    if (cables.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const endHtml = (c: any) => { const pa: any = store.get("ports", c.from_port_id), pb: any = store.get("ports", c.to_port_id); const ea: any = pa ? store.get("equipments", pa.equipment_id) : null, eb: any = pb ? store.get("equipments", pb.equipment_id) : null; const fmt = (e: any, p: any) => e ? `${Html.escape(e.name || "?")} <span style="color:var(--fg-dimmer)">:</span> ${Html.escape(p ? (p.name || "?") : "?")}` : `<span style="color:var(--err)">port ?</span>`; return `${fmt(ea, pa)} <span style="color:var(--accent)">↔</span> ${fmt(eb, pb)}`; };
      const rows = cables.map((c: any) => { const ct: any = store.get("cableTypes", c.cable_type_id), net: any = c.network_id ? store.get("networks", c.network_id) : null; return `<tr><td class="cell-name">${Html.escape(c.name || "(câble)")}</td><td>${ct ? Html.escape(ct.name) : '<span style="color:var(--err)">type ?</span>'}</td><td>${endHtml(c)}</td><td>${net ? `<span class="pill colored-pill" ${Color.pillStyle(net.color)}>${Html.escape(net.label)}</span>` : '<span style="color:var(--fg-dimmer)">—</span>'}</td></tr>`; }).join("");
      tw.innerHTML = `<table><thead><tr><th>Câble</th><th>Type</th><th>Liaison</th><th>Réseau</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun câble connecté."; root.appendChild(e); }

    // spares (pièces de rechange) affectés à cet équipement
    const spares = store.sparesOfEquipment(eq.id);
    if (spares.length) {
      const dS = document.createElement("div"); dS.className = "section-divider"; dS.textContent = "Spares affectés (" + spares.length + ")"; root.appendChild(dS);
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const rows = spares.map((s: any) => `<tr><td class="cell-name">${Html.escape(s.displayName())}</td><td><span class="pill">${SpareTypes.icon(s.type)} ${Html.escape(SpareTypes.label(s.type))}</span></td><td>${s.techSummary() ? Html.escape(s.techSummary()) : '<span style="color:var(--fg-dimmer)">—</span>'}</td><td>${s.serial ? Html.escape(s.serial) : '<span style="color:var(--fg-dimmer)">—</span>'}</td></tr>`).join("");
      tw.innerHTML = `<table><thead><tr><th>Désignation</th><th>Type</th><th>Caractéristiques</th><th>N° série</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
    }

    // Modifier → formulaire d'édition (remplace la fiche par la modale d'édition)
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end";
    const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "btn btn-primary"; editBtn.textContent = "Modifier";
    editBtn.onclick = () => Forms.equipment(store, host, eq.id, onChanged);
    actions.appendChild(editBtn); root.appendChild(actions);

    host.openModal({ title: "Détail de l'équipement", subtitle: Html.escape(eq.name || ""), body: root, hideFooter: true, wide: true });
  }

  /** Éditeur de FAÇADE (sous-éditeur empilé) : pose les ports sur les faces de l'équipement
      (face_x/face_y/face_side) — onglets de face, glisser, snap de grille, « Tout poser / enlever »,
      palette des ports non posés. `opts.onApply({fids,place})` reporte sur le brouillon du formulaire
      parent ; sinon écrit dans le store. Les IMAGES de façade (bibliothèque IndexedDB) sont d'une phase
      ultérieure : on PRÉSERVE les références d'image existantes (fids) et on permet de les détacher. */
  static faceEditor(store: Store, host: FormHost, eqId: string, opts: any = {}): void {
    const eq: any = store.get("equipments", eqId);
    if (!eq) { Notify.toast("Équipement introuvable", "err"); return; }
    const isFree = eq.dim_mode === "free";
    const faces: string[] = isFree ? EQUIP_FACE_IDS.slice() : ["front", "rear"];
    const srcPorts: any[] = opts.ports || store.portsOf(eq.id);
    const ports = srcPorts.filter((p) => !p.parent_port_id);   // lanes : position héritée du trunk
    const fids: Record<string, string | null> = {};
    faces.forEach((f) => { fids[f] = (opts.fids && (f in opts.fids)) ? opts.fids[f] : (eq[EQUIP_FACE_IMG_FIELD[f]] || null); });
    let side = "front";
    const place: Record<string, { x: number; y: number; side: string }> = {};
    ports.forEach((p) => { if (p.face_x != null && p.face_y != null) { const f = EquipFaces.norm(p.face_side); if (faces.includes(f)) place[p.id] = { x: p.face_x, y: p.face_y, side: f }; } });
    const markDirty = opts.onApply ? () => {} : () => host.setDirty?.(true);

    const root = document.createElement("div");
    const tabs = document.createElement("div"); tabs.className = "face-toolbar"; tabs.style.flexWrap = "wrap";
    const tabBtns: Record<string, HTMLButtonElement> = {};
    faces.forEach((f) => { const b = document.createElement("button"); b.type = "button"; b.textContent = EquipFaces.label(f); b.onclick = () => { side = f; render(); }; tabBtns[f] = b; tabs.appendChild(b); });
    root.appendChild(tabs);

    const FACE_GRID_PRESETS = [
      { id: "free", label: "Libre (sans grille)", cols: 0, rows: 0 }, { id: "g6x1", label: "Grille 6 × 1", cols: 6, rows: 1 },
      { id: "g12x1", label: "Grille 12 × 1", cols: 12, rows: 1 }, { id: "g12x2", label: "Grille 12 × 2", cols: 12, rows: 2 },
      { id: "g24x1", label: "Grille 24 × 1", cols: 24, rows: 1 }, { id: "g24x2", label: "Grille 24 × 2", cols: 24, rows: 2 },
      { id: "g24x4", label: "Grille 24 × 4", cols: 24, rows: 4 }, { id: "g48x2", label: "Grille 48 × 2", cols: 48, rows: 2 },
    ];
    let grid: { cols: number; rows: number } | null = null;
    const tools = document.createElement("div"); tools.className = "face-toolbar";
    const attachBtn = document.createElement("button"); attachBtn.type = "button"; attachBtn.className = "btn btn-ghost btn-sm"; attachBtn.textContent = "Attacher une image…";
    const detachBtn = document.createElement("button"); detachBtn.type = "button"; detachBtn.className = "btn btn-ghost btn-sm"; detachBtn.textContent = "Détacher l'image";
    const addAllBtn = document.createElement("button"); addAllBtn.type = "button"; addAllBtn.className = "btn btn-ghost btn-sm"; addAllBtn.textContent = "Tout poser"; addAllBtn.title = "Disposer uniformément tous les ports sur cette face (suit la grille si active)";
    const removeAllBtn = document.createElement("button"); removeAllBtn.type = "button"; removeAllBtn.className = "btn btn-ghost btn-sm"; removeAllBtn.textContent = "Tout enlever";
    const gridLab = document.createElement("span"); gridLab.style.cssText = "font-size:11px;color:var(--fg-dim);margin-left:6px;"; gridLab.textContent = "Grille :";
    const gridSel = FormControls.select(FACE_GRID_PRESETS.map((g) => ({ value: g.id, label: g.label })), "free"); gridSel.style.cssText = "font-size:11px;padding:4px 6px;";
    tools.append(attachBtn, detachBtn, addAllBtn, removeAllBtn, gridLab, gridSel); root.appendChild(tools);

    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = "Cliquez un port pour le poser, puis glissez-le. « Grille » contraint le glisser sans repositionner l'existant. « Tout poser » dispose uniformément. « Attacher une image » : fond de façade (filtré par U + face).";
    root.appendChild(hint);
    const stage = document.createElement("div"); root.appendChild(stage);
    const palette = document.createElement("div"); palette.className = "face-palette"; root.appendChild(palette);

    const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;
    const snapToGrid = (x: number, y: number) => {
      if (!grid || !grid.cols || !grid.rows) return { x: clamp01(x), y: clamp01(y) };
      return { x: clamp01((Math.round(x * grid.cols - 0.5) + 0.5) / grid.cols), y: clamp01((Math.round(y * grid.rows - 0.5) + 0.5) / grid.rows) };
    };
    const faceWH = (f: string) => {
      const w = Math.max(1, eq.free_w_mm || EQUIP_FREE_DEFAULT_MM), d = Math.max(1, eq.free_l_mm || EQUIP_FREE_DEFAULT_MM), h = Math.max(1, eq.free_h_mm || EQUIP_FREE_DEFAULT_MM);
      if (f === "left" || f === "right") return { W: d, H: h };
      if (f === "top" || f === "bottom") return { W: w, H: d };
      return { W: w, H: h };
    };
    const applyStageSize = (el: HTMLElement, f: string) => {
      const u = Math.max(1, (eq.u_height | 0) || 1);
      if (isFree) {
        const wh = faceWH(f); el.style.aspectRatio = wh.W + " / " + wh.H;
        if (wh.H > wh.W) { el.style.width = "auto"; el.style.height = "50vh"; el.style.maxWidth = "100%"; el.style.maxHeight = "50vh"; el.style.margin = "0 auto"; }
        else { el.style.width = "100%"; el.style.height = ""; el.style.maxWidth = ""; el.style.maxHeight = "50vh"; el.style.margin = "0 auto"; }
      } else { el.style.aspectRatio = "19 / " + (1.75 * u); el.style.width = ""; el.style.height = ""; el.style.maxWidth = ""; el.style.maxHeight = ""; el.style.margin = ""; }
    };
    const layoutUniform = (list: any[]) => {
      const n = list.length; if (!n) return;
      let cols: number, rows: number;
      if (grid && grid.cols && grid.rows) { cols = grid.cols; rows = Math.max(grid.rows, Math.ceil(n / cols)); }
      else { const wh = faceWH(side); const aspect = isFree ? (wh.W / wh.H) : (19 / (1.75 * (eq.u_height || 1))); cols = Math.max(1, Math.round(Math.sqrt(n * aspect))); rows = Math.ceil(n / cols); }
      list.forEach((p, i) => { const c = i % cols, r = Math.floor(i / cols); place[p.id] = { x: clamp01((c + 0.5) / cols), y: clamp01((r + 0.5) / rows), side }; });
    };
    const startDrag = (ev: PointerEvent, id: string, markerEl: HTMLElement) => {
      ev.preventDefault(); markerEl.classList.add("dragging");
      const move = (e: PointerEvent) => { markDirty(); const rect = stage.getBoundingClientRect(); const s = snapToGrid((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height); place[id].x = s.x; place[id].y = s.y; markerEl.style.left = (s.x * 100) + "%"; markerEl.style.top = (s.y * 100) + "%"; };
      const up = () => { markerEl.classList.remove("dragging"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    };
    function render(): void {
      faces.forEach((f) => { tabBtns[f].className = "btn btn-sm " + (side === f ? "btn-primary" : "btn-ghost"); });
      const hasImg = !!fids[side];
      const imgUrl: string | null = hasImg && Forms.images ? ((Forms.images.get(fids[side]) || {}).url || null) : null;
      attachBtn.style.display = Forms.images ? "" : "none";
      attachBtn.textContent = hasImg ? "Changer l'image…" : "Attacher une image…";
      detachBtn.style.display = hasImg ? "" : "none";
      stage.className = "face-stage" + (imgUrl ? "" : " empty"); applyStageSize(stage, side); stage.innerHTML = "";
      if (imgUrl) { const im = document.createElement("img"); im.className = "face-bg"; im.src = imgUrl; im.alt = ""; stage.appendChild(im); }
      else { const h = document.createElement("div"); h.className = "face-empty-hint"; h.textContent = "Face " + EquipFaces.label(side).toLowerCase() + (hasImg ? " — image introuvable (référence orpheline)" : " — aucune image (positionnement possible)"); stage.appendChild(h); }
      if (grid && grid.cols && grid.rows) {
        const NS = "http://www.w3.org/2000/svg";
        const ov = document.createElementNS(NS, "svg"); ov.setAttribute("class", "face-grid-ov"); ov.setAttribute("viewBox", "0 0 " + grid.cols + " " + grid.rows); ov.setAttribute("preserveAspectRatio", "none");
        const line = (x1: number, y1: number, x2: number, y2: number) => { const l = document.createElementNS(NS, "line"); l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1)); l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2)); ov.appendChild(l); };
        for (let i = 1; i < grid.cols; i++) line(i, 0, i, grid.rows);
        for (let j = 1; j < grid.rows; j++) line(0, j, grid.cols, j);
        stage.appendChild(ov);
      }
      ports.forEach((p) => {
        const pos = place[p.id]; if (!pos || pos.side !== side) return;
        const mk = document.createElement("div"); mk.className = "face-marker" + (p.role === "mgmt" ? " role-mgmt" : (p.role === "power" ? " role-power" : ""));
        mk.style.left = (pos.x * 100) + "%"; mk.style.top = (pos.y * 100) + "%";
        const lab = document.createElement("span"); lab.textContent = p.name || "(port)"; mk.appendChild(lab);
        const x = document.createElement("span"); x.className = "fm-x"; x.textContent = "×"; x.title = "Retirer de la façade";
        x.addEventListener("pointerdown", (e) => e.stopPropagation());
        x.addEventListener("click", (e) => { e.stopPropagation(); markDirty(); delete place[p.id]; render(); });
        mk.appendChild(x);
        mk.addEventListener("pointerdown", (e) => startDrag(e as PointerEvent, p.id, mk));
        stage.appendChild(mk);
      });
      palette.innerHTML = "";
      const unplaced = ports.filter((p) => !place[p.id]);
      const onOther = ports.filter((p) => place[p.id] && place[p.id].side !== side).length;
      const ph = document.createElement("div"); ph.className = "face-palette-hint";
      ph.textContent = (unplaced.length ? "Ports à poser (" + unplaced.length + ") — cliquez pour les ajouter à la face " + EquipFaces.label(side).toLowerCase() + " :" : (ports.length ? "Tous les ports sont posés." : "Cet équipement n'a aucun port.")) + (onOther ? "  (" + onOther + " sur " + (faces.length > 2 ? "d'autres faces" : "l'autre face") + ")" : "");
      palette.appendChild(ph);
      unplaced.forEach((p) => { const c = document.createElement("button"); c.type = "button"; c.className = "face-chip"; c.textContent = p.name || "(port)"; c.onclick = () => { markDirty(); const s = snapToGrid(0.5, 0.5); place[p.id] = { x: s.x, y: s.y, side }; render(); }; palette.appendChild(c); });
    }
    gridSel.onchange = () => { const g = FACE_GRID_PRESETS.find((x) => x.id === gridSel.value); grid = (g && g.cols) ? { cols: g.cols, rows: g.rows } : null; render(); };
    addAllBtn.onclick = () => { markDirty(); layoutUniform(ports.filter((p) => !place[p.id] || place[p.id].side === side)); render(); };
    removeAllBtn.onclick = () => { markDirty(); ports.forEach((p) => { if (place[p.id] && place[p.id].side === side) delete place[p.id]; }); render(); };
    detachBtn.onclick = () => { markDirty(); fids[side] = null; render(); };
    attachBtn.onclick = async () => {
      const u = Forms.faceAnnex(side) ? 1 : Math.max(1, (eq.u_height | 0) || 1);
      const res = await Forms.faceImagePicker(store, u, side, fids[side]);
      if (res) { markDirty(); fids[side] = res.id; render(); }
    };
    render();

    const subtitle = (isFree
      ? "Boîtier libre · " + (eq.free_w_mm || "?") + " × " + (eq.free_l_mm || "?") + " × " + (eq.free_h_mm || "?") + " mm (l × p × h) — 6 faces"
      : "Panneau 19″ · " + (eq.u_height || 1) + "U — faces avant et arrière");
    const applyResult = async () => {
      if (opts.onApply) { opts.onApply({ fids, place }); return; }
      const facePatch: any = {};
      faces.forEach((f) => { facePatch[EQUIP_FACE_IMG_FIELD[f]] = fids[f] || null; });
      const ops: any[] = [{ collection: "equipments", id: eq.id, patch: facePatch }];
      ports.forEach((p) => { const pos = place[p.id]; ops.push({ collection: "ports", id: p.id, patch: pos ? { face_x: pos.x, face_y: pos.y, face_side: pos.side } : { face_x: null, face_y: null } }); });
      await store.updateBatch(ops);
      host.setDirty?.(true); Notify.toast("Façade enregistrée");
    };
    Dialog.custom({
      title: "Façade — " + Html.escape(eq.name || "équipement"), message: subtitle, wide: true,
      confirmLabel: opts.onApply ? "Appliquer" : "Enregistrer", cancelLabel: "Fermer",
      build: (h2) => { h2.appendChild(root); return { validate: () => true as const, collect: () => true }; },
    }).then(async (res) => { if (res) await applyResult(); });
  }

  /** Éditeur de capot (toit/sol) : grille SVG au pas 1U, multi-sélection au glisser,
      sauvegarde IMMÉDIATE des cellules autorisées (roof_cells/floor_cells). Une cellule
      portant un pin (◆) ne peut être retirée. Réservé à un rack EXISTANT. */
  private static capEditor(store: Store, host: FormHost, rack: any, face: string): { el: HTMLElement; refresh: () => void } {
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
    const cellsSet = () => new Set(RackGeometry.capCells(rack, face));
    const occSet = () => { const s = new Set<string>(); store.all("waypoints").forEach((w: any) => { if (w.kind === "point" && w.rack_id === rack.id && w.cap_face === face) s.add((w.cap_cx | 0) + "," + (w.cap_cy | 0)); }); return s; };
    let prevRect: SVGElement | null = null;
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
    const cellAt = (clientX: number, clientY: number) => { const rb = svg.getBoundingClientRect(); return { cx: clamp(Math.floor((clientX - rb.left) / cellPx), nx), cy: clamp(Math.floor((clientY - rb.top) / cellPx), ny) }; };
    const applyRange = async (cx0: number, cy0: number, cx1: number, cy1: number) => {
      const set = cellsSet(), occ = occSet();
      const add = !set.has(cx0 + "," + cy0);   // mode déduit de la 1re cellule
      let skipped = 0;
      for (let cx = Math.min(cx0, cx1); cx <= Math.max(cx0, cx1); cx++)
        for (let cy = Math.min(cy0, cy1); cy <= Math.max(cy0, cy1); cy++) {
          const k = cx + "," + cy;
          if (add) set.add(k); else { if (occ.has(k)) { skipped++; continue; } set.delete(k); }
        }
      await store.update("racks", rack.id, (face === "floor") ? { floor_cells: [...set] } : { roof_cells: [...set] });
      host.setDirty?.(true);
      if (skipped) Notify.toast(skipped + " cellule(s) conservée(s) : un pin y est posé.", "err");
      draw();
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return; e.preventDefault();
      const c0 = cellAt(e.clientX, e.clientY);
      prevRect = mk("rect", { class: "cap-cell-sel-preview", x: c0.cx * cellPx, y: c0.cy * cellPx, width: cellPx, height: cellPx });
      svg.appendChild(prevRect);
      let c1 = c0;
      const drawSel = (c: { cx: number; cy: number }) => { const x0 = Math.min(c0.cx, c.cx), y0 = Math.min(c0.cy, c.cy); prevRect!.setAttribute("x", String(x0 * cellPx)); prevRect!.setAttribute("y", String(y0 * cellPx)); prevRect!.setAttribute("width", String((Math.abs(c.cx - c0.cx) + 1) * cellPx)); prevRect!.setAttribute("height", String((Math.abs(c.cy - c0.cy) + 1) * cellPx)); };
      const move = (ev: MouseEvent) => { c1 = cellAt(ev.clientX, ev.clientY); drawSel(c1); };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); if (prevRect) { prevRect.remove(); prevRect = null; } applyRange(c0.cx, c0.cy, c1.cx, c1.cy); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
    function draw(): void {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const auth = cellsSet(), occ = occSet();
      auth.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; svg.appendChild(mk("rect", { x: cx * cellPx, y: cy * cellPx, width: cellPx, height: cellPx, class: "cap-cell-auth" })); });
      occ.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; const mx = (cx + 0.5) * cellPx, my = (cy + 0.5) * cellPx, rr = cellPx * 0.3; svg.appendChild(mk("polygon", { points: `${mx},${my - rr} ${mx + rr},${my} ${mx},${my + rr} ${mx - rr},${my}`, class: "cap-cell-pin" })); });
      for (let i = 0; i <= nx; i++) svg.appendChild(mk("line", { x1: i * cellPx, y1: 0, x2: i * cellPx, y2: Hh, class: "cap-grid-line" }));
      for (let j = 0; j <= ny; j++) svg.appendChild(mk("line", { x1: 0, y1: j * cellPx, x2: W, y2: j * cellPx, class: "cap-grid-line" }));
      svg.appendChild(mk("line", { x1: 0, y1: 1, x2: W, y2: 1, class: "cap-grid-front" }));   // bord supérieur = face AVANT
      const ov = mk("rect", { x: 0, y: 0, width: W, height: Hh, class: "cap-grid-ov" });
      ov.addEventListener("mousedown", onDown as EventListener);
      svg.appendChild(ov);
    }
    draw();
    return { el: wrap, refresh: draw };
  }

  /** Réseau logique (data/power). */
  static network(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("networks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", "ex. VLAN-Prod, Stockage…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    let color: string | null = net ? net.color : null;
    root.appendChild(FormControls.fieldRow("Couleur", ColorPalette.build(color, (c) => { color = c; }), "Colore les liens dans la topologie."));
    const kindSel = FormControls.select([{ value: "data", label: "Data" }, { value: "power", label: "Power (alimentation)" }], net ? (net.kind === "power" ? "power" : "data") : "data");
    root.appendChild(FormControls.fieldRow("Type", kindSel, "Data = réseau logique (VLAN…) · Power = circuit d'alimentation."));

    const voltI = FormControls.number((net && net.voltage != null) ? net.voltage : "", { min: 0, step: 1, placeholder: "ex. 230" });
    const ampI = FormControls.number((net && net.max_amp != null) ? net.max_amp : "", { min: 0, step: 1, placeholder: "ex. 16" });
    const srcSel = FormControls.select([{ value: "", label: "— non précisé —" }].concat(POWER_SOURCES.map((s) => ({ value: s.id, label: s.label }))), net ? (net.power_source || "") : "");
    const powerBox = document.createElement("div");
    const rowP = document.createElement("div"); rowP.className = "form-row";
    rowP.appendChild(FormControls.fieldRow("Tension (V)", voltI)); rowP.appendChild(FormControls.fieldRow("Capacité max (A)", ampI));
    powerBox.appendChild(rowP);
    powerBox.appendChild(FormControls.fieldRow("Alimentation", srcSel, "UPS, UPS + groupe, ou réseau seul."));
    root.appendChild(powerBox);

    const ipOpts = [{ value: "", label: "— aucun (réseau purement logique) —" }].concat(
      store.all("ipNetworks").slice().sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || "")).map((n: any) => ({ value: n.id, label: n.label || n.cidr || "(réseau IP)" })));
    const ipSel = FormControls.select(ipOpts, net ? (net.ip_network_id || "") : "");
    const ipField = FormControls.fieldRow("Réseau IP (réel)", ipSel, "Associe ce réseau logique à un sous-réseau de l'IPAM.");
    root.appendChild(ipField);

    const syncKind = () => { const power = kindSel.value === "power"; powerBox.style.display = power ? "" : "none"; ipField.style.display = power ? "none" : ""; };
    kindSel.addEventListener("change", syncKind); syncKind();
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: net ? "Modifier le réseau" : "Nouveau réseau",
      subtitle: net ? Html.escape(net.label) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        const power = kindSel.value === "power";
        const payload = {
          label, color: color || null, kind: power ? "power" : "data",
          ip_network_id: power ? null : (ipSel.value || null),
          voltage: power && voltI.value !== "" ? Math.max(0, parseInt(voltI.value, 10) || 0) : null,
          max_amp: power && ampI.value !== "" ? Math.max(0, parseInt(ampI.value, 10) || 0) : null,
          power_source: power ? (srcSel.value || null) : null,
          description: descI.value.trim(),
        };
        if (net) await store.update("networks", net.id, payload); else await store.create("networks", payload);
        host.setDirty?.(true); Notify.toast(net ? "Réseau mis à jour" : "Réseau créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Demande un fichier image à l'utilisateur (input file, JPEG/PNG/WebP). */
  private static promptImageFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp"; inp.style.display = "none";
      inp.onchange = () => { const f = inp.files && inp.files[0] ? inp.files[0] : null; inp.remove(); resolve(f); };
      document.body.appendChild(inp); inp.click();
    });
  }
  private static validImageFile(f: File | null): File | null {
    if (!f) return null;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { Notify.toast("Format non supporté (PNG / JPEG / WebP).", "err"); return null; }
    return f;
  }

  /** Image de façade (bibliothèque IndexedDB hors modèle) : import/remplacement + métadonnées (U, face). */
  static faceImage(images: ImageStore, store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const fi: any = id ? images.get(id) : null;
    let imgBlob: Blob | null = null, previewUrl: string | null = fi ? fi.url : null, tempUrl: string | null = null;
    const root = document.createElement("div");
    const previewWrap = document.createElement("div"); previewWrap.className = "fi-form-preview";
    const previewImg = document.createElement("img");
    const previewEmpty = document.createElement("div"); previewEmpty.className = "fi-form-empty"; previewEmpty.textContent = "Aucune image importée";
    previewWrap.append(previewImg, previewEmpty);
    const importBtn = document.createElement("button"); importBtn.type = "button"; importBtn.className = "btn btn-ghost btn-sm";
    const nameI = FormControls.text(fi ? fi.name : "", "ex. Switch 48p — avant");
    const syncPreview = () => {
      if (previewUrl) { previewImg.src = previewUrl; previewImg.style.display = ""; previewEmpty.style.display = "none"; }
      else { previewImg.removeAttribute("src"); previewImg.style.display = "none"; previewEmpty.style.display = ""; }
      importBtn.textContent = previewUrl ? "Remplacer le fichier…" : "Importer une image…";
    };
    importBtn.onclick = async () => {
      const f = Forms.validImageFile(await Forms.promptImageFile()); if (!f) return;
      imgBlob = f;
      if (tempUrl) URL.revokeObjectURL(tempUrl);
      tempUrl = URL.createObjectURL(f); previewUrl = tempUrl;
      if (!nameI.value.trim() && f.name) nameI.value = f.name.replace(/\.[^.]+$/, "");
      syncPreview();
    };
    root.appendChild(FormControls.fieldRow("Image", previewWrap, "JPEG / PNG / WebP. Stockée une seule fois et partagée par référence."));
    const importRow = document.createElement("div"); importRow.style.marginBottom = "10px"; importRow.appendChild(importBtn); root.appendChild(importRow);
    root.appendChild(FormControls.fieldRow("Nom", nameI));
    const uI = FormControls.number(fi ? (fi.u_height || 1) : 1, { min: 1, step: 1 });
    root.appendChild(FormControls.fieldRow("Hauteur (U)", uI, "Éligibilité : l'image n'est proposée que sur les équipements de ce nombre de U."));
    const faceI = FormControls.select([{ value: "front", label: "Avant" }, { value: "rear", label: "Arrière" }, { value: "autre", label: "Autre (faces annexes)" }], fi ? fi.face : "front");
    root.appendChild(FormControls.fieldRow("Face", faceI, "« Avant »/« Arrière » : proposées sur la face correspondante (filtre U). « Autre » : faces annexes des équipements en dimensionnement libre, sans contrainte de U."));
    const descI = FormControls.textArea(fi ? fi.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    if (fi) { const uses = store.faceImageUsageCount(fi.id); const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Utilisée par " + uses + " équipement" + (uses > 1 ? "s" : "") + ". Modifier U/face n'affecte que les futurs choix ; les références existantes restent."; root.appendChild(h); }
    syncPreview();
    host.openModal({
      title: fi ? "Modifier l'image de façade" : "Nouvelle image de façade",
      subtitle: fi ? Html.escape(fi.name || "") : "Importez une image et définissez sa hauteur (U) et sa face.",
      body: root,
      onSave: async () => {
        if (!fi && !imgBlob) { Notify.toast("Importez d'abord une image.", "err"); return false; }
        const meta = { name: nameI.value.trim(), u_height: Math.max(1, parseInt(uI.value, 10) || 1), face: (faceI.value === "rear") ? "rear" : (faceI.value === "autre" ? "autre" : "front"), description: descI.value.trim() };
        if (fi) {
          if (imgBlob) { const n = store.faceImageUsageCount(fi.id); if (n > 1) { const ok = await Dialog.confirm({ title: "Remplacer le fichier", message: "Cette image est utilisée par " + n + " équipements. Le nouveau fichier les mettra tous à jour.", confirmLabel: "Remplacer" }); if (!ok) return false; } }
          await images.update(fi.id, imgBlob ? Object.assign({}, meta, { blob: imgBlob, type: imgBlob.type }) : meta);
        } else { await images.add(Object.assign({}, meta, { blob: imgBlob, type: (imgBlob as Blob).type })); }
        if (tempUrl) URL.revokeObjectURL(tempUrl);
        host.setDirty?.(true); Notify.toast(fi ? "Image mise à jour" : "Image ajoutée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!fi) importBtn.focus(); else nameI.focus(); }, 30);
  }

  /** Groupe d'équipements (stack/system/general). */
  static group(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const grp: any = id ? store.get("groups", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(grp ? grp.label : "", "ex. Cœur de réseau, Salle A…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    const typeI = FormControls.select(GroupTypes.ALL.map((t) => ({ value: t.id, label: t.label })), grp ? (grp.type || GroupTypes.DEFAULT) : GroupTypes.DEFAULT);
    root.appendChild(FormControls.fieldRow("Type", typeI, "Stack · System (ex. SAN) · General."));
    let color: string | null = grp ? grp.color : null;
    root.appendChild(FormControls.fieldRow("Couleur", ColorPalette.build(color, (c) => { color = c; }), "Identifie le groupe dans les listes et la topologie."));
    const descI = FormControls.textArea(grp ? grp.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: grp ? "Modifier le groupe" : "Nouveau groupe",
      subtitle: grp ? Html.escape(grp.label) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        const payload = { label, type: typeI.value || GroupTypes.DEFAULT, color: color || null, description: descI.value.trim() };
        if (grp) await store.update("groups", grp.id, payload); else await store.create("groups", payload);
        host.setDirty?.(true); Notify.toast(grp ? "Groupe mis à jour" : "Groupe créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Spare (pièce de rechange) — formulaire DYNAMIQUE : champs communs + bloc spécifique au type
      (HDD/SSD · transceiver · autre) + attribution conditionnelle (statut « attribué » → équipement OU texte libre). */
  static spare(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const sp: any = id ? store.get("spares", id) : null;
    const root = document.createElement("div");
    const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

    // -- type + identité --
    const typeI = FormControls.select(SpareTypes.ALL.map((t) => ({ value: t.id, label: t.icon + " " + t.label })), sp ? sp.type : SpareTypes.DEFAULT);
    const nameI = FormControls.text(sp ? sp.name : "", "désignation (sinon dérivée du modèle)");
    root.appendChild(row2(FormControls.fieldRow("Type", typeI), FormControls.fieldRow("Désignation", nameI)));
    const brandI = FormControls.text(sp ? sp.brand : "", "ex. Seagate, Cisco, Intel…");
    const pnI = FormControls.text(sp ? sp.model_pn : "", "modèle / part-number");
    root.appendChild(row2(FormControls.fieldRow("Marque", brandI), FormControls.fieldRow("Modèle / PN", pnI)));
    const serialI = FormControls.text(sp ? sp.serial : "", "n° de série (unitaire)");
    root.appendChild(FormControls.fieldRow("Numéro de série", serialI));

    // -- bloc DISQUE (HDD/SSD) --
    const diskBlock = document.createElement("div");
    diskBlock.appendChild(divider("Caractéristiques disque"));
    const capValI = FormControls.number(sp ? sp.capacity_value : "", { min: 0, step: 1, placeholder: "capacité" });
    const capUnitI = FormControls.select(SPARE_CAP_UNITS.map((u) => ({ value: u, label: u === "GB" ? "Go" : "To" })), sp ? sp.capacity_unit : "GB");
    const ifaceI = FormControls.text(sp ? sp.interface : "", "SATA / SAS / NVMe…");
    root.appendChild(FormControls.attachDatalist(ifaceI, "sp-iface", SPARE_HDD_INTERFACES));
    const fmtI = FormControls.text(sp ? sp.form_factor : "", '3.5" / 2.5" / M.2…');
    root.appendChild(FormControls.attachDatalist(fmtI, "sp-fmt", SPARE_HDD_FORMATS));
    diskBlock.appendChild(row2(FormControls.fieldRow("Capacité", capValI), FormControls.fieldRow("Unité", capUnitI), FormControls.fieldRow("Interface", ifaceI), FormControls.fieldRow("Format", fmtI)));
    const rpmI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_HDD_RPM.map((r) => ({ value: String(r), label: r + " rpm" }))), sp && sp.rpm != null ? String(sp.rpm) : "");
    const rpmRow = FormControls.fieldRow("RPM", rpmI, "Vitesse de rotation (HDD uniquement).");
    diskBlock.appendChild(rpmRow);
    root.appendChild(diskBlock);

    // -- bloc TRANSCEIVER --
    const txBlock = document.createElement("div");
    txBlock.appendChild(divider("Caractéristiques transceiver"));
    const txFormI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_TX_FORMS.map((f) => ({ value: f, label: f }))), sp ? sp.tx_form : "");
    const txSpeedI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_TX_SPEEDS.map((s) => ({ value: s, label: s }))), sp ? sp.tx_speed : "");
    const txMediaI = FormControls.text(sp ? sp.tx_media : "", "LC / RJ45 / DAC / AOC…");
    root.appendChild(FormControls.attachDatalist(txMediaI, "sp-txmedia", SPARE_TX_MEDIA));
    txBlock.appendChild(row2(FormControls.fieldRow("Form factor", txFormI), FormControls.fieldRow("Débit", txSpeedI), FormControls.fieldRow("Média / connecteur", txMediaI)));
    const txReachI = FormControls.text(sp ? sp.tx_reach : "", "ex. SR · LR · 1310nm · 10km");
    txBlock.appendChild(FormControls.fieldRow("Portée / longueur d'onde", txReachI));
    root.appendChild(txBlock);

    // -- bloc AUTRE --
    const otherBlock = document.createElement("div");
    otherBlock.appendChild(divider("Caractéristiques"));
    const specsI = FormControls.textArea(sp ? sp.specs : "");
    otherBlock.appendChild(FormControls.fieldRow("Spécifications", specsI, "Caractéristiques en texte libre."));
    root.appendChild(otherBlock);

    // -- statut + attribution --
    root.appendChild(divider("Statut"));
    const statusI = FormControls.select(SpareStatuses.ALL.map((s) => ({ value: s.id, label: s.label })), sp ? sp.status : SpareStatuses.DEFAULT);
    root.appendChild(FormControls.fieldRow("Statut", statusI));
    const assignBlock = document.createElement("div");
    const eqOpts = [{ value: "", label: "— libre / non précisé —" }].concat(
      store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })),
    );
    const eqI = FormControls.select(eqOpts, sp ? (sp.assigned_equipment_id || "") : "");
    const freeI = FormControls.text(sp ? sp.assigned_free : "", "utilisateur / équipement hors gestion");
    assignBlock.appendChild(row2(FormControls.fieldRow("Équipement affecté", eqI, "Ou laissez « libre » et renseignez le champ ci-contre."), FormControls.fieldRow("Attribution libre", freeI)));
    const assignDateI: any = FormControls.date(sp ? sp.assigned_date : "");
    assignBlock.appendChild(FormControls.fieldRow("Date d'attribution", assignDateI));
    root.appendChild(assignBlock);

    // -- administratif --
    root.appendChild(divider("Administratif"));
    const purchaseI: any = FormControls.date(sp ? sp.purchase_date : "");
    const poI = FormControls.text(sp ? sp.po_ref : "", "réf. bon de commande");
    root.appendChild(row2(FormControls.fieldRow("Date d'achat", purchaseI), FormControls.fieldRow("Bon de commande", poI)));
    const storageI = FormControls.text(sp ? sp.storage_location : "", "ex. Armoire B · étagère 3 · bac 12");
    root.appendChild(FormControls.fieldRow("Emplacement de stockage", storageI));
    const commentI = FormControls.textArea(sp ? sp.comment : "");
    root.appendChild(FormControls.fieldRow("Commentaire", commentI));

    // -- visibilité dynamique --
    const syncType = () => {
      const t = typeI.value;
      const disk = SPARE_DISK_TYPES.includes(t);
      diskBlock.style.display = disk ? "" : "none";
      txBlock.style.display = (t === "transceiver") ? "" : "none";
      otherBlock.style.display = (t === "other") ? "" : "none";
      rpmRow.style.display = (t === "hdd") ? "" : "none";   // RPM = HDD seulement
    };
    const syncStatus = () => {
      const assigned = statusI.value === "assigned";
      assignBlock.style.display = assigned ? "" : "none";
      if (assigned && !assignDateI.value) assignDateI.value = today();   // pose la date d'attribution par défaut
    };
    typeI.onchange = syncType; statusI.onchange = syncStatus;
    eqI.onchange = () => { if (eqI.value) freeI.value = ""; };   // un équipement choisi → vide l'attribution libre
    syncType(); syncStatus();

    host.openModal({
      title: sp ? "Modifier la pièce" : "Nouvelle pièce (spare)",
      subtitle: sp ? Html.escape(sp.displayName ? sp.displayName() : (sp.name || "")) : "",
      body: root,
      onSave: async () => {
        const type = typeI.value || SpareTypes.DEFAULT;
        const status = statusI.value || SpareStatuses.DEFAULT;
        const eqId = eqI.value || null;
        const payload: any = {
          type, name: nameI.value.trim(), brand: brandI.value.trim(), model_pn: pnI.value.trim(), serial: serialI.value.trim(),
          status,
          assigned_equipment_id: status === "assigned" ? eqId : null,
          assigned_free: status === "assigned" && !eqId ? freeI.value.trim() : "",
          assigned_date: status === "assigned" ? assignDateI.value : "",
          purchase_date: purchaseI.value, po_ref: poI.value.trim(), storage_location: storageI.value.trim(), comment: commentI.value.trim(),
          // disque
          capacity_value: SPARE_DISK_TYPES.includes(type) && capValI.value !== "" ? +capValI.value : null,
          capacity_unit: capUnitI.value || "GB",
          interface: SPARE_DISK_TYPES.includes(type) ? ifaceI.value.trim() : "",
          form_factor: SPARE_DISK_TYPES.includes(type) ? fmtI.value.trim() : "",
          rpm: type === "hdd" && rpmI.value ? +rpmI.value : null,
          // transceiver
          tx_form: type === "transceiver" ? txFormI.value : "",
          tx_speed: type === "transceiver" ? txSpeedI.value : "",
          tx_media: type === "transceiver" ? txMediaI.value.trim() : "",
          tx_reach: type === "transceiver" ? txReachI.value.trim() : "",
          // autre
          specs: type === "other" ? specsI.value.trim() : "",
        };
        if (sp) await store.update("spares", sp.id, payload); else await store.create("spares", payload);
        host.setDirty?.(true); Notify.toast(sp ? "Pièce mise à jour" : "Pièce créée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Équipement — formulaire CŒUR (identité · admin · groupe · dimensions · placement rack ·
      ports/agrégats · breakout trunk→lanes · éditeur de façade : pose des ports sur les faces).
      DIFFÉRÉ : placement latéral/paroi/étage et la BIBLIOTHÈQUE d'images de façade (IndexedDB) —
      les références d'image existantes sont préservées/détachables. */
  static equipment(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const eq: any = id ? store.get("equipments", id) : null;
    // brouillons (ids réels → FK ports↔agrégats tiennent avant l'enregistrement)
    const draftAggs: any[] = eq ? store.aggregatesOf(eq.id).map((a: any) => ({ id: a.id, name: a.name, description: a.description })) : [];
    const draftPorts: any[] = eq ? store.portsOf(eq.id).map((p: any) => ({
      id: p.id, name: p.name, port_type_id: p.port_type_id, role: p.role, aggregate_id: p.aggregate_id, description: p.description,
      parent_port_id: p.parent_port_id || null, lane: (p.lane != null) ? p.lane : null, face_x: p.face_x, face_y: p.face_y, face_side: p.face_side,
    })) : [];
    // brouillon des images de façade (référence par face) — l'éditeur de façade les reporte ici.
    const faceFids: Record<string, string | null> = {};
    EQUIP_FACE_IDS.forEach((f) => { faceFids[f] = eq ? (eq[EQUIP_FACE_IMG_FIELD[f]] || null) : null; });
    const root = document.createElement("div");

    // -- identité --
    const nameI = FormControls.text(eq ? eq.name : "", "ex. sw-core-01");
    const curType = eq ? (eq.type || EQUIPMENT_TYPE_DEFAULT) : EQUIPMENT_TYPE_DEFAULT;
    let typeOpts = EquipmentTypes.ALL.map((t) => ({ value: t.id, label: t.label }));
    if (curType && !EquipmentTypes.ALL.some((t) => t.id === curType)) typeOpts = [{ value: curType, label: curType + " (hors liste)" }, ...typeOpts];
    const typeI = FormControls.select(typeOpts, curType);
    root.appendChild(row2(FormControls.fieldRow("Nom", nameI), FormControls.fieldRow("Type", typeI)));

    const invI = FormControls.toggle("Inventaire seul", eq ? !!eq.inventory_only : false, () => sync(), { block: true, title: "Répertorié uniquement : ni placement, ni câblage, ni ports." });
    root.appendChild(invI);
    const brandI = FormControls.text(eq ? eq.brand : "", "ex. Cisco, Dell…");
    const modelI = FormControls.text(eq ? eq.model : "", "ex. Catalyst 2960…");
    root.appendChild(row2(FormControls.fieldRow("Marque", brandI), FormControls.fieldRow("Modèle", modelI)));
    const serialI = FormControls.text(eq ? eq.serial : "", "n° de série");
    root.appendChild(FormControls.fieldRow("Numéro de série", serialI));

    // -- administratif --
    root.appendChild(divider("Administratif"));
    const purchaseI = FormControls.date(eq ? eq.purchase_date : "");
    const warrantyI = FormControls.date(eq ? eq.warranty_end : "");
    const poI = FormControls.text(eq ? eq.po_ref : "", "réf. bon de commande");
    root.appendChild(row2(FormControls.fieldRow("Date d'achat", purchaseI), FormControls.fieldRow("Fin de garantie", warrantyI), FormControls.fieldRow("Bon de commande", poI)));
    const assignDateI = FormControls.date(eq ? eq.assigned_date : "");
    const assignToI = FormControls.text(eq ? eq.assigned_to : "", "nom de la personne");
    root.appendChild(row2(FormControls.fieldRow("Date d'attribution", assignDateI), FormControls.fieldRow("Attribué à", assignToI)));
    const pduI = FormControls.number((eq && eq.pdu_max_a != null) ? eq.pdu_max_a : "", { min: 0, step: 1, placeholder: "ampères" });
    const pduRow = FormControls.fieldRow("Capacité max PDU (A)", pduI, "Pour les bandeaux d'alimentation.");
    root.appendChild(pduRow);

    const grpOpts = [{ value: "", label: "— aucun —" }].concat(store.all("groups").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || "")).map((g: any) => ({ value: g.id, label: g.label || "(sans label)" })));
    const groupI = FormControls.select(grpOpts, eq && eq.group_id ? eq.group_id : "");
    root.appendChild(FormControls.fieldRow("Groupe", groupI, "Gérés dans l'onglet Groupes."));
    const descI = FormControls.textArea(eq ? eq.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    // -- dimensions + placement (sections « avancées », masquées en inventaire) --
    const adv = document.createElement("div");
    adv.appendChild(divider("Dimensions"));
    const dimI = FormControls.select([{ value: "u", label: "En U (rack)" }, { value: "free", label: "Libre (L × l × h en mm)" }], eq ? (eq.dim_mode === "free" ? "free" : "u") : "u");
    adv.appendChild(FormControls.fieldRow("Dimensionnement", dimI));
    // U
    const uBox = document.createElement("div");
    const uHI = FormControls.number(eq ? eq.u_height : 1, { min: 1, step: 1 });
    const depthI = FormControls.select(Depths.ALL.map((d) => ({ value: d.id, label: d.label })), eq && ["full", "half", "quarter"].includes(eq.depth) ? eq.depth : "full");
    uBox.appendChild(row2(FormControls.fieldRow("Hauteur (U)", uHI), FormControls.fieldRow("Profondeur", depthI)));
    adv.appendChild(uBox);
    // libre
    const freeBox = document.createElement("div");
    const flI = FormControls.number((eq && eq.free_l_mm != null) ? eq.free_l_mm : "", { min: 0, step: 1, placeholder: "longueur" });
    const fwI = FormControls.number((eq && eq.free_w_mm != null) ? eq.free_w_mm : "", { min: 0, step: 1, placeholder: "largeur" });
    const fhI = FormControls.number((eq && eq.free_h_mm != null) ? eq.free_h_mm : "", { min: 0, step: 1, placeholder: "hauteur" });
    freeBox.appendChild(row2(FormControls.fieldRow("Longueur (mm)", flI), FormControls.fieldRow("Largeur (mm)", fwI), FormControls.fieldRow("Hauteur (mm)", fhI)));
    adv.appendChild(freeBox);

    // placement rack (mode U seulement, dans ce cœur)
    const placeBox = document.createElement("div");
    placeBox.appendChild(divider("Placement (rack)"));
    const rackOpts = [{ value: "", label: "— non placé —" }].concat(store.all("racks").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((r: any) => ({ value: r.id, label: r.name || "(baie)" })));
    const rackI = FormControls.select(rackOpts, eq && eq.placement_mode === "rack" && eq.rack_id ? eq.rack_id : "");
    const rackUI = FormControls.number((eq && eq.rack_u != null) ? eq.rack_u : "", { min: 1, step: 1, placeholder: "U de bas (vide = libre)" });
    placeBox.appendChild(row2(FormControls.fieldRow("Baie", rackI), FormControls.fieldRow("Position (U)", rackUI)));
    const placeHint = document.createElement("div"); placeHint.className = "form-hint";
    placeHint.textContent = "Placement latéral / paroi / sur étage : à venir (préservé pour les équipements existants).";
    placeBox.appendChild(placeHint);
    adv.appendChild(placeBox);

    // -- agrégats (LAG / bond) --
    adv.appendChild(divider("Agrégats (LAG / bond)"));
    const aggList = document.createElement("div"); aggList.className = "chip-list"; adv.appendChild(aggList);
    const addAggBtn = document.createElement("button"); addAggBtn.type = "button"; addAggBtn.className = "btn btn-ghost btn-sm"; addAggBtn.textContent = "+ Agrégat"; addAggBtn.style.marginTop = "8px"; adv.appendChild(addAggBtn);

    // -- ports (+ breakout : trunk éclaté en N lanes ; + façade : pose des ports sur les faces) --
    const portDiv = document.createElement("div"); portDiv.className = "section-divider"; portDiv.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;";
    const portDivLabel = document.createElement("span"); portDivLabel.textContent = "Ports"; portDiv.appendChild(portDivLabel);
    if (eq) {   // sous-éditeur empilé opérant sur le brouillon (ports en cours d'ajout présents)
      const faceBtn = document.createElement("button"); faceBtn.type = "button"; faceBtn.className = "btn btn-ghost btn-sm"; faceBtn.textContent = "Façade…";
      faceBtn.title = "Disposer les ports sur la façade (y compris ceux que vous venez d'ajouter)";
      faceBtn.onclick = () => Forms.faceEditor(store, host, eq.id, {
        ports: draftPorts, fids: faceFids,
        onApply: ({ fids, place }: any) => {
          EQUIP_FACE_IDS.forEach((f) => { if (f in fids) faceFids[f] = fids[f]; });
          draftPorts.forEach((p) => { if (p.parent_port_id) return; const pos = place[p.id]; if (pos) { p.face_x = pos.x; p.face_y = pos.y; p.face_side = pos.side; } else { p.face_x = null; p.face_y = null; } });
          host.setDirty?.(true); Notify.toast("Façade appliquée — enregistrez l'équipement pour conserver");
        },
      });
      portDiv.appendChild(faceBtn);
    }
    adv.appendChild(portDiv);
    const portList = document.createElement("div"); portList.className = "chip-list"; adv.appendChild(portList);
    const portBtns = document.createElement("div"); portBtns.style.cssText = "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;";
    const addPortBtn = document.createElement("button"); addPortBtn.type = "button"; addPortBtn.className = "btn btn-ghost btn-sm"; addPortBtn.textContent = "+ Port";
    const addBreakoutBtn = document.createElement("button"); addBreakoutBtn.type = "button"; addBreakoutBtn.className = "btn btn-ghost btn-sm"; addBreakoutBtn.textContent = "+ Breakout";
    addBreakoutBtn.title = "Port trunk (ex. QSFP+) éclaté en N lanes (ex. 4× SFP+)";
    portBtns.append(addPortBtn, addBreakoutBtn); adv.appendChild(portBtns);

    const isDraftTrunk = (p: any) => draftPorts.some((c) => c.parent_port_id === p.id);
    const ptKind = (t: any) => (t && t.kind === "power") ? "power" : "data";
    const ptOptions = (selected: string | null, role: string) => {
      const kind = PortRoles.kind(role);
      const list = store.all("portTypes").filter((t: any) => ptKind(t) === kind).sort((a: any, b: any) => a.name.localeCompare(b.name));
      const opts = [{ value: "", label: "— type ? —" }].concat(list.map((t: any) => ({ value: t.id, label: t.name + " · " + t.family })));
      if (selected && !list.some((t: any) => t.id === selected)) { const cur: any = store.get("portTypes", selected); if (cur) opts.push({ value: cur.id, label: cur.name + " · " + cur.family + " (hors rôle)" }); }
      return FormControls.select(opts, selected || "");
    };
    const aggOptionsFor = (p: any) => FormControls.select([{ value: "", label: "— aucun —" }].concat(draftAggs.map((a) => ({ value: a.id, label: a.name || "(agrégat)" }))), p.aggregate_id || "");
    const bump = (s: string) => { s = String(s || ""); const m = s.match(/^(.*?)(\d+)(\D*)$/); return m ? m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, "0") + m[3] : (s ? s + "2" : ""); };

    const renderAggs = () => {
      aggList.innerHTML = "";
      if (!draftAggs.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun agrégat."; aggList.appendChild(e); }
      draftAggs.forEach((a, idx) => {
        const r = document.createElement("div"); r.className = "chip-row";
        const nm = document.createElement("input"); nm.className = "sub-input grow"; nm.value = a.name; nm.placeholder = "nom (ex. bond0)"; nm.oninput = () => { a.name = nm.value; };
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×";
        rm.onclick = () => { const removed = draftAggs.splice(idx, 1)[0]; draftPorts.forEach((p) => { if (p.aggregate_id === removed.id) p.aggregate_id = null; }); renderAggs(); renderPorts(); };
        r.appendChild(nm); r.appendChild(rm); aggList.appendChild(r);
      });
    };
    const portRow = (p: any, kind: string) => {
      const locked = kind === "trunk" || kind === "lane";
      const r = document.createElement("div"); r.className = "chip-row";
      if (kind === "lane") r.style.cssText = "margin-left:18px;border-left:2px solid var(--line-2);padding-left:8px;";
      const nm = document.createElement("input"); nm.className = "sub-input grow"; nm.value = p.name; nm.placeholder = kind === "trunk" ? "trunk" : (kind === "lane" ? "lane" : "ex. Eth1/1"); nm.oninput = () => { p.name = nm.value; };
      r.appendChild(nm);
      if (locked) {
        const rPill = document.createElement("span"); rPill.className = "pill"; rPill.textContent = PortRoles.label(p.role);
        const tt: any = p.port_type_id ? store.get("portTypes", p.port_type_id) : null;
        const tPill = document.createElement("span"); tPill.className = "pill"; tPill.textContent = tt ? tt.name : "type ?";
        r.appendChild(rPill); r.appendChild(tPill);
      } else {
        const rl = FormControls.select(PortRoles.ALL.map((x) => ({ value: x.id, label: x.label })), p.role || "data"); rl.className = "sub-input app-select";
        const pt = ptOptions(p.port_type_id, p.role); pt.className = "sub-input app-select";
        rl.onchange = () => { p.role = rl.value; const cur: any = p.port_type_id ? store.get("portTypes", p.port_type_id) : null; if (cur && ptKind(cur) !== PortRoles.kind(p.role)) p.port_type_id = null; if (PortRoles.kind(p.role) === "power") p.aggregate_id = null; renderPorts(); };
        pt.onchange = () => { p.port_type_id = pt.value || null; renderPorts(); };
        r.appendChild(rl); r.appendChild(pt);
      }
      if (kind === "trunk") {
        const tag = document.createElement("span"); tag.className = "pill"; tag.textContent = "breakout ×" + draftPorts.filter((c) => c.parent_port_id === p.id).length;
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×"; rm.title = "Supprimer le breakout";
        rm.onclick = () => { const ids = new Set([p.id, ...draftPorts.filter((c) => c.parent_port_id === p.id).map((c) => c.id)]); for (let i = draftPorts.length - 1; i >= 0; i--) if (ids.has(draftPorts[i].id)) draftPorts.splice(i, 1); renderPorts(); };
        r.appendChild(tag); r.appendChild(rm);
      } else if (kind === "lane") {
        const tag = document.createElement("span"); tag.className = "pill"; tag.textContent = "lane " + (p.lane || "?"); r.appendChild(tag);
      } else {
        if (PortRoles.kind(p.role) !== "power") { const ag = aggOptionsFor(p); ag.className = "sub-input app-select"; ag.onchange = () => { p.aggregate_id = ag.value || null; }; r.appendChild(ag); }
        const dup = document.createElement("button"); dup.type = "button"; dup.className = "btn btn-ghost btn-sm"; dup.textContent = "⎘"; dup.title = "Dupliquer";
        dup.onclick = () => { const i = draftPorts.indexOf(p); draftPorts.splice(i + 1, 0, Object.assign({}, p, { id: Id.uid(), name: bump(p.name), face_x: null, face_y: null })); renderPorts(); };
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×";
        rm.onclick = () => { const i = draftPorts.indexOf(p); if (i >= 0) draftPorts.splice(i, 1); renderPorts(); };
        r.appendChild(dup); r.appendChild(rm);
      }
      return r;
    };
    const renderPorts = () => {
      portList.innerHTML = "";
      if (!draftPorts.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun port."; portList.appendChild(e); }
      draftPorts.filter((p) => !p.parent_port_id).forEach((p) => {
        if (isDraftTrunk(p)) { portList.appendChild(portRow(p, "trunk")); draftPorts.filter((c) => c.parent_port_id === p.id).sort((a, b) => (a.lane || 0) - (b.lane || 0)).forEach((l) => portList.appendChild(portRow(l, "lane"))); }
        else portList.appendChild(portRow(p, "normal"));
      });
    };
    addAggBtn.onclick = () => { draftAggs.push({ id: Id.uid(), name: "", description: "" }); renderAggs(); renderPorts(); };
    addPortBtn.onclick = () => { const firstPt: any = store.all("portTypes").find((t: any) => ptKind(t) !== "power") || store.all("portTypes")[0]; draftPorts.push({ id: Id.uid(), name: "", port_type_id: firstPt ? firstPt.id : null, role: "data", aggregate_id: null, description: "" }); renderPorts(); };
    addBreakoutBtn.onclick = () => Forms.configureBreakout(store).then((cfg) => {
      if (!cfg) return;
      host.setDirty?.(true);
      const trunkId = Id.uid();
      draftPorts.push({ id: trunkId, name: cfg.name, port_type_id: cfg.trunkTypeId || null, role: "data", aggregate_id: null, description: "", parent_port_id: null, lane: null });
      for (let i = 1; i <= cfg.count; i++) draftPorts.push({ id: Id.uid(), name: cfg.name + "/" + i, port_type_id: cfg.laneTypeId || null, role: "data", aggregate_id: null, description: "", parent_port_id: trunkId, lane: i });
      renderPorts();
    });
    renderAggs(); renderPorts();

    root.appendChild(adv);

    const sync = () => {
      const inv = (invI as any).checked, u = dimI.value === "u";
      adv.style.display = inv ? "none" : "";
      uBox.style.display = u ? "" : "none";
      freeBox.style.display = u ? "none" : "";
      placeBox.style.display = u ? "" : "none";   // placement rack du cœur = mode U
      pduRow.style.display = (typeI.value === "pdu") ? "" : "none";
    };
    dimI.addEventListener("change", sync); typeI.addEventListener("change", sync); sync();

    host.openModal({
      title: eq ? "Modifier l'équipement" : "Nouvel équipement",
      subtitle: eq ? Html.escape(eq.name || "") : "Équipement, ses ports et agrégats",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const inv = (invI as any).checked, free = dimI.value === "free";
        const payload: any = {
          name, type: typeI.value, brand: brandI.value.trim(), model: modelI.value.trim(), serial: serialI.value.trim(),
          inventory_only: inv, group_id: groupI.value || null, description: descI.value.trim(),
          purchase_date: (purchaseI as any).value || "", warranty_end: (warrantyI as any).value || "", po_ref: poI.value.trim(),
          assigned_date: (assignDateI as any).value || "", assigned_to: assignToI.value.trim(),
          pdu_max_a: pduI.value !== "" ? Math.max(0, parseInt(pduI.value, 10) || 0) : null,
          dim_mode: free ? "free" : "u",
        };
        // images de façade (référence par face) — appliquées via l'éditeur de façade, persistées ici.
        EQUIP_FACE_IDS.forEach((f) => { payload[EQUIP_FACE_IMG_FIELD[f]] = faceFids[f] || null; });
        if (free) {
          payload.free_l_mm = flI.value !== "" ? Math.max(0, parseInt(flI.value, 10) || 0) : null;
          payload.free_w_mm = fwI.value !== "" ? Math.max(0, parseInt(fwI.value, 10) || 0) : null;
          payload.free_h_mm = fhI.value !== "" ? Math.max(0, parseInt(fhI.value, 10) || 0) : null;
          // préserve un placement étage/latéral/paroi existant ; sinon « manuel »
          if (!eq || !["floor", "side", "wall"].includes(eq.placement_mode)) payload.placement_mode = "manual";
        } else {
          payload.u_height = Math.max(1, parseInt(uHI.value, 10) || 1);
          payload.depth = depthI.value;
          payload.placement_mode = "rack";
          payload.rack_id = rackI.value || null;
          payload.rack_u = rackUI.value !== "" ? Math.max(1, parseInt(rackUI.value, 10) || 1) : null;
        }
        let eqId: string;
        if (eq) { await store.update("equipments", eq.id, payload); eqId = eq.id; }
        else { const created: any = await store.create("equipments", payload); eqId = created.id; }

        // -- réconciliation agrégats --
        const draftAggIds = new Set(draftAggs.map((a) => a.id));
        for (const a of draftAggs) {
          const ex: any = store.get("aggregates", a.id);
          if (ex && ex.equipment_id === eqId) await store.update("aggregates", a.id, { name: (a.name || "").trim(), description: (a.description || "").trim() });
          else await store.create("aggregates", { id: a.id, equipment_id: eqId, name: (a.name || "").trim(), description: (a.description || "").trim() });
        }
        for (const a of store.aggregatesOf(eqId)) if (!draftAggIds.has(a.id)) await store.remove("aggregates", a.id);

        // -- réconciliation ports --
        const draftPortIds = new Set(draftPorts.map((p) => p.id));
        for (const p of draftPorts) {
          const agg = p.aggregate_id && draftAggIds.has(p.aggregate_id) ? p.aggregate_id : null;
          const patch: any = { equipment_id: eqId, name: (p.name || "").trim(), port_type_id: p.port_type_id || null, role: p.role || "data", aggregate_id: agg, description: (p.description || "").trim(), parent_port_id: p.parent_port_id || null, lane: (p.lane != null) ? p.lane : null, face_x: (p.face_x != null) ? p.face_x : null, face_y: (p.face_y != null) ? p.face_y : null, face_side: p.face_side };
          const ex: any = store.get("ports", p.id);
          if (ex) await store.update("ports", p.id, patch); else await store.create("ports", Object.assign({ id: p.id }, patch));
        }
        // retirer les lanes AVANT leur trunk (un trunk supprimé cascade ses lanes)
        const toRemove = store.portsOf(eqId).filter((p: any) => !draftPortIds.has(p.id));
        for (const p of toRemove) if (p.parent_port_id) await store.remove("ports", p.id);
        for (const p of toRemove) if (!p.parent_port_id && store.get("ports", p.id)) await store.remove("ports", p.id);

        host.setDirty?.(true); Notify.toast(eq ? "Équipement mis à jour" : "Équipement créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Câble — extrémités (contraintes famille + salle) · type compatible · FAISCEAU (brin → type/route/
      longueur hérités) · réseaux · POINTS DE PASSAGE (waypoints ordonnés, grammaire exit/OOB) · statut.
      `opts` : pré-remplissage (fromPortId/toPortId/fromEqId/bundleId/waypointIds) pour le routage 3D. */
  static cable(store: Store, host: FormHost, id: string | null, onSaved?: () => void, opts: any = {}): void {
    const cable: any = id ? store.get("cables", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(cable ? cable.name : "", "ex. patch-A12");
    root.appendChild(FormControls.fieldRow("Nom du câble", nameI));

    // ---- options d'équipement (contrainte famille + salle) / de port (famille + occupation) ----
    const eqOpts = (fam: string | null, keepEqId: string | null, dcConstraint: any) => {
      let eqs = store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
      if (fam) eqs = eqs.filter((e: any) => e.id === keepEqId || store.portsOf(e.id).some((p: any) => !store.isBreakoutParent(p) && store.portFamily(p) === fam));
      const allowed = dcConstraint ? (Array.isArray(dcConstraint.dcIds) ? dcConstraint.dcIds.filter(Boolean) : (dcConstraint.dcId ? [dcConstraint.dcId] : null)) : null;
      if (dcConstraint && (allowed || dcConstraint.onlyUnplaced)) {
        eqs = eqs.filter((e: any) => {
          if (e.id === keepEqId) return true;
          const dc = store.equipmentDcId(e);
          if (dcConstraint.onlyUnplaced) return !dc;
          return !dc || !allowed || allowed.includes(dc);
        });
      }
      return [{ value: "", label: "— équipement —" }].concat(eqs.map((e: any) => { const dc = store.equipmentDcId(e); return { value: e.id, label: (e.name || "(sans nom)") + (dc ? " · " + store.dcName(dc) : "") }; }));
    };
    const portOpts = (eqId: string, selectedPortId: string | null, fam: string | null) => {
      if (!eqId) return [{ value: "", label: "— choisir un équipement —" }];
      let ports = store.portsOf(eqId).filter((p: any) => !store.isBreakoutParent(p));
      if (fam) ports = ports.filter((p: any) => store.portFamily(p) === fam || p.id === selectedPortId);
      if (!ports.length) return [{ value: "", label: fam ? "(aucun port compatible)" : "(aucun port sur cet équipement)" }];
      ports = ports.slice().sort((a: any, b: any) => ((store.cableOnPort(a.id, cable ? cable.id : null) ? 1 : 0) - (store.cableOnPort(b.id, cable ? cable.id : null) ? 1 : 0)) || (a.name || "").localeCompare(b.name || ""));
      return [{ value: "", label: "— port —" }].concat(ports.map((p: any) => {
        const pt: any = store.get("portTypes", p.port_type_id);
        let label = (p.name || "(port)") + " · " + (pt ? pt.family : "type ?") + " · " + PortRoles.label(p.role);
        if (p.parent_port_id) { const par: any = store.get("ports", p.parent_port_id); label += " · lane de " + (par ? (par.name || "trunk") : "trunk"); }
        const occ = store.cableOnPort(p.id, cable ? cable.id : null);
        if (occ) { const otherId = occ.from_port_id === p.id ? occ.to_port_id : occ.from_port_id; const other: any = store.get("ports", otherId); const otherEq: any = other ? store.get("equipments", other.equipment_id) : null; label += "  — occupé ↔ " + (other ? ((otherEq ? otherEq.name : "?") + " : " + (other.name || "(port)")) : "?"); return { value: p.id, label, disabled: true }; }
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
          const missA = !cable.from_port_id, missB = !cable.to_port_id, dcP = store.equipmentDcId(pp.equipment_id);
          const fits = (side: "A" | "B") => { const k = store.cableSideConstraint(cable, side); return k.onlyUnplaced ? !dcP : (!k.dcId || !dcP || k.dcId === dcP); };
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

    const selEqA = FormControls.select(eqOpts(null, eqA, null), eqA);
    const selPortA = FormControls.select(portOpts(eqA, initPortA || null, null), initPortA);
    root.appendChild(row2(FormControls.fieldRow("Équipement A", selEqA), FormControls.fieldRow("Port A", selPortA)));
    const selEqB = FormControls.select(eqOpts(null, eqB, null), eqB);
    const selPortB = FormControls.select(portOpts(eqB, initPortB || null, null), initPortB);
    root.appendChild(row2(FormControls.fieldRow("Équipement B", selEqB), FormControls.fieldRow("Port B", selPortB)));

    const selType = FormControls.select([{ value: "", label: "— type de câble —" }], cable ? (cable.cable_type_id || "") : "");
    root.appendChild(FormControls.fieldRow("Type de câble", selType, "Déduit du port choisi ; seuls les types COMPATIBLES sont proposés."));

    // ---- faisceau (trunk) : associer = faire un BRIN (type/route/longueur HÉRITÉS) ----
    const bundles = store.all("cableBundles").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const bundleSel = FormControls.select([{ value: "", label: "— aucun (câble autonome) —" }].concat(bundles.map((b: any) => { const occ = store.bundleOccupancy(b.id); const ct: any = b.cable_type_id ? store.get("cableTypes", b.cable_type_id) : null; return { value: b.id, label: (b.name || "(trunk)") + " · " + (ct ? ct.name : "type ?") + " · " + occ.used + "/" + b.fiber_count }; })), cable ? (cable.bundle_id || "") : (opts.bundleId || ""));
    const bundleField = FormControls.fieldRow("Faisceau (trunk)", bundleSel, "Associer = en faire un BRIN : TYPE imposé par le trunk, route et longueur partagées.");
    if (!bundles.length) bundleField.style.display = "none";
    root.appendChild(bundleField);
    const bundleHint = document.createElement("div"); bundleHint.className = "form-hint"; root.appendChild(bundleHint);

    const lenI = FormControls.number((cable && cable.length_m != null) ? cable.length_m : "", { min: 0, step: 0.1, placeholder: "ex. 3" });
    root.appendChild(FormControls.fieldRow("Longueur (m)", lenI, "Longueur physique — optionnelle."));

    // ---- réseaux multiples + principal ----
    const netState = { ids: new Set<string>(store.cableNetworkIds(cable)), primary: cable ? (cable.network_id || null) : null as string | null };
    const netBoxes = document.createElement("div"); netBoxes.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0;";
    const primSel = FormControls.select([{ value: "", label: "— aucun —" }], "");
    const primField = FormControls.fieldRow("Réseau principal", primSel, "Pilote la COULEUR du câble (≥ 2 réseaux).");
    const selectedBundle = () => bundleSel.value ? store.get("cableBundles", bundleSel.value) : null;
    const formTypeId = () => { const b: any = selectedBundle(); return b ? (b.cable_type_id || null) : (selType.value || null); };
    const cableKind = () => { const id2 = formTypeId(); const t: any = id2 ? store.get("cableTypes", id2) : null; return t ? (t.kind === "power" ? "power" : "data") : null; };
    const syncPrimary = () => {
      if (netState.primary && !netState.ids.has(netState.primary)) netState.primary = null;
      if (!netState.primary && netState.ids.size) netState.primary = [...netState.ids][0];
      setOptions(primSel, [{ value: "", label: "— aucun —" }].concat([...netState.ids].map((nid) => { const n: any = store.get("networks", nid); return { value: nid, label: n ? (n.label || "(réseau)") : nid }; })), netState.primary || "");
      primField.style.display = netState.ids.size > 1 ? "" : "none";
    };
    const renderNets = () => {
      const ck = cableKind();
      if (ck != null) [...netState.ids].forEach((nid) => { const n: any = store.get("networks", nid); if (n && (n.kind === "power" ? "power" : "data") !== ck) netState.ids.delete(nid); });
      netBoxes.innerHTML = "";
      const all = store.all("networks").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
      const shown = all.filter((n: any) => ck == null || (n.kind === "power" ? "power" : "data") === ck);
      if (!all.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun réseau (onglet Réseaux)."; netBoxes.appendChild(h); }
      else if (!shown.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun réseau « " + (ck === "power" ? "Power" : "Data") + " »."; netBoxes.appendChild(h); }
      else shown.forEach((n: any) => {
        const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = netState.ids.has(n.id);
        cb.onchange = () => { if (cb.checked) netState.ids.add(n.id); else netState.ids.delete(n.id); syncPrimary(); };
        const sw = document.createElement("span"); sw.className = "swatch-dot"; if (n.color) sw.style.background = n.color;
        const tx = document.createElement("span"); tx.textContent = (n.kind === "power" ? "⚡ " : "") + (n.label || "(réseau)");
        lab.append(cb, sw, tx); netBoxes.appendChild(lab);
      });
      syncPrimary();
    };
    primSel.onchange = () => { netState.primary = primSel.value || null; };
    root.appendChild(FormControls.fieldRow("Réseaux", netBoxes, "Réseaux du même type que le câble. Cochez-en un ou plusieurs."));
    root.appendChild(primField);

    // ---- points de passage : waypoints ORDONNÉS A→B (grammaire exit/OOB) ----
    const wpState = { ids: cable ? (cable.waypoint_ids || []).slice() : ((opts.waypointIds || []).slice()) };
    const WP_CAT_ORDER = ["point", "floor", "segment", "brush", "exit"];
    const WP_CAT_LABEL: Record<string, string> = { point: "◆ Pins de salle", floor: "◎ Pins d'étage", segment: "▬ Chemins de câbles", brush: "▦ Brosses de brassage", exit: "⏏ Exits" };
    const wpCatKey = (wp: any) => Waypoint.typeOf(wp) === "exit" ? "exit" : Waypoint.isFloorLevel(wp) ? "floor" : (wp.kind === "segment" ? "segment" : wp.kind === "brush" ? "brush" : "point");
    const wpLabel = (wp: any) => Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + " · " + (Waypoint.isFloorLevel(wp) ? Waypoint.floorLabel(wp) : (store.waypointIsPlaced(wp) ? store.dcName(wp.datacenter_id) : "non posé"));
    const wpAll = store.all("waypoints")
      .filter((wp: any) => Waypoint.isFloorLevel(wp) || store.waypointIsPlaced(wp) || wpState.ids.includes(wp.id))
      .sort((a: any, b: any) => { const ta = Waypoint.isFloorLevel(a) ? 1 : 0, tb = Waypoint.isFloorLevel(b) ? 1 : 0; if (ta !== tb) return ta - tb; const da = ta ? Waypoint.floorLabel(a) : store.dcName(a.datacenter_id); const db = tb ? Waypoint.floorLabel(b) : store.dcName(b.datacenter_id); return da.localeCompare(db) || (a.name || "").localeCompare(b.name || ""); });
    const wpRouteHint = document.createElement("div"); wpRouteHint.className = "form-hint";
    const wpBoxes = document.createElement("div"); wpBoxes.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:2px 0;";
    const wpOrderBox = document.createElement("div"); wpOrderBox.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:2px 0;";
    const wpField = FormControls.fieldRow("Points de passage", wpBoxes, "Cochés = ajoutés en fin de trajet. ◆ pin de salle · ▬ chemin · ▦ brosse · ⏏ exit (par paires entre salles) · ◎ pin d'étage (hors salles).");
    const wpOrderField = FormControls.fieldRow("Ordre du trajet (A → B)", wpOrderBox, "Réordonnez les points de passage le long du câble.");

    const syncRoute = () => {
      wpRouteHint.classList.remove("err");
      const r = store.cableRoute({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, waypoint_ids: wpState.ids, bundle_id: bundleSel.value || null });
      if (!wpState.ids.length && !bundleSel.value) {
        wpRouteHint.textContent = r.valid ? "Aucun point de passage — le câble reste dans sa salle." : "⚠ " + r.errors[0] + " — pour relier deux salles : ⏏ exit → (◎ pin d'étage…) → ⏏ exit.";
        if (!r.valid) wpRouteHint.classList.add("err");
        return;
      }
      const sum = store.cableRouteSummary(r);
      if (r.valid) wpRouteHint.textContent = "Route : " + sum + " ✓";
      else { wpRouteHint.textContent = "Route : " + (sum ? sum + " — " : "") + "⚠ " + r.errors[0]; wpRouteHint.classList.add("err"); }
    };
    const syncWpOrder = () => {
      wpOrderBox.innerHTML = "";
      wpOrderField.style.display = wpState.ids.length < 2 ? "none" : "";
      if (wpState.ids.length < 2) return;
      wpState.ids.forEach((wid: string, i: number) => {
        const wp: any = store.get("waypoints", wid); if (!wp) return;
        const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;";
        const num = document.createElement("span"); num.className = "pill"; num.textContent = String(i + 1);
        const tx = document.createElement("span"); tx.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"; tx.textContent = wpLabel(wp);
        const mk = (sym: string, d: number, title: string) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = sym; b.title = title; b.disabled = (d < 0 && i === 0) || (d > 0 && i === wpState.ids.length - 1); b.onclick = () => { const j = i + d; wpState.ids.splice(i, 1); wpState.ids.splice(j, 0, wid); syncWpOrder(); syncRoute(); refresh(); syncStatus(true); }; return b; };
        row.append(num, tx, mk("↑", -1, "Plus tôt sur le trajet"), mk("↓", +1, "Plus tard sur le trajet"));
        wpOrderBox.appendChild(row);
      });
    };
    const mkWpCheckbox = (wp: any) => {
      const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = wpState.ids.includes(wp.id);
      cb.onchange = () => {
        if (cb.checked) {
          // EXIT TERMINAL : refuse d'ajouter un waypoint de salle après l'exit de cette salle (le câble doit sortir).
          const bad = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] }).errors.find((e: string) =>
            e.includes("au milieu d'un tronçon hors salle") || e.includes("ré-entrée dans la salle quittée")
            || e.includes("dans une autre salle que le segment courant") || e.includes("la sortie doit être un exit de la salle courante"));
          if (bad) { cb.checked = false; Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir avant tout autre waypoint de salle.", "err"); return; }
          if (!wpState.ids.includes(wp.id)) wpState.ids.push(wp.id);
        } else wpState.ids = wpState.ids.filter((x: string) => x !== wp.id);
        syncWpOrder(); syncRoute(); refresh(); syncStatus(true);
      };
      const tx = document.createElement("span"); tx.textContent = wpLabel(wp); lab.append(cb, tx); return lab;
    };
    if (!wpAll.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun waypoint utilisable (vue Datacenter ; un waypoint de salle doit être POSÉ)."; wpBoxes.appendChild(h); }
    else {
      const byCat: Record<string, any[]> = {}; wpAll.forEach((wp: any) => { const k = wpCatKey(wp); (byCat[k] = byCat[k] || []).push(wp); });
      WP_CAT_ORDER.forEach((k) => {
        const list = byCat[k]; if (!list || !list.length) return;
        const grp = document.createElement("div");
        const hd = document.createElement("div"); hd.className = "form-hint"; hd.style.cssText = "font-weight:600;color:var(--fg);margin:2px 0 1px;"; hd.textContent = WP_CAT_LABEL[k] + " (" + list.length + ")";
        grp.appendChild(hd);
        const row = document.createElement("div"); row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;";
        list.forEach((wp: any) => row.appendChild(mkWpCheckbox(wp)));
        grp.appendChild(row); wpBoxes.appendChild(grp);
      });
    }
    root.appendChild(wpField); root.appendChild(wpRouteHint); root.appendChild(wpOrderField);

    const statusSel = FormControls.select(CableStatuses.ALL.map((s) => ({ value: s.id, label: s.label })), cable ? cable.status : CABLE_STATUS_DEFAULT_NEW);
    root.appendChild(FormControls.fieldRow("Statut", statusSel, "« Brouillon » tant que l'assignation est incomplète OU la route invalide ; « Câblé » exige les 2 bouts posés."));
    const descI = FormControls.textArea(cable ? cable.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    const hint = document.createElement("div"); hint.className = "form-hint"; root.appendChild(hint);

    // ---- contraintes (famille + salle) & cohérence ----
    const familyOf = (portId: string) => store.portFamily(store.get("ports", portId));
    const cableTypeFamily = (ctId: string) => { const ct: any = ctId ? store.get("cableTypes", ctId) : null; return ct ? ct.family : null; };
    const constraintFor = (end: "A" | "B") => { const other = end === "A" ? selPortB.value : selPortA.value; return familyOf(other) || cableTypeFamily(selType.value) || null; };
    const typeFilterFamily = () => familyOf(selPortA.value) || familyOf(selPortB.value) || null;
    const endDcOf = (end: "A" | "B") => { const pid = end === "A" ? selPortA.value : selPortB.value; if (pid) { const p: any = store.get("ports", pid); if (p) return store.equipmentDcId(p.equipment_id); } const eid = end === "A" ? selEqA.value : selEqB.value; return eid ? store.equipmentDcId(eid) : null; };
    const routeRooms = () => { const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: wpState.ids, bundle_id: bundleSel.value || null }); if (!r.valid) return null; if (!r.hasExits) return { intra: true, rooms: [] as string[] }; return { intra: false, rooms: [r.startDc, r.endDc].filter(Boolean) as string[] }; };
    const dcConstraintFor = (end: "A" | "B") => {
      const rr = routeRooms();
      if (!rr) return { dcIds: [] as string[], onlyUnplaced: true };
      const otherRoom = endDcOf(end === "A" ? "B" : "A");
      if (rr.intra) return otherRoom ? { dcIds: [otherRoom], onlyUnplaced: false } : { dcIds: null as any, onlyUnplaced: false };
      let allowed = [...new Set(rr.rooms)];
      if (allowed.length > 1 && otherRoom && allowed.includes(otherRoom)) allowed = allowed.filter((d) => d !== otherRoom);
      return { dcIds: allowed, onlyUnplaced: false };
    };
    const orientEnds = (fromP: string | null, toP: string | null): [string | null, string | null] => {
      const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: bundleSel.value ? [] : wpState.ids, bundle_id: bundleSel.value || null });
      if (!r.valid || !r.hasExits || !r.startDc || !r.endDc || r.startDc === r.endDc) return [fromP, toP];
      const roomOf = (pid: string | null) => { if (!pid) return null; const p: any = store.get("ports", pid); return p ? store.equipmentDcId(p.equipment_id) : null; };
      const rf = roomOf(fromP), rt = roomOf(toP);
      const fromWrong = rf && rf === r.endDc && rf !== r.startDc;
      const toWrong = rt && rt === r.startDc && rt !== r.endDc;
      return (fromWrong || toWrong) ? [toP, fromP] : [fromP, toP];
    };
    const rebuildTypeSelect = () => {
      const bnd: any = selectedBundle();
      if (bnd) { const ct: any = bnd.cable_type_id ? store.get("cableTypes", bnd.cable_type_id) : null; setOptions(selType, [{ value: bnd.cable_type_id || "", label: ct ? (ct.name + " · " + ct.family) : "(type du faisceau ?)" }], bnd.cable_type_id || ""); selType.disabled = true; selType.style.opacity = "0.7"; return; }
      selType.disabled = false; selType.style.opacity = "";
      const fam = typeFilterFamily();
      const kindTarget = store.portKind(store.get("ports", selPortA.value)) || store.portKind(store.get("ports", selPortB.value)) || null;
      const cur = selType.value;
      let list = store.all("cableTypes").slice();
      if (fam) list = list.filter((ct: any) => ct.family === fam);
      else if (kindTarget) list = list.filter((ct: any) => (ct.kind === "power" ? "power" : "data") === kindTarget);
      list.sort((a: any, b: any) => a.name.localeCompare(b.name));
      if (cur && !list.some((ct: any) => ct.id === cur)) { const c: any = store.get("cableTypes", cur); if (c) list.push(c); }
      let next = cur;
      if (fam) { const cc: any = cur ? store.get("cableTypes", cur) : null; if (!cc || cc.family !== fam) { const f = list.find((ct: any) => ct.family === fam); next = f ? f.id : ""; } }
      setOptions(selType, [{ value: "", label: "— type de câble —" }].concat(list.map((ct: any) => ({ value: ct.id, label: ct.name + " · " + ct.family }))), next);
    };
    const refresh = () => {
      rebuildTypeSelect();
      setOptions(selEqA, eqOpts(constraintFor("A"), selEqA.value, dcConstraintFor("A")), selEqA.value);
      setOptions(selEqB, eqOpts(constraintFor("B"), selEqB.value, dcConstraintFor("B")), selEqB.value);
      const pa = selPortA.value, pb = selPortB.value;
      setOptions(selPortA, portOpts(selEqA.value, pa, constraintFor("A")), pa);
      setOptions(selPortB, portOpts(selEqB.value, pb, constraintFor("B")), pb);
    };
    const syncBundleUI = () => {
      const bnd: any = selectedBundle();
      if (bnd) {
        wpField.style.display = "none"; wpRouteHint.style.display = "none"; wpOrderField.style.display = "none";
        lenI.disabled = true; lenI.style.opacity = "0.7"; lenI.value = (bnd.length_m != null) ? bnd.length_m : ""; lenI.placeholder = "(longueur du faisceau)";
        const occ = store.bundleOccupancy(bnd.id); const free = occ.free + ((cable && cable.bundle_id === bnd.id) ? 1 : 0);
        bundleHint.innerHTML = "Brin du faisceau <b>« " + Html.escape(bnd.name || "(trunk)") + " »</b> — type, route et longueur HÉRITÉS. Occupation " + occ.used + "/" + bnd.fiber_count + (free <= 0 ? " · <span style=\"color:var(--err)\">COMPLET</span>" : "") + ".";
      } else {
        wpField.style.display = ""; wpRouteHint.style.display = ""; syncWpOrder();
        lenI.disabled = false; lenI.style.opacity = ""; lenI.placeholder = "ex. 3"; bundleHint.textContent = "";
      }
    };
    const curDraft = () => ({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, cable_type_id: selType.value || null, waypoint_ids: wpState.ids, bundle_id: bundleSel.value || null });
    const updateHint = (max: string) => {
      hint.classList.remove("warn", "err");
      const a = selPortA.value, b = selPortB.value, fa = familyOf(a), fb = familyOf(b);
      if (a && b && a === b) { hint.textContent = "Un câble ne peut pas relier un port à lui-même."; hint.classList.add("err"); return; }
      if (a && b && fa && fb && fa !== fb) { hint.textContent = "Familles différentes (« " + fa + " » vs « " + fb + " ») — incompatible : le câble restera un BROUILLON."; hint.classList.add("warn"); return; }
      const r = store.cableRoute(curDraft());
      if (!r.valid) { hint.textContent = "Route invalide (" + r.errors[0] + ") → enregistré en « Brouillon »."; hint.classList.add("warn"); return; }
      if (max === CABLE_STATUS_DRAFT) { hint.textContent = "Assignation incomplète → « Brouillon ». Renseignez les 2 ports + un type compatible pour le planifier."; hint.classList.add("warn"); return; }
      if (max === "planifie") { hint.textContent = "Équipement(s) non placé(s) → statut maximal « Planifié » ; « Câblé » attendra la pose des deux bouts."; return; }
      hint.textContent = "Assignation complète (« " + (fa || "?") + " ») et route cohérente. Vous pouvez définir le statut.";
    };
    const syncStatus = (userChange: boolean) => {
      const max = store.cableMaxStatus(curDraft());
      Array.from(statusSel.options).forEach((op) => { op.disabled = !store.cableStatusFits(op.value, max); });
      if (!store.cableStatusFits(statusSel.value, max)) statusSel.value = (max === CABLE_STATUS_DRAFT) ? CABLE_STATUS_DRAFT : CABLE_STATUS_DEFAULT_NEW;
      else if (userChange && statusSel.value === CABLE_STATUS_DRAFT && max !== CABLE_STATUS_DRAFT) statusSel.value = CABLE_STATUS_DEFAULT_NEW;
      updateHint(max);
    };

    bundleSel.onchange = () => { syncBundleUI(); refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selEqA.onchange = () => { setOptions(selPortA, portOpts(selEqA.value, null, constraintFor("A"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selEqB.onchange = () => { setOptions(selPortB, portOpts(selEqB.value, null, constraintFor("B"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selPortA.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selPortB.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selType.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };

    refresh(); syncBundleUI(); renderNets(); syncPrimary(); syncRoute(); syncStatus(false);

    host.openModal({
      title: cable ? "Modifier le câble" : "Nouveau câble",
      subtitle: cable ? Html.escape(cable.name || "") : "Relier deux ports",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        let fromP = selPortA.value || null, toP = selPortB.value || null;
        const bnd: any = selectedBundle();
        const ctId = bnd ? (bnd.cable_type_id || null) : (selType.value || null);
        const wpIds = bnd ? [] : wpState.ids.slice();
        const lenV0 = parseFloat(String(lenI.value));
        const lenOut = bnd ? null : ((isFinite(lenV0) && lenV0 >= 0) ? lenV0 : null);
        let strandNo: number | null = null;
        if (bnd) {
          const occ = store.bundleOccupancy(bnd.id);
          const reuse = !!(cable && cable.bundle_id === bnd.id && cable.strand_no != null);
          if (!reuse && occ.free <= 0) { Notify.toast("Faisceau « " + (bnd.name || "trunk") + " » COMPLET (" + occ.used + "/" + bnd.fiber_count + ")", "err"); return false; }
          strandNo = reuse ? cable.strand_no : occ.nextStrand;
        }
        if (fromP && toP && fromP === toP) { Notify.toast("Un câble ne peut pas relier un port à lui-même", "err"); return false; }
        if (fromP && store.cableOnPort(fromP, cable ? cable.id : null)) { Notify.toast("Le port A est déjà relié (1 câble par port)", "err"); return false; }
        if (toP && store.cableOnPort(toP, cable ? cable.id : null)) { Notify.toast("Le port B est déjà relié (1 câble par port)", "err"); return false; }
        [fromP, toP] = orientEnds(fromP, toP);
        // EXIT TERMINAL & cohérence de route : refuse d'enregistrer une route de waypoints incohérente.
        if (wpIds.length) {
          const bad = store.cableRoute({ from_port_id: fromP, to_port_id: toP, waypoint_ids: wpIds, bundle_id: bnd ? bnd.id : null }).errors.find((e: string) =>
            e.includes("au milieu d'un tronçon hors salle") || e.includes("ré-entrée dans la salle quittée")
            || e.includes("dans une autre salle que le segment courant") || e.includes("la sortie doit être un exit de la salle courante")
            || e.includes("doit être ENTRE deux exits") || e.includes("exit non appairé"));
          if (bad) { Notify.toast("Route invalide : " + bad, "err"); return false; }
        }
        const max = store.cableMaxStatus({ from_port_id: fromP, to_port_id: toP, cable_type_id: ctId, waypoint_ids: wpIds, bundle_id: bnd ? bnd.id : null });
        let status = statusSel.value;
        if (!CableStatuses.isStatus(status) || !store.cableStatusFits(status, max)) status = (max === CABLE_STATUS_DRAFT) ? CABLE_STATUS_DRAFT : CABLE_STATUS_DEFAULT_NEW;
        else if (status === CABLE_STATUS_DRAFT && max !== CABLE_STATUS_DRAFT) status = CABLE_STATUS_DEFAULT_NEW;
        const ck = ctId ? (((store.get("cableTypes", ctId) || {}).kind === "power") ? "power" : "data") : null;
        const network_ids = [...netState.ids].filter((nid) => { if (ck == null) return true; const n: any = store.get("networks", nid); return !n || ((n.kind === "power" ? "power" : "data") === ck); });
        let primary = netState.primary; if (primary && !network_ids.includes(primary)) primary = null; if (!primary && network_ids.length) primary = network_ids[0];
        const payload = { name, cable_type_id: ctId, from_port_id: fromP, to_port_id: toP, network_ids, network_id: primary, waypoint_ids: wpIds, length_m: lenOut, bundle_id: bnd ? bnd.id : null, strand_no: strandNo, status, description: descI.value.trim() };
        if (cable) await store.update("cables", cable.id, payload); else await store.create("cables", payload);
        host.setDirty?.(true); Notify.toast(cable ? "Câble mis à jour" : (bnd ? "Brin créé (faisceau « " + (bnd.name || "trunk") + " »)" : (max !== CABLE_STATUS_DRAFT ? "Câble créé" : "Brouillon créé"))); onSaved?.(); return true;
      },
    });
    setTimeout(() => (cable ? nameI : selEqA).focus(), 30);
  }

  /** Faisceau / trunk : créé À L'AVANCE (nom + type + nb de brins). Le type VERROUILLE le type des
      brins ; route + longueur PARTAGÉES par les brins. */
  static cableBundle(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const bnd: any = id ? store.get("cableBundles", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(bnd ? bnd.name : "", "ex. Trunk 12F OM4 SalleA↔SalleB");
    root.appendChild(FormControls.fieldRow("Nom du faisceau", nameI, "Label porté sur le tracé (les brins l'affichent)."));
    const typeOpts = [{ value: "", label: "— type de câble —" }].concat(store.all("cableTypes").slice().sort((a: any, b: any) => a.name.localeCompare(b.name)).map((ct: any) => ({ value: ct.id, label: ct.name + " · " + ct.family })));
    const typeI = FormControls.select(typeOpts, bnd ? (bnd.cable_type_id || "") : "");
    const fcI = FormControls.number(bnd ? bnd.fiber_count : 12, { min: 1, step: 1 });
    const lenI = FormControls.number((bnd && bnd.length_m != null) ? bnd.length_m : "", { min: 0, step: 0.1, placeholder: "ex. 25" });
    root.appendChild(row2(FormControls.fieldRow("Type (verrouille les brins)", typeI, "Impose le type des câbles associés."), FormControls.fieldRow("Nombre de brins", fcI, "Capacité (plafond)."), FormControls.fieldRow("Longueur (m)", lenI, "Partagée par les brins.")));

    // route PARTAGÉE (ordonnée) — picker compact (exits/OOB)
    const wpState = { ids: bnd ? (bnd.waypoint_ids || []).slice() : [] as string[] };
    const wpAll = store.all("waypoints").filter((wp: any) => Waypoint.isFloorLevel(wp) || store.waypointIsPlaced(wp) || wpState.ids.includes(wp.id))
      .sort((a: any, b: any) => ((Waypoint.isFloorLevel(a) ? 1 : 0) - (Waypoint.isFloorLevel(b) ? 1 : 0)) || (a.name || "").localeCompare(b.name || ""));
    const wpBoxes = document.createElement("div"); wpBoxes.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0;";
    const orderBox = document.createElement("div");
    const wpLab = (wp: any) => Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + " · " + (Waypoint.isFloorLevel(wp) ? Waypoint.floorLabel(wp) : (store.waypointIsPlaced(wp) ? store.dcName(wp.datacenter_id) : "non posé"));
    const renderOrder = () => {
      orderBox.innerHTML = "";
      wpState.ids.forEach((wid: string, i: number) => {
        const wp: any = store.get("waypoints", wid); if (!wp) return;
        const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;font-size:12px;";
        const n = document.createElement("span"); n.className = "pill"; n.textContent = String(i + 1); const tx = document.createElement("span"); tx.className = "grow"; tx.textContent = wpLab(wp);
        const mk = (s: string, d: number) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = s; b.disabled = (d < 0 && i === 0) || (d > 0 && i === wpState.ids.length - 1); b.onclick = () => { const j = i + d; wpState.ids.splice(i, 1); wpState.ids.splice(j, 0, wid); renderOrder(); }; return b; };
        r.append(n, tx, mk("↑", -1), mk("↓", 1)); orderBox.appendChild(r);
      });
    };
    if (!wpAll.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun waypoint utilisable (créez des exits / pins d'étage en vue Datacenter)."; wpBoxes.appendChild(h); }
    else wpAll.forEach((wp: any) => {
      const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = wpState.ids.includes(wp.id);
      cb.onchange = () => {
        if (cb.checked) {   // EXIT TERMINAL : refuse un waypoint de salle après l'exit de cette salle
          const bad = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] }).errors.find((e: string) =>
            e.includes("au milieu d'un tronçon hors salle") || e.includes("ré-entrée dans la salle quittée")
            || e.includes("dans une autre salle que le segment courant") || e.includes("la sortie doit être un exit de la salle courante"));
          if (bad) { cb.checked = false; Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir.", "err"); return; }
          if (!wpState.ids.includes(wp.id)) wpState.ids.push(wp.id);
        } else wpState.ids = wpState.ids.filter((x: string) => x !== wp.id);
        renderOrder();
      };
      const tx = document.createElement("span"); tx.textContent = wpLab(wp); lab.append(cb, tx); wpBoxes.appendChild(lab);
    });
    root.appendChild(FormControls.fieldRow("Route (partagée par les brins)", wpBoxes, "Exits (par paires) + pins d'étage. Cochés = ajoutés en fin de trajet."));
    root.appendChild(FormControls.fieldRow("Ordre du trajet", orderBox)); renderOrder();
    const descI = FormControls.textArea(bnd ? bnd.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    if (bnd) { const oc = store.bundleOccupancy(bnd.id); const info = document.createElement("div"); info.className = "form-hint"; info.textContent = oc.used + " brin(s) câblé(s) sur " + oc.capacity + ". Réduire le nb de brins sous " + oc.used + " est refusé."; root.appendChild(info); }

    host.openModal({
      title: bnd ? "Modifier le faisceau" : "Nouveau faisceau",
      subtitle: bnd ? Html.escape(bnd.name || "") : "Trunk multi-fibres",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim(); if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const fc = Math.max(1, parseInt(fcI.value, 10) || 12);
        if (bnd) { const oc = store.bundleOccupancy(bnd.id); if (fc < oc.used) { Notify.toast("Nombre de brins (" + fc + ") inférieur aux " + oc.used + " brins déjà câblés", "err"); return false; } }
        const lenV = parseFloat(String(lenI.value));
        const payload = { name, cable_type_id: typeI.value || null, fiber_count: fc, waypoint_ids: wpState.ids.slice(), length_m: (isFinite(lenV) && lenV >= 0) ? lenV : null, description: descI.value.trim() };
        let bid: string;
        if (bnd) { await store.update("cableBundles", bnd.id, payload); bid = bnd.id; } else { const c: any = await store.create("cableBundles", payload); bid = c.id; }
        // les brins STOCKENT le type du trunk → resynchroniser quand le type change
        const ops = store.strandsOfBundle(bid).filter((s: any) => s.cable_type_id !== payload.cable_type_id).map((s: any) => ({ collection: "cables", id: s.id, patch: { cable_type_id: payload.cable_type_id } }));
        if (ops.length) await store.updateBatch(ops);
        host.setDirty?.(true); Notify.toast(bnd ? "Faisceau mis à jour" : "Faisceau créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Baie (rack) — identité · localisation · cage · dims · side-mount · portes (avant/arrière) ·
      capots (emplacements waypoint toit/sol, sauvegarde immédiate sur un rack existant). */
  static rack(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const rk: any = id ? store.get("racks", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(rk ? rk.name : "", "ex. Baie A1");
    root.appendChild(FormControls.fieldRow("Nom", nameI));

    // placement dans une SALLE (datacenter) → visible en vue 3D ; sinon « pool / hors salle ».
    const dcOpts = [{ value: "", label: "— Pool / hors salle —" }].concat(store.all("datacenters").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => ({ value: d.id, label: d.name || "(salle)" })));
    const dcSel = FormControls.select(dcOpts, rk && rk.datacenter_id ? rk.datacenter_id : "");
    root.appendChild(FormControls.fieldRow("Salle (datacenter)", dcSel, "Placer la baie dans une salle 3D. Le lieu/étage/local est alors hérité de la salle."));
    const dcxI = FormControls.number((rk && rk.dc_x != null) ? rk.dc_x : "", { min: 0, step: 10, placeholder: "centre X (mm)" });
    const dcyI = FormControls.number((rk && rk.dc_y != null) ? rk.dc_y : "", { min: 0, step: 10, placeholder: "centre Y (mm)" });
    const posRow = row2(FormControls.fieldRow("Position X (mm)", dcxI), FormControls.fieldRow("Position Y (mm)", dcyI));
    root.appendChild(posRow);
    // lieu/étage/local : manuels hors salle, hérités (verrouillés) si placé dans une salle.
    const locI = FormControls.select(locOptions(""), rk ? rk.location : "");
    const floorI = FormControls.select(floorOptions(rk ? rk.floor : ""), rk ? rk.floor : "");
    const roomI = FormControls.text(rk ? rk.room : "", "local");
    root.appendChild(row2(FormControls.fieldRow("Lieu", locI), FormControls.fieldRow("Étage", floorI), FormControls.fieldRow("Local", roomI)));
    const dcHint = document.createElement("div"); dcHint.className = "form-hint"; root.appendChild(dcHint);
    const syncDc = () => {
      const d: any = dcSel.value ? store.get("datacenters", dcSel.value) : null;
      posRow.style.display = d ? "" : "none";
      [locI, floorI, roomI].forEach((el: any) => { el.disabled = !!d; el.style.opacity = d ? "0.7" : ""; });
      if (d) { locI.value = d.location || ""; setOptions(floorI, floorOptions(d.floor || ""), d.floor || ""); roomI.value = d.room || ""; }
      dcHint.innerHTML = d ? "⛓ Lieu/étage/local hérités de « " + Html.escape(d.name || "(salle)") + " » (" + (d.width_mm / 1000).toFixed(1) + "×" + (d.depth_mm / 1000).toFixed(1) + " m). Position vide = centre." : "";
    };
    dcSel.onchange = syncDc; syncDc();

    // cage
    root.appendChild(divider("Dimensions de la cage"));
    const uI = FormControls.number(rk ? rk.u_count : 42, { min: 1 });
    const vmI = FormControls.number(rk ? RackGeometry.vMarginTop(rk) : RACK_MOUNT_MARGIN_DEFAULT, { min: 0 });
    const vmBotI = FormControls.number(rk && rk.vmargin_bottom_mm != null ? rk.vmargin_bottom_mm : "", { min: 0, placeholder: "= marge haute" });
    const cageI = FormControls.number(rk ? RackGeometry.cageDepth(rk) : RACK_DEPTH_DEFAULT, { min: 1 });
    const fmI = FormControls.number(rk ? RackGeometry.frontMargin(rk) : 0, { min: 0, placeholder: "0" });
    const lmI = FormControls.number(rk ? RackGeometry.lMargin(rk) : RACK_MOUNT_MARGIN_DEFAULT, { min: 0 });
    const sidesI = FormControls.select(RACK_SIDES.map((s) => ({ value: s.id, label: s.label })), rk ? rk.sides : "single");
    root.appendChild(row2(FormControls.fieldRow("Hauteur (U)", uI), FormControls.fieldRow("Marge verticale (mm)", vmI), FormControls.fieldRow("Marge basse (mm)", vmBotI)));
    root.appendChild(row2(FormControls.fieldRow("Profondeur cage (mm)", cageI), FormControls.fieldRow("Marge avant (mm)", fmI), FormControls.fieldRow("Marge latérale (mm)", lmI), FormControls.fieldRow("Faces", sidesI)));

    // dimensions extérieures
    root.appendChild(divider("Dimensions extérieures"));
    const widthI = FormControls.number(rk ? rk.width_mm : RACK_WIDTH_DEFAULT, { min: 1 });
    const heightI = FormControls.number(rk && rk.height_mm != null ? rk.height_mm : "", { min: 1, placeholder: "= hauteur mini" });
    const depthI = FormControls.number(rk ? rk.depth : RACK_DEPTH_DEFAULT, { min: 1 });
    FormControls.attachDatalist(depthI, "dl-rack-depth", RACK_DEPTHS.map(String));
    root.appendChild(row2(FormControls.fieldRow("Largeur (mm)", widthI), FormControls.fieldRow("Hauteur (mm)", heightI), FormControls.fieldRow("Profondeur (mm)", depthI)));
    const geoHint = document.createElement("div"); geoHint.className = "form-hint"; root.appendChild(geoHint);

    // side-mount
    root.appendChild(divider("Montage latéral (marge)"));
    const sideFrontI = FormControls.toggle("Side-mount avant", rk ? !!rk.allow_side_front : false, () => {}, { block: true });
    const sideRearI = FormControls.toggle("Side-mount arrière", rk ? !!rk.allow_side_rear : false, () => {}, { block: true });
    root.appendChild(row2(sideFrontI, sideRearI));

    // -- portes (avant/arrière) en saillie : épaisseur, charnière, pleine/creuse --
    root.appendChild(divider("Portes (avant / arrière)"));
    const doorInputs: Record<string, any> = {};
    const syncDoors = () => RACK_FACES.forEach((f) => { const di = doorInputs[f.id]; if (!di) return; di.ctrls.style.display = di.enI.checked ? "" : "none"; di.hmRow.style.display = (di.enI.checked && di.hollowI.checked) ? "" : "none"; });
    const doorsWrap = document.createElement("div"); doorsWrap.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;";
    RACK_FACES.forEach((face) => {
      const cur = Normalize.rackDoor(rk ? (face.id === "rear" ? rk.door_rear : rk.door_front) : null);
      const col = document.createElement("div"); col.style.cssText = "flex:1;min-width:230px;border:1px solid var(--line-2);border-radius:8px;padding:10px;";
      const enI = FormControls.toggle("Porte " + face.label.toLowerCase(), !!cur.enabled, () => syncDoors(), { block: true });
      col.appendChild(enI);
      const ctrls = document.createElement("div"); ctrls.style.marginTop = "8px"; col.appendChild(ctrls);
      const thI = FormControls.number(cur.thickness_mm, { min: 1, placeholder: "40" }); ctrls.appendChild(FormControls.fieldRow("Épaisseur (mm)", thI));
      const hingeI = FormControls.select([{ value: "left", label: "Charnière gauche" }, { value: "right", label: "Charnière droite" }], cur.hinge);
      ctrls.appendChild(FormControls.fieldRow("Charnière", hingeI));
      const hollowI = FormControls.toggle("Creuse", !!cur.hollow, () => syncDoors(), { block: true }); ctrls.appendChild(hollowI);
      const hmI = FormControls.number(cur.hollow_mm, { min: 0, placeholder: "0" });
      const hmRow = FormControls.fieldRow("Cavité vide (mm)", hmI, "Profondeur utile en plus de ce côté (équipements plus profonds tolérés).");
      ctrls.appendChild(hmRow);
      doorsWrap.appendChild(col);
      doorInputs[face.id] = { enI, thI, hingeI, hollowI, hmI, ctrls, hmRow };
    });
    root.appendChild(doorsWrap); syncDoors();

    // -- capots : emplacements waypoint (toit/sol), grilles multi-sélection, SAUVE IMMÉDIAT --
    // (réservé à un rack EXISTANT : la grille dépend des dimensions enregistrées)
    if (rk) {
      root.appendChild(divider("Capots — emplacements Waypoint (toit / sol)"));
      const capHint = document.createElement("div"); capHint.className = "form-hint"; capHint.style.textAlign = "center";
      capHint.textContent = "Vue de dessus (maille 1U, bord supérieur = face avant). Glissez pour (dé)autoriser des cellules : elles deviennent des TROUS où poser un Waypoint Pin (clic du trou en 3D). Une cellule portant un pin (◆) n'est pas retirable. Enregistré immédiatement.";
      root.appendChild(capHint);
      const capRow = document.createElement("div"); capRow.style.cssText = "display:flex;gap:22px;flex-wrap:wrap;justify-content:center;align-items:flex-start;margin-top:8px;";
      [{ face: "roof", label: "Toit (dessus)" }, { face: "floor", label: "Sol (dessous)" }].forEach((cf) => {
        const col = document.createElement("div"); col.style.textAlign = "center";
        const t = document.createElement("div"); t.className = "form-hint"; t.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:4px;"; t.textContent = cf.label;
        col.appendChild(t); col.appendChild(Forms.capEditor(store, host, rk, cf.face).el);
        capRow.appendChild(col);
      });
      root.appendChild(capRow);
    }

    const descI = FormControls.textArea(rk ? rk.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    const _n = (i: HTMLInputElement, d: number) => { const v = parseInt(i.value, 10); return isFinite(v) ? v : d; };
    const geo = () => {
      const u = Math.max(1, _n(uI, 42)), vt = Math.max(0, _n(vmI, 0)), vb = (vmBotI.value !== "") ? Math.max(0, _n(vmBotI, 0)) : Math.max(0, _n(vmI, 0));
      const lm = Math.max(0, _n(lmI, 0)), cage = Math.max(1, _n(cageI, RACK_DEPTH_DEFAULT)), fm = Math.max(0, _n(fmI, 0));
      return { u, vt, vb, lm, cage, fm, minH: u * U_MM + vt + vb, minW: RACK_MOUNT_WIDTH + 2 * lm, minD: cage + fm };
    };
    const refreshGeo = () => {
      const g = geo();
      geoHint.textContent = "Mini : largeur ≥ " + Math.round(g.minW) + " · hauteur ≥ " + Math.round(g.minH) + " · profondeur ≥ " + g.minD + " mm (ajustées à l'enregistrement).";
      const margin = Math.max(0, (_n(widthI, RACK_WIDTH_DEFAULT) - RACK_MOUNT_WIDTH) / 2);
      (sideFrontI as any).disabled = margin < U_MM; (sideRearI as any).disabled = margin < U_MM;
    };
    [uI, vmI, vmBotI, cageI, fmI, lmI, widthI, heightI, depthI].forEach((i) => i.addEventListener("input", refreshGeo));
    refreshGeo();

    host.openModal({
      title: rk ? "Modifier la baie" : "Nouvelle baie",
      subtitle: rk ? Html.escape(rk.name || "") : "",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const g = geo();
        const minW = Math.round(g.minW), minH = Math.round(g.minH), minD = g.minD;
        let width_mm = Math.max(1, _n(widthI, RACK_WIDTH_DEFAULT)); if (width_mm < minW) width_mm = minW;
        let depth = Math.max(1, _n(depthI, RACK_DEPTH_DEFAULT)); if (depth < minD) depth = minD;
        let height_mm: number | null = (heightI.value !== "") ? Math.max(1, _n(heightI, minH)) : null;
        if (height_mm != null && height_mm < minH) height_mm = minH;
        const sideOk = (width_mm - RACK_MOUNT_WIDTH) / 2 >= U_MM;
        // placement salle : centre par défaut si position vide ; lieu/étage/local hérités de la salle.
        const placeDc: any = dcSel.value ? store.get("datacenters", dcSel.value) : null;
        const datacenter_id = placeDc ? placeDc.id : null;
        const dc_x = placeDc ? (dcxI.value !== "" ? Math.max(0, parseInt(dcxI.value, 10) || 0) : Math.round(placeDc.width_mm / 2)) : null;
        const dc_y = placeDc ? (dcyI.value !== "" ? Math.max(0, parseInt(dcyI.value, 10) || 0) : Math.round(placeDc.depth_mm / 2)) : null;
        const payload: any = {
          name,
          datacenter_id, dc_x, dc_y,
          location: placeDc ? (placeDc.location || "") : (locI.value || ""), floor: placeDc ? (placeDc.floor || "") : floorI.value, room: placeDc ? (placeDc.room || "") : roomI.value.trim(),
          u_count: g.u, width_mm, depth, sides: sidesI.value === "dual" ? "dual" : "single",
          lmargin_mm: g.lm, vmargin_mm: g.vt, vmargin_bottom_mm: (vmBotI.value !== "") ? g.vb : null,
          cage_depth_mm: g.cage, front_margin_mm: g.fm, height_mm, mount_margin_mm: g.lm,
          allow_side_front: sideOk && (sideFrontI as any).checked, allow_side_rear: sideOk && (sideRearI as any).checked,
          door_front: { enabled: (doorInputs.front.enI as any).checked, thickness_mm: Math.max(1, parseInt(doorInputs.front.thI.value, 10) || 40), hinge: doorInputs.front.hingeI.value === "right" ? "right" : "left", hollow: (doorInputs.front.hollowI as any).checked, hollow_mm: Math.max(0, parseInt(doorInputs.front.hmI.value, 10) || 0) },
          door_rear: { enabled: (doorInputs.rear.enI as any).checked, thickness_mm: Math.max(1, parseInt(doorInputs.rear.thI.value, 10) || 40), hinge: doorInputs.rear.hingeI.value === "right" ? "right" : "left", hollow: (doorInputs.rear.hollowI as any).checked, hollow_mm: Math.max(0, parseInt(doorInputs.rear.hmI.value, 10) || 0) },
          description: descI.value.trim(),
        };
        // redimensionnement d'une baie occupée (nombre de U) → déplace ses équipements
        if (rk && g.u !== rk.u_count) {
          const occ = store.equipmentsOfRack(rk.id);
          if (occ.length) {
            const ok = await Dialog.confirm({ title: "Redimensionner la baie ?", message: "Cette baie contient " + occ.length + " équipement(s). Changer le nombre de U les passera tous en « Non placé ». Continuer ?", confirmLabel: "Redimensionner", danger: true });
            if (!ok) return false;
            await store.updateBatch([{ collection: "racks", id: rk.id, patch: payload }].concat(occ.map((e: any) => ({ collection: "equipments", id: e.id, patch: { placement_mode: "manual", rack_id: null, rack_u: null } }))));
            host.setDirty?.(true); Notify.toast("Baie redimensionnée"); onSaved?.(); return true;
          }
        }
        if (rk) await store.update("racks", rk.id, payload); else await store.create("racks", payload);
        host.setDirty?.(true); Notify.toast(rk ? "Baie mise à jour" : "Baie créée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Réseau IP (sous-réseau CIDR). */
  /** Salle (datacenter) — grille au sol : nom · dimensions (mm) · maille · localisation. */
  static datacenter(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const dc: any = id ? store.get("datacenters", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(dc ? dc.name : "", "ex. Salle A");
    root.appendChild(FormControls.fieldRow("Nom", nameI));
    root.appendChild(divider("Dimensions de la salle"));
    const wI = FormControls.number(dc ? dc.width_mm : 6000, { min: 1, step: 100, placeholder: "largeur (mm)" });
    const dI = FormControls.number(dc ? dc.depth_mm : 4000, { min: 1, step: 100, placeholder: "profondeur (mm)" });
    const cI = FormControls.number(dc ? dc.cell_mm : 600, { min: 1, step: 50, placeholder: "maille (mm)" });
    root.appendChild(row2(FormControls.fieldRow("Largeur (mm)", wI), FormControls.fieldRow("Profondeur (mm)", dI), FormControls.fieldRow("Maille (mm)", cI)));
    root.appendChild(divider("Localisation"));
    const locI = FormControls.select(locOptions(""), dc ? dc.location : "");
    const floorI = FormControls.select(floorOptions(dc ? dc.floor : ""), dc ? dc.floor : "");
    const roomI = FormControls.text(dc ? dc.room : "", "local");
    root.appendChild(row2(FormControls.fieldRow("Lieu", locI), FormControls.fieldRow("Étage", floorI), FormControls.fieldRow("Local", roomI)));

    host.openModal({
      title: dc ? "Modifier la salle" : "Nouvelle salle",
      subtitle: dc ? Html.escape(dc.name || "") : "Datacenter (grille au sol)",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const payload = {
          name,
          width_mm: Math.max(1, parseInt(wI.value, 10) || 6000), depth_mm: Math.max(1, parseInt(dI.value, 10) || 4000), cell_mm: Math.max(1, parseInt(cI.value, 10) || 600),
          location: locI.value || "", floor: floorI.value, room: roomI.value.trim(),
        };
        if (dc) await store.update("datacenters", dc.id, payload); else await store.create("datacenters", payload);
        host.setDirty?.(true); Notify.toast(dc ? "Salle mise à jour" : "Salle créée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Édition d'un waypoint. CONTRAINTE : seuls le NOM, le positionnement LOCAL (hauteur + grille capot/marge) et la
      description restent modifiables. Le type, la forme, la salle/baie et les sections sont FIXÉS à la création
      (création via panneaux / menus contextuels). Fusion OOB→pin : pin de salle vs pin d'étage selon le placement. */
  static waypoint(store: Store, host: FormHost, id: string | null, _opts: any = {}): void {
    const scene = new RackScene(store);
    const wp: any = id ? store.get("waypoints", id) : null;
    if (!wp) { Notify.toast("Waypoint introuvable", "err"); return; }
    const floorLvl = Waypoint.isFloorLevel(wp), isExit = Waypoint.typeOf(wp) === "exit";
    const isCapPin = wp.kind === "point" && wp.rack_id && wp.cap_face;
    const isSidePin = wp.kind === "point" && wp.rack_id && wp.side_lr != null;
    const isBrush = wp.kind === "brush", isSeg = wp.kind === "segment";
    const kindLbl = isExit ? "Exit (sortie de salle)" : floorLvl ? "Pin d'étage" : isBrush ? "Brosse de brassage"
      : isSeg ? "Chemin de câbles" : isCapPin ? "Pin de capot" : isSidePin ? "Pin latéral (marge)" : "Pin de salle";
    const root = document.createElement("div");
    const nameI = FormControls.text(wp.name || "", "ex. Goulotte travée A");
    root.appendChild(FormControls.fieldRow("Nom", nameI));
    // récapitulatif VERROUILLÉ (type + emplacement, non modifiables)
    const where = floorLvl ? (FloorLayout.locationLabel(wp.location) + " · " + Waypoint.floorLabel(wp))
      : wp.rack_id ? ("baie « " + ((store.get("racks", wp.rack_id) || {}).name || "?") + " »")
      : wp.datacenter_id ? ("salle « " + store.dcName(wp.datacenter_id) + " »") : "pool (non posé)";
    const lock = document.createElement("div"); lock.className = "form-hint";
    lock.innerHTML = "Type : <b>" + Html.escape(kindLbl) + "</b> · " + Html.escape(where) + ".<br>Type et emplacement sont fixés à la création — seuls le nom, la hauteur et la grille restent modifiables.";
    root.appendChild(lock);
    // HAUTEUR (dc_z) — pin flottant / chemin / pin d'étage uniquement (cap/marge/brosse : hauteur dérivée du slot).
    let zI: HTMLInputElement | null = null;
    if (!isCapPin && !isSidePin && !isBrush) {
      zI = FormControls.number(wp.dc_z != null ? wp.dc_z : 0, { step: 50 });
      root.appendChild(FormControls.fieldRow("Hauteur (mm)", zI, floorLvl ? "Hauteur du ◎ sur le plan d'étage (≥ 0)." : "Hauteur au-dessus du sol. Négatif = sous le faux-plancher."));
    }
    // GRILLE de capot (pin de capot) : déplacer dans une autre cellule autorisée du même capot.
    let capChosen: any = isCapPin ? { cx: wp.cap_cx | 0, cy: wp.cap_cy | 0 } : null;
    if (isCapPin) {
      const rk: any = store.get("racks", wp.rack_id);
      if (rk) { root.appendChild(divider("Emplacement sur le capot (" + (wp.cap_face === "floor" ? "sol" : "toit") + ")"));
        root.appendChild(Forms.capPickGrid(store, rk, wp.cap_face, { exceptId: wp.id, selected: capChosen, onPick: (cx: number, cy: number) => { capChosen = { cx, cy }; } }).el); }
    }
    // GRILLE de marge (pin latéral) : déplacer dans un autre slot de la même marge.
    let pinChosen: any = isSidePin ? { lr: (wp.side_lr === "right" ? "right" : "left"), col: (wp.side_col === 1 ? 1 : 0), u: Math.max(1, wp.side_u | 0) } : null;
    if (isSidePin) {
      const rk: any = store.get("racks", wp.rack_id);
      if (rk) { root.appendChild(divider("Emplacement en marge (" + Forms.faceLabel(wp.side_face === "rear" ? "rear" : "front") + ")"));
        root.appendChild(Forms.sideGrid(store, scene, rk, { face: wp.side_face === "rear" ? "rear" : "front", heightU: SIDE_U_STEP, width: 0, exceptEqId: wp.id, selected: pinChosen, onPick: (lr: string, col: number, u: number) => { pinChosen = { lr, col, u }; } }).el); }
    }
    const descI = FormControls.textArea(wp.description || "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    host.openModal({
      title: "Modifier le waypoint", subtitle: Html.escape(wp.name || ""), body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const payload: any = { name, description: descI.value.trim() };
        if (zI) payload.dc_z = floorLvl ? Math.max(0, parseInt(zI.value, 10) || 0) : (parseInt(zI.value, 10) || 0);
        if (isCapPin && capChosen) {
          if (scene.capSlotOccupied(wp.rack_id, wp.cap_face, capChosen.cx, capChosen.cy, wp.id)) { Notify.toast("Cet emplacement est déjà occupé", "err"); return false; }
          payload.cap_cx = capChosen.cx; payload.cap_cy = capChosen.cy;
        }
        if (isSidePin && pinChosen) {
          const face = wp.side_face === "rear" ? "rear" : "front";
          if (!scene.sideSlotFree(wp.rack_id, face, pinChosen.lr, pinChosen.col, pinChosen.u, SIDE_U_STEP, wp.id)) { Notify.toast("L'emplacement est occupé", "err"); return false; }
          payload.side_lr = pinChosen.lr; payload.side_col = pinChosen.col; payload.side_u = pinChosen.u;
        }
        await store.update("waypoints", wp.id, payload);
        host.setDirty?.(true); Notify.toast("Waypoint mis à jour"); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }


  /** Grille de sélection d'un emplacement de MARGE LATÉRALE (réplique `sideGrid`) : table U×colonnes,
      cellules libres cliquables (onPick), occupées teintées. */
  private static sideGrid(store: Store, scene: RackScene, rack: any, opts: any): { el: HTMLElement; refresh: () => void } {
    const wrap = document.createElement("div"); wrap.className = "rack-grid-wrap side-grid-wrap";
    const refresh = () => {
      const face = opts.face, cols = RackGeometry.sideColumns(rack), colW = RackGeometry.sideColWidthMm(rack);
      const heightU = Math.max(1, opts.heightU || 1), uMax = rack.u_count || 42;
      const fitsW = (opts.width || 0) <= colW + 0.5, sel = opts.selected;
      const occ = scene.sideOccupants(rack.id, face, null);
      const columns: Array<{ lr: string; col: number }> = []; ["left", "right"].forEach((lr) => { for (let c = 0; c < cols; c++) columns.push({ lr, col: c }); });
      const colLabel = (lr: string, c: number) => (lr === "left" ? "G" : "D") + (cols > 1 ? String(c + 1) : "");
      const blockAt = (lr: string, col: number, u: number) => occ.find((e: any) => e.id !== opts.exceptEqId
        && ((e.side_lr === "right" ? "right" : "left") === lr) && ((e.side_col === 1 && cols > 1) ? 1 : 0) === col
        && u >= Math.max(1, e.side_u | 0) && u < Math.max(1, e.side_u | 0) + RackGeometry.sideEquipHeightU(e));
      const tops: number[] = []; for (let u = 1; u + heightU - 1 <= uMax; u += SIDE_U_STEP) tops.push(u);
      let html = '<table class="rack-grid side-grid"><thead><tr><th class="ru">U</th>';
      columns.forEach((cc, i) => { html += `<th>${colLabel(cc.lr, cc.col)}</th>`; if (i === cols - 1) html += '<th class="side-mid">baie</th>'; });
      html += "</tr></thead><tbody>";
      for (let ri = tops.length - 1; ri >= 0; ri--) {
        const uTop = tops[ri];
        html += `<tr><td class="ru">${uTop}${heightU > 1 ? "–" + (uTop + heightU - 1) : ""}</td>`;
        columns.forEach((cc, i) => {
          const blk: any = blockAt(cc.lr, cc.col, uTop);
          const isSel = sel && sel.lr === cc.lr && sel.col === cc.col && uTop >= sel.u && uTop < sel.u + heightU;
          if (blk) {
            const hU = RackGeometry.sideEquipHeightU(blk), range = "U" + blk.side_u + (hU > 1 ? "–U" + (blk.side_u + hU - 1) : "");
            html += `<td class="rcell occ" title="${Html.escape((blk.name || "(équipement)") + " · " + range + " · marge " + (cc.lr === "left" ? "gauche" : "droite"))}" style="border-left:3px solid var(--accent);"><div class="rcell-in compact"><span class="rcell-name">${Html.escape(blk.name || "")}</span></div></td>`;
          } else {
            const free = fitsW && scene.sideSlotFree(rack.id, face, cc.lr, cc.col, uTop, heightU, opts.exceptEqId || null);
            const cls = "rcell free" + (isSel ? " chosen mount-face" : (free ? " placeable" : ""));
            const attrs = free ? `data-pick-lr="${cc.lr}" data-pick-col="${cc.col}" data-pick-u="${uTop}"` : "";
            html += `<td class="${cls}" ${attrs}>${isSel ? '<div class="rcell-in compact"><span class="rcell-name">ici</span></div>' : ""}</td>`;
          }
          if (i === cols - 1) html += '<td class="side-mid"></td>';
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      if (!fitsW) html += `<div class="form-hint" style="color:var(--warn);">L'équipement (largeur ${opts.width || 0} mm) dépasse la largeur de colonne (${Math.round(colW)} mm).</div>`;
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
  private static capPickGrid(store: Store, rack: any, face: string, opts: any): { el: HTMLElement; refresh: () => void } {
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

  /** Création / édition d'un plan d'étage (réplique `openFloorForm`). `opts.pick` = mode création (sélecteurs
      bâtiment+étage, étages existants exclus) ; `opts.onPicked(loc, fl)` = navigation après création. */
  static floor(store: Store, host: FormHost, location: string, floor: string, opts: any = {}): void {
    opts = opts || {};
    const pick = !!opts.pick;
    const fl = String(floor != null ? floor : "");
    const existing: any = store.floorFor(location, fl);
    const f: any = existing || { width_mm: FLOOR_WIDTH_DEFAULT, depth_mm: FLOOR_DEPTH_DEFAULT, cell_mm: FLOOR_CELL_DEFAULT, anchor_x: 0, anchor_y: 0, description: "" };
    const root = document.createElement("div");
    let locSel: HTMLSelectElement | null = null, flSel: HTMLSelectElement | null = null, pickStatus: HTMLElement | null = null;
    // un étage « existe » s'il a un plan, une salle, ou un OOB
    const floorExists = (L: string, F: string) => !!store.floorFor(L, F) || store.dcsOfFloor(L, F).length > 0
      || store.oobWaypoints().some((w: any) => (w.location || "") === (L || "") && String(w.floor || "") === String(F || ""));
    if (pick) {
      locSel = FormControls.select(locOptions(""), location || "");
      flSel = FormControls.select([], "");   // peuplé dynamiquement (étages NON existants du bâtiment choisi)
      root.appendChild(row2(FormControls.fieldRow("Bâtiment", locSel, "Bâtiment (lieu) de l'étage."), FormControls.fieldRow("Étage", flSel)));
      pickStatus = document.createElement("div"); pickStatus.className = "form-hint"; root.appendChild(pickStatus);
      const rebuildFloors = () => {
        const L = locSel!.value || "", keep = flSel!.value;
        const avail = FLOORS.filter((fv) => !floorExists(L, fv));
        flSel!.innerHTML = "";
        if (!avail.length) {
          const o = document.createElement("option"); o.value = ""; o.textContent = "(tous les étages existent déjà)"; flSel!.appendChild(o);
          pickStatus!.innerHTML = "<span style=\"color:var(--warn)\">⚠ Tous les étages de ce bâtiment existent déjà.</span> Ouvrez-les via la carte « Plan d'étage ».";
        } else {
          avail.forEach((fv) => { const o = document.createElement("option"); o.value = fv; o.textContent = "Étage " + fv; flSel!.appendChild(o); });
          if (avail.includes(keep)) flSel!.value = keep; else if (avail.includes(fl)) flSel!.value = fl;
          pickStatus!.innerHTML = "<span style=\"color:var(--ok)\">✓ Nouvel étage</span> — les étages déjà existants sont exclus de la liste.";
        }
      };
      locSel.addEventListener("change", rebuildFloors); rebuildFloors();
    } else {
      const head = document.createElement("div"); head.className = "form-hint";
      head.textContent = "Plan de l'étage « " + (fl || "0") + " » du bâtiment « " + (FloorLayout.locationLabel(location) || "—") + " ». Dimensions en mm. Les cases inaccessibles se marquent dans le plan d'étage.";
      root.appendChild(head);
    }
    const wI = FormControls.number(f.width_mm, { min: 1, step: 500 });
    const dI = FormControls.number(f.depth_mm, { min: 1, step: 500 });
    const cI = FormControls.number(f.cell_mm, { min: 1, step: 100 });
    root.appendChild(row2(FormControls.fieldRow("Largeur (mm)", wI), FormControls.fieldRow("Profondeur (mm)", dI), FormControls.fieldRow("Maille (mm)", cI, "Pas de la grille du plan (défaut 1000 = 1 m).")));
    const axI = FormControls.number(f.anchor_x || 0, { step: 100 });
    const ayI = FormControls.number(f.anchor_y || 0, { step: 100 });
    root.appendChild(row2(FormControls.fieldRow("Ancrage X (mm)", axI, "Décalage du plan d'étage dans la pile 3D — aligner / décaler les étages entre eux."), FormControls.fieldRow("Ancrage Y (mm)", ayI)));
    const descI = FormControls.textArea(f.description || "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    host.openModal({
      title: pick ? "Nouvel étage" : (existing ? "Modifier le plan d'étage" : "Nouveau plan d'étage"),
      subtitle: pick ? "" : ((FloorLayout.locationLabel(location) || "") + " · ét. " + (fl || "0")),
      body: root, wide: true,
      onSave: async () => {
        const L = pick ? (locSel!.value || "") : (location || ""), F = pick ? String(flSel!.value || "").trim() : fl;
        if (pick && !F) { Notify.toast("Aucun étage à créer : tous les étages de ce bâtiment existent déjà", "err"); return false; }
        if (pick && floorExists(L, F)) { Notify.toast("Cet étage existe déjà — ouvert"); opts.onPicked?.(L, F); return true; }
        const ex: any = store.floorFor(L, F);
        const payload = { location: L, floor: F, width_mm: Math.max(1, parseInt(wI.value, 10) || FLOOR_WIDTH_DEFAULT), depth_mm: Math.max(1, parseInt(dI.value, 10) || FLOOR_DEPTH_DEFAULT), cell_mm: Math.max(1, parseInt(cI.value, 10) || FLOOR_CELL_DEFAULT), anchor_x: parseInt(axI.value, 10) || 0, anchor_y: parseInt(ayI.value, 10) || 0, description: descI.value.trim() };
        if (ex) await store.update("floors", ex.id, payload); else await store.create("floors", payload);
        host.setDirty?.(true); Notify.toast(pick ? "Étage créé" : "Plan d'étage enregistré");
        if (pick) opts.onPicked?.(L, F);
        return true;
      },
    });
  }

  static ipNetwork(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("ipNetworks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", "ex. LAN Prod, DMZ…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    const cidrI = FormControls.text(net ? net.cidr : "", "ex. 10.0.0.0/24");
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => {
      const c = Ip.parseCidr(cidrI.value);
      if (!cidrI.value.trim()) { hint.textContent = "Sous-réseau IPv4 « adresse/préfixe »."; hint.style.color = ""; return; }
      if (!c) { hint.textContent = "⚠ CIDR IPv4 invalide."; hint.style.color = "var(--err)"; return; }
      hint.style.color = "";
      hint.innerHTML = `Réseau <strong>${c.networkStr}</strong> · diffusion <strong>${c.broadcastStr}</strong> · ${c.hostCount} hôte(s)`;
    };
    cidrI.addEventListener("input", refresh); refresh();
    root.appendChild(FormControls.fieldRow("CIDR", cidrI)); root.appendChild(hint);
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: net ? "Modifier le réseau IP" : "Nouveau réseau IP",
      subtitle: net ? Html.escape(Ip.short(net)) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        const c = Ip.parseCidr(cidrI.value);
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        if (!c) { Notify.toast("CIDR IPv4 invalide (ex. 10.0.0.0/24)", "err"); return false; }
        const cidr = c.networkStr + "/" + c.prefix;
        if (net) {
          const bad = store.ipAddressesOfNetwork(net.id).find((a: any) => !Ip.inCidr(Ip.toInt(a.address), c));
          if (bad) { Notify.toast(`L'adresse ${bad.address} ne serait plus dans ${cidr}.`, "err"); return false; }
          const badR = store.dhcpRangesOfNetwork(net.id).find((r: any) => !Ip.inCidr(Ip.toInt(r.start_ip), c) || !Ip.inCidr(Ip.toInt(r.end_ip), c));
          if (badR) { Notify.toast(`La plage DHCP ${badR.start_ip}→${badR.end_ip} ne serait plus dans ${cidr}.`, "err"); return false; }
        }
        const payload = { label, cidr, description: descI.value.trim() };
        if (net) await store.update("ipNetworks", net.id, payload); else await store.create("ipNetworks", payload);
        host.setDirty?.(true); Notify.toast(net ? "Réseau IP mis à jour" : "Réseau IP créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Adresse IP statique. */
  static ipAddress(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const addr: any = id ? store.get("ipAddresses", id) : null;
    if (!addr && !store.all("ipNetworks").length) { Notify.toast("Créez d'abord un réseau IP.", "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(ipNetOptions(store), addr ? addr.network_id : "");
    root.appendChild(FormControls.fieldRow("Réseau IP", netSel));
    const ipWrap = document.createElement("div"); ipWrap.style.display = "flex"; ipWrap.style.gap = "8px";
    const ipI = FormControls.text(addr ? addr.address : "", "ex. 10.0.0.10"); ipI.style.flex = "1"; ipI.style.fontFamily = "var(--mono)";
    const freeBtn = document.createElement("button"); freeBtn.type = "button"; freeBtn.className = "btn btn-ghost btn-sm"; freeBtn.textContent = "Proposer libre";
    freeBtn.onclick = () => { const f = Ip.nextFree(store, netSel.value); if (f) ipI.value = f; else Notify.toast("Aucune adresse libre.", "err"); };
    ipWrap.appendChild(ipI); ipWrap.appendChild(freeBtn);
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? `Plage assignable : <strong>${Ip.toStr(c.firstHost)}</strong> → <strong>${Ip.toStr(c.lastHost)}</strong>` : "Choisissez un réseau au CIDR valide."; };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow("Adresse IP", ipWrap)); root.appendChild(hint);
    const hostI = FormControls.text(addr ? addr.hostname : "", "ex. srv-web-01.lan"); hostI.style.fontFamily = "var(--mono)";
    root.appendChild(FormControls.fieldRow("Hostname", hostI, "Facultatif."));
    const eqSel = FormControls.select(eqOptions(store, "— aucun —"), addr ? (addr.equipment_id || "") : "");
    root.appendChild(FormControls.fieldRow("Équipement", eqSel, "Facultatif."));
    const descI = FormControls.textArea(addr ? addr.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: addr ? "Modifier l'adresse IP" : "Nouvelle adresse IP",
      subtitle: addr ? Html.escape(addr.address) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId); const c = Ip.cidrOf(net);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        if (!c) { Notify.toast("Le réseau choisi a un CIDR invalide.", "err"); return false; }
        const address = ipI.value.trim();
        const ipInt = Ip.toInt(address);
        if (ipInt == null) { Notify.toast("Adresse IPv4 invalide.", "err"); return false; }
        if (!Ip.inCidr(ipInt, c)) { Notify.toast(`${address} n'appartient pas à ${net.cidr}.`, "err"); return false; }
        const dup = store.ipAddressByValue(address);
        if (dup && (!addr || dup.id !== addr.id)) { Notify.toast(`L'adresse ${address} est déjà attribuée.`, "err"); return false; }
        const conflict = Ip.dhcpRangeContaining(store, networkId, ipInt);
        if (conflict) { Notify.toast(`${address} est dans la plage DHCP ${conflict.start_ip}→${conflict.end_ip}.`, "err"); return false; }
        const payload = { network_id: networkId, address, hostname: hostI.value.trim(), equipment_id: eqSel.value || null, description: descI.value.trim() };
        if (addr) await store.update("ipAddresses", addr.id, payload); else await store.create("ipAddresses", payload);
        host.setDirty?.(true); Notify.toast(addr ? "Adresse mise à jour" : "Adresse attribuée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!addr) netSel.focus(); else ipI.focus(); }, 30);
  }

  /** Plage DHCP réservée. */
  static dhcpRange(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const rng: any = id ? store.get("dhcpRanges", id) : null;
    if (!rng && !store.all("ipNetworks").length) { Notify.toast("Créez d'abord un réseau IP.", "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(ipNetOptions(store), rng ? rng.network_id : "");
    root.appendChild(FormControls.fieldRow("Réseau IP", netSel));
    const startI = FormControls.text(rng ? rng.start_ip : "", "ex. 10.0.0.100"); startI.style.fontFamily = "var(--mono)";
    const endI = FormControls.text(rng ? rng.end_ip : "", "ex. 10.0.0.200"); endI.style.fontFamily = "var(--mono)";
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? `Bornes dans : <strong>${c.networkStr}</strong> → <strong>${c.broadcastStr}</strong>` : "Choisissez un réseau au CIDR valide."; };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow("Début de plage", startI));
    root.appendChild(FormControls.fieldRow("Fin de plage", endI)); root.appendChild(hint);
    const srvSel = FormControls.select(eqOptions(store, "— non désigné —"), rng ? (rng.server_id || "") : "");
    root.appendChild(FormControls.fieldRow("Serveur DHCP", srvSel, "Facultatif."));
    const descI = FormControls.textArea(rng ? rng.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: rng ? "Modifier la plage DHCP" : "Nouvelle plage DHCP",
      subtitle: rng ? Html.escape(rng.start_ip + " → " + rng.end_ip) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId); const c = Ip.cidrOf(net);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        if (!c) { Notify.toast("Le réseau choisi a un CIDR invalide.", "err"); return false; }
        const s = Ip.toInt(startI.value.trim()), e = Ip.toInt(endI.value.trim());
        if (s == null) { Notify.toast("Adresse de début invalide.", "err"); return false; }
        if (e == null) { Notify.toast("Adresse de fin invalide.", "err"); return false; }
        if (e < s) { Notify.toast("La fin de plage doit être ≥ au début.", "err"); return false; }
        if (!Ip.inCidr(s, c) || !Ip.inCidr(e, c)) { Notify.toast(`Les bornes doivent appartenir à ${net.cidr}.`, "err"); return false; }
        const overlap = store.dhcpRangesOfNetwork(networkId).find((r: any) => {
          if (rng && r.id === rng.id) return false;
          const rs = Ip.toInt(r.start_ip), re = Ip.toInt(r.end_ip);
          return rs != null && re != null && s <= re && rs <= e;
        });
        if (overlap) { Notify.toast(`Chevauche la plage ${overlap.start_ip}→${overlap.end_ip}.`, "err"); return false; }
        const staticHit = store.ipAddressesOfNetwork(networkId).find((a: any) => { const n = Ip.toInt(a.address); return n != null && n >= s && n <= e; });
        if (staticHit) { Notify.toast(`L'IP statique ${staticHit.address} est dans cette plage.`, "err"); return false; }
        const payload = { network_id: networkId, start_ip: Ip.toStr(s), end_ip: Ip.toStr(e), server_id: srvSel.value || null, description: descI.value.trim() };
        if (rng) await store.update("dhcpRanges", rng.id, payload); else await store.create("dhcpRanges", payload);
        host.setDirty?.(true); Notify.toast(rng ? "Plage DHCP mise à jour" : "Plage DHCP réservée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!rng) netSel.focus(); else startI.focus(); }, 30);
  }

  /* =============================================================================
     Assignation d'un EMPLACEMENT LIBRE (clic 3D sur un slot d'une baie). Réplique OO des
     fonctions assignSlot/assignSideSlot/assignWallSlot/assignCapSlot du monolithe.
     ============================================================================= */

  private static faceLabel(id: string): string { return (RACK_FACES.find((f) => f.id === id) || { label: id }).label; }
  private static mountDepthLabel(e: any): string { return (e && e.depth_mm != null) ? (e.depth_mm + " mm") : Depths.label((e && e.depth) || "full"); }

  /** Assigner un emplacement U libre : équipement non placé, pseudo-élément, ou brosse de brassage. */
  static async assignSlot(store: Store, host: FormHost, rackId: string, u: number, side: string, height: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast("Baie introuvable", "err"); return; }
    side = (rack.sides === "dual" && side === "rear") ? "rear" : "front";
    const span = Math.max(1, parseInt(String(height), 10) || 1);
    const scene = new RackScene(store);
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = "Position : U" + u + (span > 1 ? "–U" + (u + span - 1) + " (" + span + " U)" : "") + (rack.sides === "dual" ? " · " + Forms.faceLabel(side) : "") + " — " + (rack.name || "rack");
    body.appendChild(posHint);
    const eqFree = store.unrackedEquipments().filter((e: any) => span === 1 || (e.u_height || 1) === span).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const noEqLabel = eqFree.length ? "— choisir —" : (span > 1 ? "(aucun équipement de " + span + " U)" : "(aucun équipement libre)");
    const kindOpts = [{ value: "equipment", label: "Équipement…" }].concat(RackItemKinds.ALL.map((k) => ({ value: k.id, label: k.label })));
    if (rack.datacenter_id) kindOpts.push({ value: "brush", label: "▦ Brosse de brassage" });
    const kindI = FormControls.select(kindOpts, "equipment");
    body.appendChild(FormControls.fieldRow("Élément", kindI));
    const targetDc = rack.datacenter_id || null;
    const blockedWhy = (eid: string) => targetDc ? store.equipmentPlacementBlockedReason(eid, targetDc) : null;
    const eqI = FormControls.select([{ value: "", label: noEqLabel }].concat(eqFree.map((e: any) => {
      const why = blockedWhy(e.id);
      return { value: e.id, label: (e.name || "(sans nom)") + " · " + (e.u_height || 1) + "U " + Forms.mountDepthLabel(e) + (why ? " — ⚠ " + why : ""), disabled: !!why };
    })), "");
    const eqHint = span > 1 ? "Équipements de " + span + " U uniquement (taille sélectionnée)." : "Dimensions reprises de l'équipement.";
    const eqRow = FormControls.fieldRow("Équipement", eqI, eqHint); body.appendChild(eqRow);
    const labelI = FormControls.text("", "libellé (optionnel)"); const labelRow = FormControls.fieldRow("Libellé", labelI); body.appendChild(labelRow);
    const pheightI = FormControls.number(String(span), { min: 1, step: 1 });
    const prow = FormControls.fieldRow("Hauteur (U)", pheightI); body.appendChild(prow);
    const bdepthI = FormControls.number("100", { min: 1, step: 10 });
    const bdepthRow = FormControls.fieldRow("Profondeur brosse (mm)", bdepthI, "Profondeur de la brosse (≤ cage de la baie). Les câbles la traversent (répartis sur sa section)."); body.appendChild(bdepthRow);
    const isEq = () => kindI.value === "equipment";
    const isBrush = () => kindI.value === "brush";
    const selEq = () => store.get("equipments", eqI.value);
    const effMount = () => isEq() ? { depth: (selEq() ? selEq().depth : "full"), side, locks_u: (selEq() ? RackGeometry.mountLocksU(selEq()) : false) } : { side, isItem: true };
    const effHeight = () => isEq() ? (selEq() ? Math.max(1, selEq().u_height || 1) : 1) : Math.max(1, parseInt(pheightI.value, 10) || 1);
    const brushSides = () => (rack.sides === "dual") ? ["front", "rear"] : ["front"];
    const syncVis = () => { const e = isEq(), b = isBrush(); eqRow.style.display = e ? "" : "none"; labelRow.style.display = e ? "none" : ""; prow.style.display = e ? "none" : ""; bdepthRow.style.display = b ? "" : "none"; };
    kindI.onchange = syncVis; syncVis();
    const res = await Dialog.custom({
      title: "Assigner — U" + u + (span > 1 ? "–U" + (u + span - 1) : ""), confirmLabel: "Assigner",
      build: (r) => { r.appendChild(body); return {
        validate: () => {
          if (isBrush()) {
            if (!rack.datacenter_id) return "La baie doit être posée dans une salle pour y poser une brosse.";
            if (!RackGeometry.canPlace(rack, u, effHeight(), brushSides(), scene.occupants(rack.id))) return "Ça ne tient pas ici (occupé ou dépasse la baie).";
            return true;
          }
          if (isEq() && !eqI.value) return "Choisissez un équipement.";
          if (isEq()) { const why = blockedWhy(eqI.value); if (why) return "Placement impossible : " + why; }
          if (!RackGeometry.canPlace(rack, u, effHeight(), RackGeometry.mountSides(effMount(), rack), scene.occupants(rack.id))) return "Ça ne tient pas ici (occupé ou dépasse la baie).";
          return true;
        },
        collect: () => ({ kind: kindI.value, equipment_id: eqI.value || null, label: labelI.value.trim(), height: effHeight(), depth_mm: Math.max(1, parseInt(bdepthI.value, 10) || 100) }),
      }; },
    });
    if (!res) return;
    if (res.kind === "equipment") { await store.update("equipments", res.equipment_id, { placement_mode: "rack", rack_id: rack.id, rack_u: u, rack_side: side }); Notify.toast("Équipement assigné"); }
    else if (res.kind === "brush") {
      await store.create("waypoints", { name: res.label || ("Brosse " + (store.all("waypoints").length + 1)), wp_type: "datacenter", kind: "brush",
        datacenter_id: rack.datacenter_id, rack_id: rack.id, rack_u: u, u_height: res.height, depth_mm: res.depth_mm, floor: "",
        dc_x: null, dc_y: null, dc_x2: null, dc_y2: null });
      Notify.toast("Brosse créée");
    } else { await store.create("rackItems", { rack_id: rack.id, u, u_height: res.height, side, kind: res.kind, label: res.label }); Notify.toast("Élément monté"); }
    host.setDirty?.(true); onDone?.();
  }

  /** Monter dans un emplacement LATÉRAL libre : équipement non placé OU pin (point de passage). */
  static async assignSideSlot(store: Store, host: FormHost, rackId: string, face: string, lr: string, col: number, uTop: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast("Baie introuvable", "err"); return; }
    if (!RackGeometry.sideEnabled(rack, face)) { Notify.toast("Montage latéral non autorisé sur cette face.", "err"); return; }
    const scene = new RackScene(store);
    const colW = RackGeometry.sideColWidthMm(rack);
    const effFreeH = (e: any) => (e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM);
    const effHeightU = (e: any) => Math.max(1, Math.ceil(effFreeH(e) / U_MM));
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = "Emplacement latéral : marge " + (lr === "left" ? "gauche" : "droite") + (RackGeometry.sideColumns(rack) > 1 ? " · col " + (col + 1) : "") + " · U" + uTop + (rack.sides === "dual" ? " · " + Forms.faceLabel(face) : "") + " · colonne de " + Math.round(colW) + " mm.";
    body.appendChild(posHint);
    const targetDc = rack.datacenter_id || null;
    const blockedWhy = (eid: string) => targetDc ? store.equipmentPlacementBlockedReason(eid, targetDc) : null;
    const eqFree = store.unrackedEquipments().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const tooWide = (e: any) => (e.free_w_mm != null) && e.free_w_mm > colW + 0.5;
    const kindI = FormControls.select([{ value: "equipment", label: "Équipement" }, { value: "pin", label: "Pin (point de passage)" }], "equipment");
    body.appendChild(FormControls.fieldRow("Élément", kindI));
    const eqI = FormControls.select([{ value: "", label: eqFree.length ? "— choisir —" : "(aucun équipement libre)" }].concat(eqFree.map((e: any) => {
      const why = blockedWhy(e.id), wide = tooWide(e);
      return { value: e.id, label: (e.name || "(sans nom)") + (e.free_w_mm != null ? " · " + e.free_w_mm + " mm large" : "") + (wide ? " — ⚠ trop large" : "") + (why ? " — ⚠ " + why : ""), disabled: !!why || wide };
    })), "");
    const eqRow = FormControls.fieldRow("Équipement", eqI, "Monté dans la marge (dimensions libres ; ajustées à la colonne si besoin)."); body.appendChild(eqRow);
    let snap = "post";
    const snapT = FormControls.toggle("Coller à la paroi (sinon au montant)", false, (v) => { snap = v ? "wall" : "post"; }, { block: true });
    body.appendChild(snapT);
    const pinNameI = FormControls.text("PIN " + (store.all("waypoints").length + 1), "ex. PIN brassage");
    const pinRow = FormControls.fieldRow("Nom du pin", pinNameI, "Pin verrouillé au CENTRE de ce slot latéral (point de passage de câbles)."); body.appendChild(pinRow);
    const isPin = () => kindI.value === "pin";
    const syncKind = () => { const pin = isPin(); eqRow.style.display = pin ? "none" : ""; snapT.style.display = pin ? "none" : ""; pinRow.style.display = pin ? "" : "none"; };
    kindI.onchange = syncKind; syncKind();
    const res = await Dialog.custom({
      title: "Montage latéral — U" + uTop, confirmLabel: "Monter",
      build: (r) => { r.appendChild(body); return {
        validate: () => {
          if (isPin()) return scene.sideSlotFree(rack.id, face, lr, col, uTop, SIDE_U_STEP, null) ? true : "L'emplacement est occupé.";
          if (!eqI.value) return "Choisissez un équipement.";
          const why = blockedWhy(eqI.value); if (why) return "Placement impossible : " + why;
          const e = store.get("equipments", eqI.value); if (!e) return "Équipement introuvable.";
          if (uTop + effHeightU(e) - 1 > (rack.u_count || 42)) return "L'équipement dépasse le haut de la baie.";
          if (!scene.sideSlotFree(rack.id, face, lr, col, uTop, effHeightU(e), e.id)) return "L'emplacement (ou les U au-dessus) est occupé.";
          return true;
        },
        collect: () => isPin() ? { kind: "pin", name: pinNameI.value.trim() } : { kind: "equipment", eid: eqI.value },
      }; },
    });
    if (!res) return;
    if (res.kind === "pin") {
      await store.create("waypoints", { name: res.name || "PIN", kind: "point", wp_type: "datacenter", datacenter_id: rack.datacenter_id, rack_id: rack.id, side_face: face, side_lr: lr, side_col: col, side_u: uTop });
      Notify.toast("Pin latéral posé"); host.setDirty?.(true); onDone?.(); return;
    }
    const e = store.get("equipments", res.eid); if (!e) return;
    const free_w_mm = (e.free_w_mm != null) ? Math.min(e.free_w_mm, Math.round(colW)) : Math.round(Math.min(colW, 50));
    const free_h_mm = (e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM);
    const free_l_mm = (e.free_l_mm != null) ? e.free_l_mm : Math.min(RackGeometry.cageDepth(rack), 300);
    await store.update("equipments", res.eid, { placement_mode: "side", dim_mode: "free", rack_id: rack.id, rack_u: null, rack_side: "front", side_face: face, side_lr: lr, side_col: col, side_u: uTop, side_snap: snap, free_w_mm, free_h_mm, free_l_mm });
    Notify.toast("Équipement monté latéralement"); host.setDirty?.(true); await store.applyCableBreaks(res.eid); onDone?.();
  }

  /** Monter un équipement dans un emplacement MURAL libre (paroi, face vers le centre ou la façade). */
  static async assignWallSlot(store: Store, host: FormHost, rackId: string, wall: string, margin: string, col: number, uTop: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast("Baie introuvable", "err"); return; }
    if (!RackGeometry.wallEnabled(rack, margin)) { Notify.toast("Montage en paroi indisponible (marge insuffisante).", "err"); return; }
    const scene = new RackScene(store);
    const g = RackGeometry.wallGeo(rack, margin);
    const effHeightU = (e: any) => Math.max(1, Math.ceil(((e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM)) / U_MM));
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = "Paroi " + (wall === "left" ? "gauche" : "droite") + " · marge " + (margin === "rear" ? "arrière" : "avant") + (g.cols > 1 ? " · col " + (col + 1) : "") + " · U" + uTop + " · profondeur de marge " + Math.round(g.dep) + " mm.";
    body.appendChild(posHint);
    const targetDc = rack.datacenter_id || null;
    const blockedWhy = (eid: string) => targetDc ? store.equipmentPlacementBlockedReason(eid, targetDc) : null;
    const eqFree = store.unrackedEquipments().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const eqI = FormControls.select([{ value: "", label: eqFree.length ? "— choisir —" : "(aucun équipement libre)" }].concat(eqFree.map((e: any) => {
      const why = blockedWhy(e.id);
      return { value: e.id, label: (e.name || "(sans nom)") + (why ? " — ⚠ " + why : ""), disabled: !!why };
    })), "");
    body.appendChild(FormControls.fieldRow("Équipement", eqI, "Monté contre la paroi (dimensions libres)."));
    const orientI = FormControls.select([{ value: "center", label: "Face vers le CENTRE du rack (⊥)" }, { value: "facade", label: "Face vers la FAÇADE de la marge" }], "center");
    body.appendChild(FormControls.fieldRow("Orientation de la face", orientI));
    const res = await Dialog.custom({
      title: "Montage en paroi — U" + uTop, confirmLabel: "Monter",
      build: (r) => { r.appendChild(body); return {
        validate: () => {
          if (!eqI.value) return "Choisissez un équipement.";
          const why = blockedWhy(eqI.value); if (why) return "Placement impossible : " + why;
          const e = store.get("equipments", eqI.value); if (!e) return "Équipement introuvable.";
          if (uTop + effHeightU(e) - 1 > (rack.u_count || 42)) return "L'équipement dépasse le haut de la baie.";
          if (!scene.wallSlotFree(rack.id, wall, margin, col, uTop, effHeightU(e), e.id)) return "L'emplacement (ou les U au-dessus) est occupé.";
          return true;
        },
        collect: () => ({ eid: eqI.value, orient: orientI.value === "facade" ? "facade" : "center" }),
      }; },
    });
    if (!res) return;
    const e = store.get("equipments", res.eid); if (!e) return;
    const free_w_mm = (e.free_w_mm != null) ? e.free_w_mm : Math.round(Math.min(g.colW, 80));
    const free_h_mm = (e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM);
    const free_l_mm = (e.free_l_mm != null) ? e.free_l_mm : Math.min(Math.round(g.dep), 150);
    await store.update("equipments", res.eid, { placement_mode: "wall", dim_mode: "free", rack_id: rack.id, rack_u: null, rack_side: "front",
      wall_lr: wall, wall_margin: margin, wall_col: col, wall_u: uTop, wall_orient: res.orient, free_w_mm, free_h_mm, free_l_mm });
    Notify.toast("Équipement monté en paroi"); host.setDirty?.(true); await store.applyCableBreaks(res.eid); onDone?.();
  }

  /** Poser un Waypoint Pin dans un trou de capot libre (toit/sol), verrouillé au centre de la cellule. */
  static async assignCapSlot(store: Store, host: FormHost, rackId: string, face: string, cx: number, cy: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast("Baie introuvable", "err"); return; }
    if (!rack.datacenter_id) { Notify.toast("La baie doit être posée dans une salle", "err"); return; }
    const scene = new RackScene(store);
    if (scene.capSlotOccupied(rackId, face, cx, cy, null)) { Notify.toast("L'emplacement est occupé.", "err"); return; }
    const faceLbl = (face === "floor") ? "sol" : "toit";
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = "Emplacement : " + faceLbl + " · cellule (" + cx + ", " + cy + ") — pin verrouillé au centre du trou.";
    body.appendChild(posHint);
    const pinNameI = FormControls.text("PIN " + (store.all("waypoints").length + 1), "ex. PIN passage " + faceLbl);
    body.appendChild(FormControls.fieldRow("Nom du pin", pinNameI, "Point de passage de câbles verrouillé au centre de ce trou de capot."));
    const res = await Dialog.custom({
      title: "Pose pin — " + faceLbl, confirmLabel: "Poser",
      build: (r) => { r.appendChild(body); return {
        validate: () => scene.capSlotOccupied(rack.id, face, cx, cy, null) ? "L'emplacement est occupé." : true,
        collect: () => ({ name: pinNameI.value.trim() }),
      }; },
    });
    if (!res) return;
    await store.create("waypoints", { name: res.name || "PIN", kind: "point", wp_type: "datacenter", datacenter_id: rack.datacenter_id, rack_id: rack.id, cap_face: face, cap_cx: cx, cap_cy: cy });
    Notify.toast("Pin de capot posé"); host.setDirty?.(true); onDone?.();
  }
}
