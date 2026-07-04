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
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD, RACK_EAR_MM, RACK_MOUNT_WIDTH } from "../../domain/constants";
import type { FormHost } from "./shared";
import { FormBase } from "./FormBase";

export class FaceEditor extends FormBase {
  /** Éditeur de FAÇADE (sous-éditeur empilé) : pose les ports sur les faces de l'équipement
      (face_x/face_y/face_side) — onglets de face, glisser, snap de grille, « Tout poser / enlever »,
      palette des ports non posés. `opts.onApply({fids,place})` reporte sur le brouillon du formulaire
      parent ; sinon écrit dans le store. Les IMAGES de façade (bibliothèque IndexedDB) sont d'une phase
      ultérieure : on PRÉSERVE les références d'image existantes (fids) et on permet de les détacher. */
  static open(store: Store, host: FormHost, eqId: string, opts: any = {}): void {
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
    faces.forEach((f) => { const b = document.createElement("button"); b.type = "button"; b.textContent = EquipFaces.label(f); b.onclick = () => { side = f; setZoom(1); render(); }; tabBtns[f] = b; tabs.appendChild(b); });
    root.appendChild(tabs);

    const FACE_GRID_PRESETS = [
      { id: "free", label: "Libre (sans grille)", cols: 0, rows: 0 }, { id: "g6x1", label: "Grille 6 × 1", cols: 6, rows: 1 },
      { id: "g12x1", label: "Grille 12 × 1", cols: 12, rows: 1 }, { id: "g12x2", label: "Grille 12 × 2", cols: 12, rows: 2 },
      { id: "g24x1", label: "Grille 24 × 1", cols: 24, rows: 1 }, { id: "g24x2", label: "Grille 24 × 2", cols: 24, rows: 2 },
      { id: "g24x4", label: "Grille 24 × 4", cols: 24, rows: 4 }, { id: "g48x2", label: "Grille 48 × 2", cols: 48, rows: 2 },
    ];
    let grid: { cols: number; rows: number } | null = null;
    let gridVisible = true;   // la grille peut être MASQUÉE tout en restant ACTIVE (le snap continue).
    // Oreilles 19″ : le CORPS (zone de placement des ports) = fraction centrale BODY_FRAC du panneau ; une oreille
    // EAR_FRAC de chaque côté (non cliquable). Pertinent uniquement en montage baie (avant/arrière, équipement !libre).
    const EAR_FRAC = RACK_EAR_MM / RACK_MOUNT_WIDTH, BODY_FRAC = 1 - 2 * EAR_FRAC;
    const panelMode = !isFree;
    const tools = document.createElement("div"); tools.className = "face-toolbar";
    const attachBtn = document.createElement("button"); attachBtn.type = "button"; attachBtn.className = "btn btn-ghost btn-sm"; attachBtn.textContent = "Attacher une image…";
    const detachBtn = document.createElement("button"); detachBtn.type = "button"; detachBtn.className = "btn btn-ghost btn-sm"; detachBtn.textContent = "Détacher l'image";
    const addAllBtn = document.createElement("button"); addAllBtn.type = "button"; addAllBtn.className = "btn btn-ghost btn-sm"; addAllBtn.textContent = "Tout poser"; addAllBtn.title = "Disposer uniformément tous les ports sur cette face (suit la grille si active)";
    const removeAllBtn = document.createElement("button"); removeAllBtn.type = "button"; removeAllBtn.className = "btn btn-ghost btn-sm"; removeAllBtn.textContent = "Tout enlever";
    const gridLab = document.createElement("span"); gridLab.style.cssText = "font-size:11px;color:var(--fg-dim);margin-left:6px;"; gridLab.textContent = "Grille :";
    const gridSel = FormControls.select(FACE_GRID_PRESETS.map((g) => ({ value: g.id, label: g.label })), "free"); gridSel.style.cssText = "font-size:11px;padding:4px 6px;";
    const gridShowBtn = document.createElement("button"); gridShowBtn.type = "button"; gridShowBtn.className = "btn btn-ghost btn-sm"; gridShowBtn.title = "Afficher/masquer le quadrillage — la grille reste ACTIVE (le snap continue).";
    // Zoom (molette + boutons ; glisser le fond = déplacer) : utile sur les faces denses / gros équipements.
    const zoomOutBtn = document.createElement("button"); zoomOutBtn.type = "button"; zoomOutBtn.className = "btn btn-ghost btn-sm"; zoomOutBtn.textContent = "−"; zoomOutBtn.title = "Dézoomer";
    const zoomLab = document.createElement("span"); zoomLab.style.cssText = "font-size:11px;color:var(--fg-dim);min-width:36px;text-align:center;";
    const zoomInBtn = document.createElement("button"); zoomInBtn.type = "button"; zoomInBtn.className = "btn btn-ghost btn-sm"; zoomInBtn.textContent = "+"; zoomInBtn.title = "Zoomer";
    const zoomResetBtn = document.createElement("button"); zoomResetBtn.type = "button"; zoomResetBtn.className = "btn btn-ghost btn-sm"; zoomResetBtn.textContent = "Ajuster"; zoomResetBtn.title = "Réinitialiser le zoom (100 %)";
    const zoomGroup = document.createElement("span"); zoomGroup.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin-left:6px;"; zoomGroup.append(zoomOutBtn, zoomLab, zoomInBtn, zoomResetBtn);
    tools.append(attachBtn, detachBtn, addAllBtn, removeAllBtn, gridLab, gridSel, gridShowBtn, zoomGroup); root.appendChild(tools);

    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = "Cliquez un port pour le poser, puis glissez-le. Molette / +/− = zoom · glisser le fond = déplacer. « Grille » contraint le glisser (elle peut être masquée tout en restant active). « Attacher une image » : fond de façade (filtré par face ; contrainte de U en mode baie seulement).";
    root.appendChild(hint);
    // VIEWPORT (clipping) → FRAME (zoom/pan) → STAGE (corps : grille + marqueurs). L'image et les oreilles vivent
    // dans le FRAME (l'image « avec oreilles » déborde sur les bandes latérales) ; le STAGE est au-dessus (z-index).
    const viewport = document.createElement("div"); viewport.className = "face-viewport";
    const frame = document.createElement("div"); frame.className = "face-frame";
    const stage = document.createElement("div"); frame.appendChild(stage); viewport.appendChild(frame); root.appendChild(viewport);
    const palette = document.createElement("div"); palette.className = "face-palette"; root.appendChild(palette);

    // ---- zoom / pan : transform sur le frame, le viewport clippe. transform-origin: 0 0 (cf. CSS). ----
    let zoom = 1, panX = 0, panY = 0; const ZMIN = 1, ZMAX = 6;
    const applyZoom = () => {
      frame.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
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
      const ev = e as PointerEvent; if (zoom <= 1 || ev.button !== 0) return;
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
    // Dimensionne le FRAME en PRÉSERVANT le ratio de la face (libre = dims réelles ; baie = 19″ × hauteur U). On borne la
    // HAUTEUR à MAXVH et la LARGEUR à MAXVH×ratio : sinon `width:100% + max-height` casse le ratio (largeur pleine, hauteur
    // bornée → la face carrée/haute s'aplatissait, l'overflow du stage la rognait). Centré, jamais plus large que nécessaire.
    const applyFrameSize = (f: string) => {
      const el = frame, MAXVH = 60;
      const wh = isFree ? faceWH(f) : { W: 19, H: 1.75 * Math.max(1, (eq.u_height | 0) || 1) };
      el.style.aspectRatio = wh.W + " / " + wh.H;
      el.style.width = "100%"; el.style.height = "auto"; el.style.margin = "0 auto";
      el.style.maxHeight = MAXVH + "vh";
      el.style.maxWidth = "calc(" + MAXVH + "vh * " + (wh.W / wh.H).toFixed(4) + ")";   // largeur bornée → hauteur ≤ MAXVH, ratio préservé
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
      attachBtn.textContent = hasImg ? "Changer l'image…" : "Attacher une image…";
      detachBtn.style.display = hasImg ? "" : "none";
      gridShowBtn.style.display = grid ? "" : "none";
      gridShowBtn.textContent = gridVisible ? "Masquer la grille" : "Afficher la grille";

      applyFrameSize(side);
      frame.querySelectorAll(".face-bg, .face-ear").forEach((n) => n.remove());   // image + bandes reconstruites à chaque rendu
      // STAGE = corps (placement des ports). Mode baie : fraction CENTRALE entre les oreilles ; sinon plein cadre.
      stage.className = "face-stage" + (imgUrl ? "" : " empty");
      stage.style.cssText = panelMode ? ("position:absolute;top:0;bottom:0;left:" + (EAR_FRAC * 100) + "%;right:auto;width:" + (BODY_FRAC * 100) + "%;") : "position:absolute;inset:0;";
      stage.innerHTML = "";

      // IMAGE de fond — placée dans le FRAME pour pouvoir déborder sur les oreilles (mode « avec oreilles »).
      if (imgUrl) {
        const im = document.createElement("img"); im.className = "face-bg"; im.src = imgUrl; im.alt = "";
        im.style.cssText = (panelMode && !withEars) ? ("left:" + (EAR_FRAC * 100) + "%;right:auto;width:" + (BODY_FRAC * 100) + "%;") : "";   // face seule → confinée au corps
        frame.appendChild(im);
      } else {
        const h = document.createElement("div"); h.className = "face-empty-hint"; h.textContent = "Face " + EquipFaces.label(side).toLowerCase() + (hasImg ? " — image introuvable (référence orpheline)" : " — aucune image (positionnement possible)"); stage.appendChild(h);
      }
      // OREILLES de montage 19″ (AVANT uniquement) : bandes latérales NON cliquables (le placement reste sur le corps).
      if (faceHasEars) {
        [0, 1 - EAR_FRAC].forEach((x) => { const e = document.createElement("div"); e.className = "face-ear"; e.style.left = (x * 100) + "%"; e.style.width = (EAR_FRAC * 100) + "%"; frame.appendChild(e); });
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
      ports.forEach((p) => {
        const pos = place[p.id]; if (!pos || pos.side !== side) return;
        const mk = document.createElement("div"); mk.className = "face-marker" + (p.role === "mgmt" ? " role-mgmt" : (p.role === "power" ? " role-power" : ""));
        mk.style.left = (pos.x * 100) + "%"; mk.style.top = (pos.y * 100) + "%";
        const lab = document.createElement("span"); lab.textContent = p.name || "(port)"; mk.appendChild(lab);
        const x = document.createElement("span"); x.className = "fm-x"; x.textContent = "×"; x.title = "Retirer de la façade";
        x.addEventListener("pointerdown", (e) => e.stopPropagation());
        x.addEventListener("click", (e) => { e.stopPropagation(); markDirty(); delete place[p.id]; render(); });
        mk.appendChild(x);
        // stopPropagation → le glisser de marqueur n'enclenche PAS le pan du fond (cf. viewport pointerdown).
        mk.addEventListener("pointerdown", (e) => { e.stopPropagation(); startDrag(e as PointerEvent, p.id, mk); });
        stage.appendChild(mk);
      });
      palette.innerHTML = "";
      const unplaced = ports.filter((p) => !place[p.id]);
      const onOther = ports.filter((p) => place[p.id] && place[p.id].side !== side).length;
      const ph = document.createElement("div"); ph.className = "face-palette-hint";
      ph.textContent = (unplaced.length ? "Ports à poser (" + unplaced.length + ") — cliquez pour les ajouter à la face " + EquipFaces.label(side).toLowerCase() + " :" : (ports.length ? "Tous les ports sont posés." : "Cet équipement n'a aucun port.")) + (onOther ? "  (" + onOther + " sur " + (faces.length > 2 ? "d'autres faces" : "l'autre face") + ")" : "");
      palette.appendChild(ph);
      unplaced.forEach((p) => { const c = document.createElement("button"); c.type = "button"; c.className = "face-chip"; c.textContent = p.name || "(port)"; c.onclick = () => { markDirty(); const s = snapToGrid(0.5, 0.5); place[p.id] = { x: s.x, y: s.y, side }; render(); }; palette.appendChild(c); });
      applyZoom();   // ré-applique zoom/pan au frame reconstruit
    }
    gridSel.onchange = () => { const g = FACE_GRID_PRESETS.find((x) => x.id === gridSel.value); grid = (g && g.cols) ? { cols: g.cols, rows: g.rows } : null; render(); };
    gridShowBtn.onclick = () => { gridVisible = !gridVisible; render(); };
    addAllBtn.onclick = () => { markDirty(); layoutUniform(ports.filter((p) => !place[p.id] || place[p.id].side === side)); render(); };
    removeAllBtn.onclick = () => { markDirty(); ports.forEach((p) => { if (place[p.id] && place[p.id].side === side) delete place[p.id]; }); render(); };
    detachBtn.onclick = () => { markDirty(); fids[side] = null; render(); };
    attachBtn.onclick = async () => {
      const u = this.faceAnnex(side) ? 1 : Math.max(1, (eq.u_height | 0) || 1);
      const res = await this.imagePicker(store, u, side, fids[side], isFree);   // libre → front/rear sans contrainte de U
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

  /** Sélecteur d'image éligible → { id } ou null. `free` (équipement en dimensionnement libre) = AUCUN filtre :
      toute image de la bibliothèque est éligible sur toute face (ni catégorie « autre », ni contrainte de U). */
  static imagePicker(store: Store, u: number, face: string, current: string | null, free = false): Promise<{ id: string | null } | null> {
    const images = this.images; if (!images) return Promise.resolve(null);
    const annex = this.faceAnnex(face), faceLbl = EquipFaces.label(face);
    const uTag = !annex && !free;   // étiquette/filtre par U : front/rear d'un équipement BAIE seulement
    return Dialog.custom({
      title: "Image de façade — " + (free ? "face " + faceLbl.toLowerCase() + " (équipement libre)" : annex ? "face " + faceLbl.toLowerCase() + " (catégorie « autre »)" : (uTag ? (u || 1) + "U · " : "") + "face " + faceLbl.toLowerCase()), confirmLabel: "Choisir",
      build: (root: HTMLElement) => {
        let selected: string | null = current || null, query = "";
        // Toggle OREILLES — UNIQUEMENT pour la face AVANT (l'arrière n'a jamais d'oreilles) : (a) FILTRE les images
        // proposées ; (b) sert de DÉFAUT à l'image importée inline. Défaut avant = avec oreilles.
        const hasEarToggle = (face === "front") && !free;   // oreilles = concept BAIE (19″) ; pas en libre
        let earMode = true;
        const note = document.createElement("div"); note.className = "form-hint"; note.style.marginBottom = "8px";
        note.textContent = free ? "Équipement libre : toutes les images de la bibliothèque sont éligibles (aucun filtre de face ni de U)."
          : annex ? "Faces annexes (équipement libre) : seules les images marquées « autre » sont éligibles (sans contrainte de U)."
          : "Seules les images " + (u || 1) + "U marquées « " + faceLbl + " » sont éligibles ici.";
        const earRow = document.createElement("div"); earRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
        const earLab = document.createElement("span"); earLab.className = "form-hint"; earLab.style.margin = "0"; earLab.textContent = "Oreilles :";
        const segWith = document.createElement("button"); segWith.type = "button"; segWith.textContent = "Avec oreilles";
        const segWithout = document.createElement("button"); segWithout.type = "button"; segWithout.textContent = "Sans oreilles";
        segWith.onclick = () => { earMode = true; renderGrid(); };
        segWithout.onclick = () => { earMode = false; renderGrid(); };
        earRow.append(earLab, segWith, segWithout);
        const search = document.createElement("input"); search.type = "text"; search.className = "search-input"; search.placeholder = "Rechercher une image (nom, description)…"; search.style.cssText = "width:100%;max-width:none;margin-bottom:8px;";
        const grid = document.createElement("div"); grid.className = "fi-grid";
        if (hasEarToggle) root.append(note, earRow, search, grid); else root.append(note, search, grid);
        const renderGrid = () => {
          segWith.className = "btn btn-sm " + (earMode ? "btn-primary" : "btn-ghost");
          segWithout.className = "btn btn-sm " + (!earMode ? "btn-primary" : "btn-ghost");
          grid.innerHTML = "";
          const none = document.createElement("button"); none.type = "button"; none.className = "fi-tile fi-none" + (selected == null ? " sel" : ""); none.textContent = "Aucune"; none.onclick = () => { selected = null; renderGrid(); }; grid.appendChild(none);
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
            cap.textContent = (fi.name || "(image)") + (offFilter ? " · " + (fi.face === "autre" ? "autre" : fi.u_height + "U/" + EquipFaces.label(fi.face)) : "") + " · " + store.faceImageUsageCount(fi.id) + "×";
            t.append(im, cap); t.onclick = () => { selected = fi.id; renderGrid(); }; grid.appendChild(t);
          });
          if (shown.length === 0) { const empty = document.createElement("div"); empty.className = "fi-grid-empty"; empty.textContent = q ? ("Aucune image ne correspond à « " + query.trim() + " ».") : ("Aucune image " + (annex ? "« autre »" : (faceLbl + (hasEarToggle ? (earMode ? " avec oreilles" : " sans oreilles") : ""))) + " — importez-en une ci-dessous."); grid.appendChild(empty); }
          const imp = document.createElement("button"); imp.type = "button"; imp.className = "fi-tile fi-import"; imp.innerHTML = "<span>+ Importer<br>image " + (annex ? "« autre »" : ((uTag ? (u || 1) + "U · " : "") + faceLbl + (hasEarToggle ? (earMode ? " · avec oreilles" : " · sans oreilles") : ""))) + "</span>";
          imp.onclick = async () => {
            const f = this.validImageFile(await this.promptImageFile()); if (!f) return;
            const nm = f.name ? f.name.replace(/\.[^.]+$/, "") : ("Image " + (annex ? "autre" : (uTag ? (u || 1) + "U" : faceLbl)));
            const fi = await images.add({ name: nm, u_height: annex ? 1 : (u || 1), face: annex ? "autre" : face, with_ears: hasEarToggle && earMode, blob: f, type: f.type });
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
}
