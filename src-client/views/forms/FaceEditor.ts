/* =============================================================================
   ÉDITEUR DE FAÇADE — sous-éditeur EXTRAIT d'EquipmentForms (P4 : la méthode de
   ~210 lignes y était un mini-monolithe) : pose des ports sur les faces d'un
   équipement (face_x/face_y/face_side) avec onglets de face, zoom/pan, snap de
   grille, oreilles 19″, « Tout poser / enlever », palette des ports non posés,
   et SÉLECTEUR d'image de façade (bibliothèque, filtres face/U/oreilles, import).

   Étend FormBase pour réutiliser ses statiques protégées (images, faceAnnex,
   eligibleImages, promptImageFile…) SANS rejoindre la chaîne d'héritage Forms.
   ============================================================================= */
import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Text } from "../../core/Text";
import { EquipFaces } from "../../registries/EquipFaces";
import { PortRoles } from "../../registries/PortRoles";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { LeaderLayout, LeaderAnchor } from "../../geometry/LeaderLayout";
import { EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD, RACK_MOUNT_WIDTH } from "../../domain/constants";
import { RackGeometry } from "../../geometry/RackGeometry";
import type { FormHost } from "./shared";
import { FormBase } from "./FormBase";
import { EquipmentForms } from "./EquipmentForms";   // modale complète de création d'image (import « + Importer »)
import { I18n } from "../../i18n/I18n";

export class FaceEditor extends FormBase {
  /** Éditeur de FAÇADE (sous-éditeur empilé) : pose les ports sur les faces de l'équipement
      (face_x/face_y/face_side) — onglets de face, glisser, snap de grille, « Tout poser / enlever »,
      palette des ports non posés. `opts.onApply({fids,place})` reporte sur le brouillon du formulaire
      parent ; sinon écrit dans le store. Les IMAGES de façade (bibliothèque IndexedDB) sont d'une phase
      ultérieure : on PRÉSERVE les références d'image existantes (fids) et on permet de les détacher. */
  static open(store: Store, host: FormHost, eqId: string, opts: any = {}): void {
    const eq: any = store.get("equipments", eqId);
    if (!eq) { Notify.toast(I18n.t("equipment.notFound"), "err"); return; }
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
    faces.forEach((f) => { const b = document.createElement("button"); b.type = "button"; b.textContent = EquipFaces.label(f); b.onclick = () => { side = f; setZoom(1); render(); }; tabBtns[f] = b; tabs.appendChild(b); });
    root.appendChild(tabs);

    const FACE_GRID_PRESETS = [
      { id: "free", label: I18n.t("face.gridFree"), cols: 0, rows: 0 }, { id: "g6x1", label: I18n.t("face.grid", { cols: 6, rows: 1 }), cols: 6, rows: 1 },
      { id: "g12x1", label: I18n.t("face.grid", { cols: 12, rows: 1 }), cols: 12, rows: 1 }, { id: "g12x2", label: I18n.t("face.grid", { cols: 12, rows: 2 }), cols: 12, rows: 2 },
      { id: "g24x1", label: I18n.t("face.grid", { cols: 24, rows: 1 }), cols: 24, rows: 1 }, { id: "g24x2", label: I18n.t("face.grid", { cols: 24, rows: 2 }), cols: 24, rows: 2 },
      { id: "g24x4", label: I18n.t("face.grid", { cols: 24, rows: 4 }), cols: 24, rows: 4 }, { id: "g48x2", label: I18n.t("face.grid", { cols: 48, rows: 2 }), cols: 48, rows: 2 },
    ];
    let grid: { cols: number; rows: number } | null = null;
    let gridVisible = true;   // la grille peut être MASQUÉE tout en restant ACTIVE (le snap continue).
    // Oreilles 19″ : le CORPS (zone de placement des ports) = fraction du panneau occupée par le BOÎTIER — pleine
    // largeur (oreilles standard EAR_FRAC de chaque côté) ou RÉTRÉCIE (u_width_mm + u_align : les oreilles
    // s'étendent des rails jusqu'au boîtier, asymétriques). Fractions PAR FACE : l'arrière est un MIROIR
    // horizontal (le décalage d'alignement s'inverse vu de derrière). Parité avec DcThreeScene / Resolver3D.
    const bodyW = RackGeometry.eqBodyWidth(eq), bodyOff = RackGeometry.eqBodyOffsetX(eq);
    const BODY_FRAC = bodyW / RACK_MOUNT_WIDTH;
    const bodyLeftFrac = (f: string): number => {
      const off = (f === "rear") ? -bodyOff : bodyOff;   // vu de la face : miroir à l'arrière
      return (RACK_MOUNT_WIDTH / 2 + off - bodyW / 2) / RACK_MOUNT_WIDTH;
    };
    const panelMode = !isFree;
    // Affichage des ports : "chip" (label SUR le port, défaut) | "leader" (pastille + label déporté relié).
    let portDisplay: "chip" | "leader" = "chip";
    // Pose des ports : "auto" (clic port = pose au centre) | "click" (clic port = active, clic sur la face = pose).
    let placeMode: "auto" | "click" = "auto";
    let activePortId: string | null = null;   // port ACTIVÉ (mode 2 clics) : les autres ports posés sont masqués.
    const tools = document.createElement("div"); tools.className = "face-toolbar";
    const attachBtn = document.createElement("button"); attachBtn.type = "button"; attachBtn.className = "btn btn-ghost btn-sm"; attachBtn.textContent = I18n.t("face.attachImage");
    const detachBtn = document.createElement("button"); detachBtn.type = "button"; detachBtn.className = "btn btn-ghost btn-sm"; detachBtn.textContent = I18n.t("face.detachImage");
    const addAllBtn = document.createElement("button"); addAllBtn.type = "button"; addAllBtn.className = "btn btn-ghost btn-sm"; addAllBtn.textContent = I18n.t("face.placeAll"); addAllBtn.title = I18n.t("face.placeAllTitle");
    const removeAllBtn = document.createElement("button"); removeAllBtn.type = "button"; removeAllBtn.className = "btn btn-ghost btn-sm"; removeAllBtn.textContent = I18n.t("face.removeAll");
    const placeBtn = document.createElement("button"); placeBtn.type = "button"; placeBtn.className = "btn btn-ghost btn-sm"; placeBtn.textContent = I18n.t("face.place2"); placeBtn.title = I18n.t("face.place2Title");
    const leaderBtn = document.createElement("button"); leaderBtn.type = "button"; leaderBtn.className = "btn btn-ghost btn-sm"; leaderBtn.textContent = I18n.t("face.leaders"); leaderBtn.title = I18n.t("face.leadersTitle");
    const gridLab = document.createElement("span"); gridLab.style.cssText = "font-size:11px;color:var(--fg-dim);margin-left:6px;"; gridLab.textContent = I18n.t("face.gridLabel");
    const gridSel = FormControls.select(FACE_GRID_PRESETS.map((g) => ({ value: g.id, label: g.label })), "free"); gridSel.style.cssText = "font-size:11px;padding:4px 6px;";
    const gridShowBtn = document.createElement("button"); gridShowBtn.type = "button"; gridShowBtn.className = "btn btn-ghost btn-sm"; gridShowBtn.title = I18n.t("face.gridToggleTitle");
    // Zoom (molette + boutons ; glisser le fond = déplacer) : utile sur les faces denses / gros équipements.
    const zoomOutBtn = document.createElement("button"); zoomOutBtn.type = "button"; zoomOutBtn.className = "btn btn-ghost btn-sm"; zoomOutBtn.textContent = "−"; zoomOutBtn.title = I18n.t("ui.zoom.out");
    const zoomLab = document.createElement("span"); zoomLab.style.cssText = "font-size:11px;color:var(--fg-dim);min-width:36px;text-align:center;";
    const zoomInBtn = document.createElement("button"); zoomInBtn.type = "button"; zoomInBtn.className = "btn btn-ghost btn-sm"; zoomInBtn.textContent = "+"; zoomInBtn.title = I18n.t("ui.zoom.in");
    const zoomResetBtn = document.createElement("button"); zoomResetBtn.type = "button"; zoomResetBtn.className = "btn btn-ghost btn-sm"; zoomResetBtn.textContent = I18n.t("ui.zoom.fitLabel"); zoomResetBtn.title = I18n.t("face.zoomResetTitle");
    const zoomGroup = document.createElement("span"); zoomGroup.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin-left:6px;"; zoomGroup.append(zoomOutBtn, zoomLab, zoomInBtn, zoomResetBtn);
    tools.append(attachBtn, detachBtn, placeBtn, leaderBtn, addAllBtn, removeAllBtn, gridLab, gridSel, gridShowBtn, zoomGroup); root.appendChild(tools);

    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = I18n.t("face.hint");
    root.appendChild(hint);
    // VIEWPORT (clipping) → FRAME (zoom/pan) → STAGE (corps : grille + marqueurs). L'image et les oreilles vivent
    // dans le FRAME (l'image « avec oreilles » déborde sur les bandes latérales) ; le STAGE est au-dessus (z-index).
    const viewport = document.createElement("div"); viewport.className = "face-viewport";
    const frame = document.createElement("div"); frame.className = "face-frame";
    const stage = document.createElement("div"); frame.appendChild(stage);
    // Couche des ÉTIQUETTES DÉPORTÉES (mode leader) : recouvre TOUT le frame (marges incluses) — les
    // étiquettes peuvent vivre hors de la bande de façade. Lignes (SVG) + étiquettes ; non interactive.
    const leaderLayer = document.createElement("div"); leaderLayer.className = "face-leaders"; frame.appendChild(leaderLayer);
    viewport.appendChild(frame); root.appendChild(viewport);
    const palette = document.createElement("div"); palette.className = "face-palette"; root.appendChild(palette);

    // ---- zoom / pan : transform sur le frame, le viewport clippe. transform-origin: 0 0 (cf. CSS). ----
    let zoom = 1, panX = 0, panY = 0; const ZMIN = 1, ZMAX = 6;
    const applyZoom = () => {
      frame.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
      // CONTRE-ÉCHELLE des handles (marqueurs / pastilles / étiquettes) : taille d'écran FIXE au zoom pour un
      // placement précis (ils vivent dans le frame zoomé → sans ça ils grossiraient). Le CSS applique scale(var).
      frame.style.setProperty("--inv-zoom", String(1 / zoom));
      zoomLab.textContent = Math.round(zoom * 100) + " %";
      zoomOutBtn.disabled = zoom <= ZMIN + 1e-3; zoomInBtn.disabled = zoom >= ZMAX - 1e-3;
    };
    const setZoom = (z: number, cx?: number, cy?: number) => {
      const z0 = zoom, z1 = Math.max(ZMIN, Math.min(ZMAX, z));
      if (cx != null && cy != null && z1 !== z0) { panX = cx - (cx - panX) * (z1 / z0); panY = cy - (cy - panY) * (z1 / z0); }   // zoom centré sur le pointeur
      zoom = z1; if (zoom <= 1) { panX = 0; panY = 0; } applyZoom();
    };
    zoomInBtn.onclick = () => setZoom(zoom * 1.25); zoomOutBtn.onclick = () => setZoom(zoom / 1.25); zoomResetBtn.onclick = () => setZoom(1);
    viewport.addEventListener("wheel", (e) => { e.preventDefault(); const r = viewport.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    // glisser le FOND (hors marqueur, qui stoppe la propagation) → pan. Actif seulement si zoomé.
    viewport.addEventListener("pointerdown", (e) => {
      const ev = e as PointerEvent; if (activePortId || zoom <= 1 || ev.button !== 0) return;   // pose en 2 clics : pas de pan
      ev.preventDefault(); const sx = ev.clientX - panX, sy = ev.clientY - panY;
      const mv = (m: PointerEvent) => { panX = m.clientX - sx; panY = m.clientY - sy; applyZoom(); };
      const up = () => { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); };
      document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
    });

    const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;
    const snapToGrid = (x: number, y: number) => {
      if (!grid || !grid.cols || !grid.rows) return { x: clamp01(x), y: clamp01(y) };
      return { x: clamp01((Math.round(x * grid.cols - 0.5) + 0.5) / grid.cols), y: clamp01((Math.round(y * grid.rows - 0.5) + 0.5) / grid.rows) };
    };
    const faceWH = (f: string) => FreeEquipGeometry.faceWH(eq, f);   // dimensions par face (mutualisé, cf. FreeEquipGeometry)
    const faceWHof = (f: string) => isFree ? faceWH(f) : { W: 19, H: 1.75 * Math.max(1, (eq.u_height | 0) || 1) };   // baie = 19″ × hauteur U
    // MARGE VERTICALE (mode « étiquettes déportées ») : quand la face est ≥2× plus large que haute, on étend la
    // zone d'édition de +100% de la hauteur de face EN HAUT et EN BAS ; les étiquettes déportées y logent, la
    // façade reste dans la bande CENTRALE. Sinon (mode chip ou face non large) : aucune marge (bande = tout le frame).
    const vMargin = (f: string) => { const wh = faceWHof(f); return (portDisplay === "leader" && wh.W / wh.H >= 2) ? 1 : 0; };
    const bandTop = (f: string) => { const m = vMargin(f); return m / (1 + 2 * m); };   // fraction : haut de la façade dans le frame
    const bandH = (f: string) => { const m = vMargin(f); return 1 / (1 + 2 * m); };      // fraction : hauteur de la façade dans le frame
    // Dimensionne le FRAME en PRÉSERVANT le ratio de la face (libre = dims réelles ; baie = 19″ × hauteur U), marges
    // verticales incluses. On borne la HAUTEUR à MAXVH et la LARGEUR à MAXVH×ratio : sinon `width:100% + max-height`
    // casse le ratio (largeur pleine, hauteur bornée → la face carrée/haute s'aplatissait). Centré, jamais trop large.
    const applyFrameSize = (f: string) => {
      const el = frame, MAXVH = 60;
      const wh = faceWHof(f), totalH = wh.H * (1 + 2 * vMargin(f));
      el.style.aspectRatio = wh.W + " / " + totalH;
      el.style.width = "100%"; el.style.height = "auto"; el.style.margin = "0 auto";
      el.style.maxHeight = MAXVH + "vh";
      el.style.maxWidth = "calc(" + MAXVH + "vh * " + (wh.W / totalH).toFixed(4) + ")";   // largeur bornée → hauteur ≤ MAXVH, ratio préservé
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
      // En fin de glisser : re-render (mode leader → l'étiquette + la ligne du port suivent sa nouvelle position).
      const up = () => { markerEl.classList.remove("dragging"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); if (portDisplay === "leader") render(); };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    };
    const render = (): void => {
      faces.forEach((f) => { tabBtns[f].className = "btn btn-sm " + (side === f ? "btn-primary" : "btn-ghost"); });
      const hasImg = !!fids[side];
      const mir: any = hasImg && this.images ? this.images.get(fids[side]) : null;
      const imgUrl: string | null = mir ? (mir.url || null) : null;
      // Oreilles : UNIQUEMENT la face AVANT en a (l'arrière jamais). L'image « avec oreilles » couvre corps + oreilles ;
      // sinon le corps seul. Sans image (avant), on matérialise quand même les oreilles (zone non plaçable).
      const faceHasEars = panelMode && side === "front";
      const withEars = faceHasEars && (mir ? mir.with_ears !== false : true);
      attachBtn.style.display = this.images ? "" : "none";
      attachBtn.textContent = hasImg ? I18n.t("face.changeImage") : I18n.t("face.attachImage");
      detachBtn.style.display = hasImg ? "" : "none";
      gridShowBtn.style.display = grid ? "" : "none";
      gridShowBtn.textContent = gridVisible ? I18n.t("face.gridHide") : I18n.t("face.gridShow");

      applyFrameSize(side);
      frame.querySelectorAll(".face-bg, .face-ear").forEach((n) => n.remove());   // image + bandes reconstruites à chaque rendu
      // Bandes de la FAÇADE dans le frame : VERTICALE (marges labels haut/bas si mode leader + face large) +
      // HORIZONTALE (corps entre les oreilles en mode baie). Le stage = ce rectangle central ; les marges du frame
      // servent aux étiquettes déportées.
      const vt = bandTop(side) * 100, vh = bandH(side) * 100;
      const bLeft = bodyLeftFrac(side);   // fraction gauche du BOÎTIER dans le panneau, pour CETTE face (miroir arrière)
      const hLeft = panelMode ? bLeft * 100 : 0, hW = panelMode ? BODY_FRAC * 100 : 100;
      stage.className = "face-stage" + (imgUrl ? "" : " empty");
      stage.style.cssText = "position:absolute;top:" + vt + "%;height:" + vh + "%;left:" + hLeft + "%;width:" + hW + "%;right:auto;bottom:auto;";
      stage.innerHTML = "";
      leaderLayer.innerHTML = "";   // couche des étiquettes déportées reconstruite à chaque rendu

      // IMAGE de fond — placée dans le FRAME pour pouvoir déborder sur les oreilles (mode « avec oreilles » :
      // panneau 19″ COMPLET, même boîtier rétréci) ; « face seule » : confinée à la largeur RÉELLE du boîtier.
      if (imgUrl) {
        const im = document.createElement("img"); im.className = "face-bg"; im.src = imgUrl; im.alt = "";
        const iLeft = (panelMode && !withEars) ? bLeft * 100 : 0, iW = (panelMode && !withEars) ? BODY_FRAC * 100 : 100;
        im.style.cssText = "top:" + vt + "%;height:" + vh + "%;left:" + iLeft + "%;width:" + iW + "%;right:auto;bottom:auto;";
        frame.appendChild(im);
      } else {
        const h = document.createElement("div"); h.className = "face-empty-hint"; h.textContent = hasImg ? I18n.t("face.emptyOrphan", { face: EquipFaces.label(side).toLowerCase() }) : I18n.t("face.emptyNoImage", { face: EquipFaces.label(side).toLowerCase() }); stage.appendChild(h);
      }
      // OREILLES de montage 19″ (AVANT uniquement) : bandes latérales NON cliquables (le placement reste sur le
      // corps) — des RAILS jusqu'aux bords du boîtier (asymétriques si boîtier rétréci/aligné).
      if (faceHasEars) {
        [[0, bLeft], [bLeft + BODY_FRAC, 1]].forEach(([x0, x1]) => { if (x1 - x0 <= 0.0005) return; const e = document.createElement("div"); e.className = "face-ear"; e.style.cssText = "left:" + (x0 * 100) + "%;width:" + ((x1 - x0) * 100) + "%;top:" + vt + "%;height:" + vh + "%;bottom:auto;"; frame.appendChild(e); });
      }

      // GRILLE (overlay) — affichée seulement si ACTIVE et NON masquée ; le SNAP suit `grid` quel que soit l'affichage.
      if (grid && grid.cols && grid.rows && gridVisible) {
        const NS = "http://www.w3.org/2000/svg";
        const ov = document.createElementNS(NS, "svg"); ov.setAttribute("class", "face-grid-ov"); ov.setAttribute("viewBox", "0 0 " + grid.cols + " " + grid.rows); ov.setAttribute("preserveAspectRatio", "none");
        const line = (x1: number, y1: number, x2: number, y2: number) => { const l = document.createElementNS(NS, "line"); l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1)); l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2)); ov.appendChild(l); };
        for (let i = 1; i < grid.cols; i++) line(i, 0, i, grid.rows);
        for (let j = 1; j < grid.rows; j++) line(0, j, grid.cols, j);
        stage.appendChild(ov);
      }
      // PORTS posés sur CETTE face — masqués tant qu'un port est ACTIVÉ (mode 2 clics) pour dégager la face.
      const roleCls = (p: any) => PortRoles.markerRoleClass(p.role);   // "" (data) · role-mgmt/power/poe
      const placedHere = activePortId ? [] : ports.filter((p) => place[p.id] && place[p.id].side === side);
      if (portDisplay === "leader") {
        // PASTILLES (dots) draggables dans le stage (référencées pour le surlignage au survol de l'étiquette).
        const dots = placedHere.map((p) => {
          const pos = place[p.id];
          const dot = document.createElement("div"); dot.className = "face-dot" + roleCls(p);
          dot.style.left = (pos.x * 100) + "%"; dot.style.top = (pos.y * 100) + "%";
          dot.addEventListener("pointerdown", (e) => { e.stopPropagation(); startDrag(e as PointerEvent, p.id, dot); });
          stage.appendChild(dot); return dot;
        });
        // ÉTIQUETTES DÉPORTÉES : nom + × (retrait), mesurées, disposées par RÉPULSION (LeaderLayout), reliées
        // par une ligne. Survol d'une étiquette → surligne l'étiquette, sa ligne et sa pastille.
        if (placedHere.length) {
          const anchorFrame = (pos: any) => ({ fx: (hLeft + pos.x * hW) / 100, fy: (vt + pos.y * vh) / 100 });   // port → fraction du FRAME
          const labels = placedHere.map((p) => {
            const el = document.createElement("div"); el.className = "face-leader-label" + roleCls(p);
            const nm = document.createElement("span"); nm.textContent = p.name || I18n.t("face.portParen"); el.appendChild(nm);
            const x = document.createElement("span"); x.className = "fm-x"; x.textContent = "×"; x.title = I18n.t("face.removeFromFace");
            x.addEventListener("pointerdown", (e) => e.stopPropagation());
            x.addEventListener("click", (e) => { e.stopPropagation(); markDirty(); delete place[p.id]; render(); });
            el.appendChild(x); leaderLayer.appendChild(el); return el;
          });
          const fr = frame.getBoundingClientRect();
          const anchors: LeaderAnchor[] = placedHere.map((p, i) => { const a = anchorFrame(place[p.id]); const lr = labels[i].getBoundingClientRect(); return { x: a.fx, y: a.fy, w: fr.width ? lr.width / fr.width : 0.08, h: fr.height ? lr.height / fr.height : 0.06 }; });
          const layout = LeaderLayout.layout(anchors, { aspect: (fr.width && fr.height) ? fr.width / fr.height : 1 });
          const NS = "http://www.w3.org/2000/svg";
          const svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "face-leader-lines"); svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
          const lines = placedHere.map((p, i) => {
            const a = anchorFrame(place[p.id]), L = layout[i];
            const ln = document.createElementNS(NS, "line"); ln.setAttribute("x1", String(a.fx * 100)); ln.setAttribute("y1", String(a.fy * 100)); ln.setAttribute("x2", String(L.x * 100)); ln.setAttribute("y2", String(L.y * 100)); svg.appendChild(ln);
            labels[i].style.left = (L.x * 100) + "%"; labels[i].style.top = (L.y * 100) + "%";
            return ln;
          });
          leaderLayer.insertBefore(svg, leaderLayer.firstChild);   // lignes SOUS les étiquettes
          placedHere.forEach((p, i) => {
            const hi = (on: boolean) => { labels[i].classList.toggle("hi", on); lines[i].classList.toggle("hi", on); dots[i].classList.toggle("hi", on); };
            labels[i].addEventListener("mouseenter", () => hi(true));
            labels[i].addEventListener("mouseleave", () => hi(false));
          });
        }
      } else {
        placedHere.forEach((p) => {
          const pos = place[p.id];
          const mk = document.createElement("div"); mk.className = "face-marker" + roleCls(p);
          mk.style.left = (pos.x * 100) + "%"; mk.style.top = (pos.y * 100) + "%";
          const lab = document.createElement("span"); lab.textContent = p.name || I18n.t("face.portParen"); mk.appendChild(lab);
          const x = document.createElement("span"); x.className = "fm-x"; x.textContent = "×"; x.title = I18n.t("face.removeFromFace");
          x.addEventListener("pointerdown", (e) => e.stopPropagation());
          x.addEventListener("click", (e) => { e.stopPropagation(); markDirty(); delete place[p.id]; render(); });
          mk.appendChild(x);
          // stopPropagation → le glisser de marqueur n'enclenche PAS le pan du fond (cf. viewport pointerdown).
          mk.addEventListener("pointerdown", (e) => { e.stopPropagation(); startDrag(e as PointerEvent, p.id, mk); });
          stage.appendChild(mk);
        });
      }
      palette.innerHTML = "";
      const unplaced = ports.filter((p) => !place[p.id]);
      const onOther = ports.filter((p) => place[p.id] && place[p.id].side !== side).length;
      const ph = document.createElement("div"); ph.className = "face-palette-hint";
      if (activePortId) {
        const ap = ports.find((p) => p.id === activePortId);
        ph.textContent = I18n.t("face.clickToPlace", { name: (ap && ap.name) ? ap.name : I18n.t("face.portBare") });
      } else {
        const verb = placeMode === "click" ? I18n.t("face.verbClick") : I18n.t("face.verbAuto", { face: EquipFaces.label(side).toLowerCase() });
        const base = unplaced.length ? I18n.t("face.portsToPlace", { count: unplaced.length, verb }) : (ports.length ? I18n.t("face.allPlaced") : I18n.t("face.noPorts"));
        const other = onOther ? (faces.length > 2 ? I18n.t("face.onOtherFaces", { count: onOther }) : I18n.t("face.onOtherFace", { count: onOther })) : "";
        ph.textContent = base + other;
      }
      palette.appendChild(ph);
      unplaced.forEach((p) => {
        const c = document.createElement("button"); c.type = "button"; c.className = "face-chip" + (p.id === activePortId ? " active" : ""); c.textContent = p.name || I18n.t("face.portParen");
        c.onclick = () => {
          if (placeMode === "click") { activePortId = (activePortId === p.id) ? null : p.id; render(); return; }   // active (les autres ports se masquent)
          markDirty(); const s = snapToGrid(0.5, 0.5); place[p.id] = { x: s.x, y: s.y, side }; render();            // pose au centre (mode auto)
        };
        palette.appendChild(c);
      });
      applyZoom();   // ré-applique zoom/pan au frame reconstruit
    }
    // MODE 2 CLICS : un port ACTIVÉ se pose au clic sur la face (à l'endroit cliqué ; snap grille si active).
    stage.addEventListener("click", (e) => {
      if (placeMode !== "click" || !activePortId) return;
      const rect = stage.getBoundingClientRect();
      const s = snapToGrid((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
      markDirty(); place[activePortId] = { x: s.x, y: s.y, side }; activePortId = null; render();
    });
    const syncModes = () => {
      placeBtn.className = "btn btn-sm " + (placeMode === "click" ? "btn-primary" : "btn-ghost");
      leaderBtn.className = "btn btn-sm " + (portDisplay === "leader" ? "btn-primary" : "btn-ghost");
    };
    placeBtn.onclick = () => { placeMode = placeMode === "click" ? "auto" : "click"; activePortId = null; syncModes(); render(); };
    leaderBtn.onclick = () => { portDisplay = portDisplay === "leader" ? "chip" : "leader"; syncModes(); render(); };   // change aussi la marge verticale (bande)
    gridSel.onchange = () => { const g = FACE_GRID_PRESETS.find((x) => x.id === gridSel.value); grid = (g && g.cols) ? { cols: g.cols, rows: g.rows } : null; render(); };
    gridShowBtn.onclick = () => { gridVisible = !gridVisible; render(); };
    addAllBtn.onclick = () => { markDirty(); layoutUniform(ports.filter((p) => !place[p.id] || place[p.id].side === side)); render(); };
    removeAllBtn.onclick = () => { markDirty(); ports.forEach((p) => { if (place[p.id] && place[p.id].side === side) delete place[p.id]; }); render(); };
    detachBtn.onclick = () => { markDirty(); fids[side] = null; render(); };
    attachBtn.onclick = async () => {
      const u = this.faceAnnex(side) ? 1 : Math.max(1, (eq.u_height | 0) || 1);
      const res = await this.imagePicker(store, host, u, side, fids[side], isFree);   // libre → front/rear sans contrainte de U
      if (res) { markDirty(); fids[side] = res.id; render(); }
    };
    // Échap ANNULE d'abord l'activation d'un port (mode 2 clics) — sinon laisse le Dialog fermer normalement.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && activePortId) { e.preventDefault(); e.stopPropagation(); activePortId = null; render(); } };
    document.addEventListener("keydown", onKey, true);
    syncModes(); render();

    const subtitle = (isFree
      ? I18n.t("face.subtitleFree", { w: eq.free_w_mm || "?", l: eq.free_l_mm || "?", h: eq.free_h_mm || "?" })
      : I18n.t("face.subtitleRack", { u: eq.u_height || 1 }));
    const applyResult = async () => {
      if (opts.onApply) { opts.onApply({ fids, place }); return; }
      const facePatch: any = {};
      faces.forEach((f) => { facePatch[EQUIP_FACE_IMG_FIELD[f]] = fids[f] || null; });
      const ops: any[] = [{ collection: "equipments", id: eq.id, patch: facePatch }];
      ports.forEach((p) => { const pos = place[p.id]; ops.push({ collection: "ports", id: p.id, patch: pos ? { face_x: pos.x, face_y: pos.y, face_side: pos.side } : { face_x: null, face_y: null } }); });
      await store.updateBatch(ops);
      host.setDirty?.(true); Notify.toast(I18n.t("face.saved"));
    };
    Dialog.custom({
      title: I18n.t("face.title", { name: Html.escape(eq.name || I18n.t("face.equipName")) }), message: subtitle, wide: true,
      confirmLabel: opts.onApply ? I18n.t("face.apply") : I18n.t("ui.action.save"), cancelLabel: I18n.t("ui.action.close"),
      build: (h2) => { h2.appendChild(root); return { validate: () => true as const, collect: () => true }; },
    }).then(async (res) => { document.removeEventListener("keydown", onKey, true); if (res) await applyResult(); });
  }

  /** Sélecteur d'image éligible → { id } ou null. `free` (équipement en dimensionnement libre) = AUCUN filtre :
      toute image de la bibliothèque est éligible sur toute face (ni catégorie « autre », ni contrainte de U). */
  static imagePicker(store: Store, host: FormHost, u: number, face: string, current: string | null, free = false): Promise<{ id: string | null } | null> {
    const images = this.images; if (!images) return Promise.resolve(null);
    const annex = this.faceAnnex(face), faceLbl = EquipFaces.label(face);
    const uTag = !annex && !free;   // étiquette/filtre par U : front/rear d'un équipement BAIE seulement
    return Dialog.custom({
      title: I18n.t(free ? "face.imgPickerFree" : annex ? "face.imgPickerAnnex" : uTag ? "face.imgPickerU" : "face.imgPickerFace", { face: faceLbl.toLowerCase(), u: u || 1 }), confirmLabel: I18n.t("face.choose"),
      build: (root: HTMLElement) => {
        let selected: string | null = current || null, query = "";
        // Toggle OREILLES — UNIQUEMENT pour la face AVANT (l'arrière n'a jamais d'oreilles) : (a) FILTRE les images
        // proposées ; (b) sert de DÉFAUT à l'image importée inline. Défaut avant = avec oreilles.
        const hasEarToggle = (face === "front") && !free;   // oreilles = concept BAIE (19″) ; pas en libre
        let earMode = true;
        const note = document.createElement("div"); note.className = "form-hint"; note.style.marginBottom = "8px";
        note.textContent = free ? I18n.t("face.noteFree")
          : annex ? I18n.t("face.noteAnnex")
          : I18n.t("face.noteU", { u: u || 1, face: faceLbl });
        const earRow = document.createElement("div"); earRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
        const earLab = document.createElement("span"); earLab.className = "form-hint"; earLab.style.margin = "0"; earLab.textContent = I18n.t("face.ears");
        const segWith = document.createElement("button"); segWith.type = "button"; segWith.textContent = I18n.t("face.withEars");
        const segWithout = document.createElement("button"); segWithout.type = "button"; segWithout.textContent = I18n.t("face.withoutEars");
        segWith.onclick = () => { earMode = true; renderGrid(); };
        segWithout.onclick = () => { earMode = false; renderGrid(); };
        earRow.append(earLab, segWith, segWithout);
        const search = document.createElement("input"); search.type = "text"; search.className = "search-input"; search.placeholder = I18n.t("face.searchImage"); search.style.cssText = "width:100%;max-width:none;margin-bottom:8px;";
        const grid = document.createElement("div"); grid.className = "fi-grid";
        if (hasEarToggle) root.append(note, earRow, search, grid); else root.append(note, search, grid);
        const renderGrid = () => {
          segWith.className = "btn btn-sm " + (earMode ? "btn-primary" : "btn-ghost");
          segWithout.className = "btn btn-sm " + (!earMode ? "btn-primary" : "btn-ghost");
          grid.innerHTML = "";
          const none = document.createElement("button"); none.type = "button"; none.className = "fi-tile fi-none" + (selected == null ? " sel" : ""); none.textContent = I18n.t("face.imgNone"); none.onclick = () => { selected = null; renderGrid(); }; grid.appendChild(none);
          const eligible = this.eligibleImages(u, face, free), cur: any = current ? images.get(current) : null;
          const list = eligible.slice(); if (cur && !eligible.some((fi: any) => fi.id === cur.id)) list.push(cur);
          const q = Text.normSearch(query);
          const searched = q ? list.filter((fi: any) => Text.normSearch((fi.name || "") + " " + (fi.description || "")).includes(q)) : list;
          // FILTRE par mode d'oreilles (AVANT uniquement) ; l'image SÉLECTIONNÉE reste toujours visible.
          const shown = hasEarToggle ? searched.filter((fi: any) => fi.id === selected || ((fi.with_ears !== false) === earMode)) : searched;
          shown.forEach((fi: any) => {
            const offFilter = free ? false : annex ? (fi.face !== "autre") : !(fi.face === face && fi.u_height === (u || 1));
            const t = document.createElement("button"); t.type = "button"; t.className = "fi-tile" + (selected === fi.id ? " sel" : "");
            const im = document.createElement("img"); im.src = fi.url; im.alt = "";
            const cap = document.createElement("span"); cap.className = "fi-cap";
            cap.textContent = (fi.name || I18n.t("face.imgFallback")) + (offFilter ? " · " + (fi.face === "autre" ? I18n.t("face.faceOther") : fi.u_height + "U/" + EquipFaces.label(fi.face)) : "") + " · " + store.faceImageUsageCount(fi.id) + "×";
            t.append(im, cap); t.onclick = () => { selected = fi.id; renderGrid(); }; grid.appendChild(t);
          });
          if (shown.length === 0) {
            const empty = document.createElement("div"); empty.className = "fi-grid-empty";
            const kind = annex ? I18n.t("face.kindAnnex") : (faceLbl + (hasEarToggle ? (earMode ? I18n.t("face.earSuffixWith") : I18n.t("face.earSuffixWithout")) : ""));
            empty.textContent = q ? I18n.t("face.noImageMatch", { query: query.trim() }) : I18n.t("face.noImageOfKind", { kind });
            grid.appendChild(empty);
          }
          const imp = document.createElement("button"); imp.type = "button"; imp.className = "fi-tile fi-import";
          const impKind = annex ? I18n.t("face.kindAnnex") : ((uTag ? I18n.t("face.uPrefix", { u: u || 1 }) : "") + faceLbl + (hasEarToggle ? (earMode ? I18n.t("face.earDotWith") : I18n.t("face.earDotWithout")) : ""));
          imp.innerHTML = "<span>" + I18n.t("face.importImage", { kind: impKind }) + "</span>";
          imp.onclick = () => {
            // MODALE COMPLÈTE de création d'image (nom, face, U, oreilles, import + redressement/assemblage,
            // description), préremplie depuis le contexte du sélecteur (face AV/AR · U · oreilles). Ouverte en
            // DIALOGUE (empilable) car ce sélecteur est lui-même un Dialog. Au enregistrement, la nouvelle image
            // est présélectionnée dans la grille. Remplace l'ancien import inline (explorateur + choix).
            const preset = { face: (annex || free) ? "autre" : face, u_height: annex ? 1 : (u || 1), with_ears: hasEarToggle && earMode };
            EquipmentForms.faceImage(images, store, host, null, (savedId?: string) => {
              if (savedId) { selected = savedId; query = ""; search.value = ""; renderGrid(); }
            }, preset, true);
          };
          grid.appendChild(imp);
        };
        search.addEventListener("input", () => { query = search.value; renderGrid(); });
        renderGrid(); setTimeout(() => search.focus(), 30);
        return { validate: () => true as const, collect: () => ({ id: selected }) };
      },
    });
  }
}
