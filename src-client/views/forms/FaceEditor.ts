/* =============================================================================
   ÉDITEUR DE FAÇADE — sous-éditeur EXTRAIT d'EquipmentForms (P4 : la méthode de
   ~210 lignes y était un mini-monolithe) : pose des ports sur les faces d'un
   équipement (face_x/face_y/face_side) avec onglets de face, zoom/pan, GUIDES
   d'alignement dynamiques (aimantation sur les autres ports, cf. FaceAlign),
   oreilles 19″, « Tout poser / enlever », palette des ports non posés,
   et SÉLECTEUR d'image de façade (bibliothèque, filtres face/U/oreilles, import).

   Étend FormBase pour réutiliser ses statiques protégées (images, faceAnnex,
   eligibleImages, promptImageFile…) SANS rejoindre la chaîne d'héritage Forms.
   ============================================================================= */
import type { Store } from "../../store";
import { FormSave } from "./FormSave";   // écriture + garde-fou « ne jamais annoncer un succès refusé »
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Text } from "../../core/Text";
import { EquipFaces } from "../../registries/EquipFaces";
import { PortRoles } from "../../registries/PortRoles";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { LeaderLayout, LeaderAnchor } from "../../geometry/LeaderLayout";
import { FaceAlign } from "../../geometry/FaceAlign";
import type { FaceAlignRef, FaceAlignResult } from "../../geometry/FaceAlign";
import { EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD } from "../../domain/constants";
import { FacePanelBands } from "../../geometry/FacePanelBands";   // bandes boîtier/oreilles du panneau 19″ (partagé avec l'aperçu de la fiche)
import type { FormHost } from "./shared";
import { FormBase } from "./FormBase";
import { EquipmentForms } from "./EquipmentForms";   // modale complète de création d'image (import « + Importer »)
import { I18n } from "../../i18n/I18n";

export class FaceEditor extends FormBase {
  /** Mode de pose retenu pour la SESSION (cf. `placeMode` dans `open`) — « 2 clics » au départ. */
  private static sessionPlaceMode: "auto" | "click" = "click";

  /** Éditeur de FAÇADE (sous-éditeur empilé) : pose les ports sur les faces de l'équipement
      (face_x/face_y/face_side) — onglets de face, glisser avec GUIDES d'alignement dynamiques,
      « Tout poser / enlever », palette des ports non posés. `opts.onApply({fids,place})` reporte sur le brouillon du formulaire
      parent ; sinon écrit dans le store. `opts.onSaved()` (branche SANS onApply UNIQUEMENT) est appelée APRÈS
      l'écriture au store : permet à un appelant EMPILÉ (ex. la fiche détail dont les aperçus lisent l'objet
      capturé à l'ouverture) de se reconstruire avec l'état frais — sinon rien ne re-rend la vue sous le dialogue.
      Les IMAGES de façade (bibliothèque IndexedDB) sont d'une phase
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

    // Distance d'écran (px) d'accroche des guides d'alignement — convertie en tolérance NORMALISÉE par axe
    // à chaque déplacement (insensible au zoom et au ratio de la face, cf. FaceAlign / alignTol).
    const SNAP_PX = 8;
    // Oreilles 19″ : le CORPS (zone de placement des ports) = fraction du panneau occupée par le BOÎTIER — pleine
    // largeur (oreilles standard de chaque côté) ou RÉTRÉCIE (u_width_mm + u_align : les oreilles s'étendent des
    // rails jusqu'au boîtier, asymétriques). Le découpage vit dans `geometry/FacePanelBands` (pur, testé) : il est
    // PARTAGÉ avec l'aperçu de la fiche détail (`FormBase.facePreview`), qui dessinait auparavant tout équipement
    // en pleine largeur. Fractions PAR FACE — l'arrière est un MIROIR horizontal, porté par le module.
    const BODY_FRAC = FacePanelBands.body(eq, "front").width;   // largeur : identique sur les deux faces
    const bodyLeftFrac = (f: string): number => FacePanelBands.body(eq, f).left;
    const panelMode = !isFree;
    // Affichage des ports : "chip" (label SUR le port, défaut) | "leader" (pastille + label déporté relié).
    let portDisplay: "chip" | "leader" = "chip";
    // Pose des ports : "auto" (clic port = pose au centre) | "click" (clic port = active, clic sur la face = pose).
    // MODE DE POSE — « 2 clics » PAR DÉFAUT (retour terrain T4, 2026-09-01). Le mode `click` (activer une
    // pastille de la palette, puis cliquer la face) pose AU POINT VISÉ, avec aimantation `FaceAlign`, aperçu
    // fantôme et guides ; `auto` pose au centre de la face, sans aimantation. Le second n'était le défaut que
    // parce qu'il est arrivé le premier — il oblige à re-glisser chaque port après l'avoir posé.
    // MÉMORISÉ EN SESSION, pas en Prefs (patron `LabelPrintDialog`) : le défaut est une opinion, le choix de
    // l'utilisateur reste le sien tant que l'onglet vit. Une Prefs persistée reste ouverte si le besoin vient
    // — elle demanderait de faire descendre les prefs jusqu'ici, ce que rien d'autre ne réclame aujourd'hui.
    let placeMode: "auto" | "click" = FaceEditor.sessionPlaceMode;
    let activePortId: string | null = null;   // port ACTIVÉ (mode 2 clics) : les autres ports posés deviennent des pastilles de référence.
    const tools = document.createElement("div"); tools.className = "face-toolbar";
    const attachBtn = document.createElement("button"); attachBtn.type = "button"; attachBtn.className = "btn btn-ghost btn-sm"; attachBtn.textContent = I18n.t("face.attachImage");
    const detachBtn = document.createElement("button"); detachBtn.type = "button"; detachBtn.className = "btn btn-ghost btn-sm"; detachBtn.textContent = I18n.t("face.detachImage");
    const addAllBtn = document.createElement("button"); addAllBtn.type = "button"; addAllBtn.className = "btn btn-ghost btn-sm"; addAllBtn.textContent = I18n.t("face.placeAll"); addAllBtn.title = I18n.t("face.placeAllTitle");
    const removeAllBtn = document.createElement("button"); removeAllBtn.type = "button"; removeAllBtn.className = "btn btn-ghost btn-sm"; removeAllBtn.textContent = I18n.t("face.removeAll");
    const placeBtn = document.createElement("button"); placeBtn.type = "button"; placeBtn.className = "btn btn-ghost btn-sm"; placeBtn.textContent = I18n.t("face.place2"); placeBtn.title = I18n.t("face.place2Title");
    const leaderBtn = document.createElement("button"); leaderBtn.type = "button"; leaderBtn.className = "btn btn-ghost btn-sm"; leaderBtn.textContent = I18n.t("face.leaders"); leaderBtn.title = I18n.t("face.leadersTitle");
    // Zoom (molette + boutons ; glisser le fond = déplacer) : utile sur les faces denses / gros équipements.
    const zoomOutBtn = document.createElement("button"); zoomOutBtn.type = "button"; zoomOutBtn.className = "btn btn-ghost btn-sm"; zoomOutBtn.textContent = "−"; zoomOutBtn.title = I18n.t("ui.zoom.out");
    const zoomLab = document.createElement("span"); zoomLab.style.cssText = "font-size:11px;color:var(--fg-dim);min-width:36px;text-align:center;";
    const zoomInBtn = document.createElement("button"); zoomInBtn.type = "button"; zoomInBtn.className = "btn btn-ghost btn-sm"; zoomInBtn.textContent = "+"; zoomInBtn.title = I18n.t("ui.zoom.in");
    const zoomResetBtn = document.createElement("button"); zoomResetBtn.type = "button"; zoomResetBtn.className = "btn btn-ghost btn-sm"; zoomResetBtn.textContent = I18n.t("ui.zoom.fitLabel"); zoomResetBtn.title = I18n.t("face.zoomResetTitle");
    const zoomGroup = document.createElement("span"); zoomGroup.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin-left:6px;"; zoomGroup.append(zoomOutBtn, zoomLab, zoomInBtn, zoomResetBtn);
    tools.append(attachBtn, detachBtn, placeBtn, leaderBtn, addAllBtn, removeAllBtn, zoomGroup); root.appendChild(tools);

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
    let guidesOv: SVGSVGElement | null = null;   // overlay SVG des guides d'alignement (recréé à chaque render)
    let ghostDot: HTMLDivElement | null = null;  // pastille fantôme d'aperçu de pose (mode 2 clics)
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
    const NS_SVG = "http://www.w3.org/2000/svg";
    // Références d'aimantation = ports posés sur la face COURANTE, hors `excludeId` (ex. le port en cours de glisser).
    const refsOf = (excludeId: string | null): FaceAlignRef[] =>
      ports.filter((p) => p.id !== excludeId && place[p.id] && place[p.id].side === side)
        .map((p) => ({ id: p.id, x: place[p.id].x, y: place[p.id].y }));
    // Aimante un point normalisé sur les autres ports. Les tolérances sont converties des PIXELS d'écran (SNAP_PX)
    // via le rect COURANT du stage → distance d'accroche CONSTANTE à l'écran, insensible au zoom et au ratio de la
    // face (cf. FaceAlign). `alt` (touche Alt enfoncée) = placement LIBRE : ni aimantation ni guide (position brute).
    const alignAt = (rx: number, ry: number, excludeId: string | null, alt: boolean): FaceAlignResult => {
      if (alt) return { x: clamp01(rx), y: clamp01(ry), guideY: null, guideX: null, gapX: null, gapY: null };
      const rect = stage.getBoundingClientRect();
      const tolX = rect.width ? SNAP_PX / rect.width : 0, tolY = rect.height ? SNAP_PX / rect.height : 0;
      return FaceAlign.resolve({ x: rx, y: ry }, refsOf(excludeId), tolX, tolY);
    };
    const clearGuides = () => { if (guidesOv) guidesOv.innerHTML = ""; };
    const clearGhost = () => { if (ghostDot) { ghostDot.remove(); ghostDot = null; } clearGuides(); };
    // Matérialise les accroches d'un résultat FaceAlign dans l'overlay du stage (viewBox 0..100, coords = fractions).
    // Alignement (guideX/guideY) = trait fin du port de référence jusqu'au port ; espacement (gapX/gapY) = segments
    // d'écart ÉGAL (variante « gap ») avec petites terminaisons perpendiculaires (repère « ⟷ » discret).
    const drawGuides = (res: FaceAlignResult): void => {
      if (!guidesOv) return;
      guidesOv.innerHTML = "";
      const seg = (x1: number, y1: number, x2: number, y2: number, cls: string) => {
        const l = document.createElementNS(NS_SVG, "line");
        l.setAttribute("x1", String(x1 * 100)); l.setAttribute("y1", String(y1 * 100));
        l.setAttribute("x2", String(x2 * 100)); l.setAttribute("y2", String(y2 * 100));
        l.setAttribute("class", "face-guide" + cls); guidesOv!.appendChild(l);
      };
      const TICK = 0.02;   // demi-longueur des terminaisons perpendiculaires (fraction du stage)
      const gapSeg = (a: { x: number; y: number }, b: { x: number; y: number }, horizontal: boolean) => {
        seg(a.x, a.y, b.x, b.y, " gap");
        [a, b].forEach((p) => horizontal ? seg(p.x, p.y - TICK, p.x, p.y + TICK, " gap") : seg(p.x - TICK, p.y, p.x + TICK, p.y, " gap"));
      };
      if (res.guideY) seg(res.guideY.ref.x, res.guideY.y, res.x, res.guideY.y, "");   // alignement horizontal (même y)
      if (res.guideX) seg(res.guideX.x, res.guideX.ref.y, res.guideX.x, res.y, "");   // alignement vertical (même x)
      if (res.gapX) res.gapX.pairs.forEach((s) => gapSeg(s.from, s.to, true));         // espacement en X → segments horizontaux
      if (res.gapY) res.gapY.pairs.forEach((s) => gapSeg(s.from, s.to, false));        // espacement en Y → segments verticaux
    };
    const faceWH = (f: string) => FreeEquipGeometry.faceWH(eq, f);   // dimensions par face (mutualisé, cf. FreeEquipGeometry)
    const faceWHof = (f: string) => isFree ? faceWH(f) : { W: 19, H: 1.75 * Math.max(1, (eq.u_height | 0) || 1) };   // baie = 19″ × hauteur U
    // Ratio d'une face 19″ de 1U (19 / 1,75) — ANCRAGE du « 3× la hauteur » de l'espace de travail : à ce ratio
    // (la face standard la plus plate), la marge d'espace de travail atteint son maximum. Aligné sur les littéraux
    // 19/1.75 de faceWHof ci-dessus (une face baie 1U vaut exactement { W: 19, H: 1.75 }).
    const FACE_1U_RATIO = 19 / 1.75;   // ≈ 10,86
    // MARGE VERTICALE du frame = MAX de DEUX besoins indépendants, tous deux propres aux faces PLUS LARGES que
    // hautes (rubans plats). La façade occupe toujours la bande CENTRALE ; les marges haut/bas servent selon le cas :
    //  1) ÉTIQUETTES DÉPORTÉES (mode leader, W/H ≥ 2) : +100 % en haut ET en bas → frame = 3× la hauteur de face,
    //     les étiquettes déportées y logent.
    //  2) ESPACE DE TRAVAIL : agrandissement NON LINÉAIRE fonction du ratio r = W/H, pour zoomer/paner à l'aise sur
    //     les rubans plats. Objectif : FORT pour les faces très larges, QUASI NUL près du carré. Ancrages : r ≤ 1
    //     (carré ou plus haut que large) → marge 0 (frame = 1× face, comportement inchangé) ; r = 1U 19″ (≈ 10,86)
    //     → marge 1 (frame = 3× face, « la norme »). Interpolation CONVEXE (carré du taux normalisé) : plate près du
    //     carré (croît lentement), raide vers les grands ratios. PLAFONNÉE à 1 au-delà du 1U — 3× reste la cible même
    //     pour un équipement libre encore plus large (le cap CSS 70vh borne de toute façon la hauteur réelle). On
    //     étend le FRAME (plutôt que centrer un frame plus petit dans un viewport plus grand) pour garder son origine
    //     au coin haut-gauche du viewport → maths de zoom/pan (origine 0 0, coords sur le rect du viewport) et de
    //     placement (coords sur le rect du stage) inchangées.
    // En mode leader large, le besoin 1 (3× face) DOMINE toujours l'espace de travail (≤ 3× face) → pas de double
    // ajout. Sinon (face carrée ou plus haute que large) : aucune marge (bande = tout le frame), inchangé.
    const vMargin = (f: string) => {
      const wh = faceWHof(f);
      const ratio = wh.W / wh.H;
      const leaderMargin = (portDisplay === "leader" && ratio >= 2) ? 1 : 0;   // marges pour les étiquettes déportées
      // taux normalisé du ratio entre le carré (0) et le 1U (1), écrêté ; élevé au carré → courbe convexe.
      const t = ratio > 1 ? Math.min(1, (ratio - 1) / (FACE_1U_RATIO - 1)) : 0;
      const workspaceMargin = t * t;                                           // 0 au carré → 1 (3× face) au 1U et au-delà
      return Math.max(leaderMargin, workspaceMargin);
    };
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
      // Disposition uniforme : grille ÉPHÉMÈRE déduite du ratio de la face (approx. carrée pondérée par l'aspect).
      const wh = faceWH(side); const aspect = isFree ? (wh.W / wh.H) : (19 / (1.75 * (eq.u_height || 1)));
      const cols = Math.max(1, Math.round(Math.sqrt(n * aspect))); const rows = Math.ceil(n / cols);
      list.forEach((p, i) => { const c = i % cols, r = Math.floor(i / cols); place[p.id] = { x: clamp01((c + 0.5) / cols), y: clamp01((r + 0.5) / rows), side }; });
    };
    // CURSEUR MASQUÉ pendant un glisser : la pastille de port fait quelques pixels et le curseur la recouvrait,
    // on ne voyait donc plus OÙ l'on pose. La classe vit sur <body> (et non sur le viewport) parce que le glisser
    // est suivi au niveau DOCUMENT : le pointeur peut sortir du cadre sans que le glisser s'arrête (cf. CSS).
    const NO_CURSOR_CLASS = "face-drag-nocursor";
    const startDrag = (ev: PointerEvent, id: string, markerEl: HTMLElement) => {
      ev.preventDefault(); markerEl.classList.add("dragging");
      document.body.classList.add(NO_CURSOR_CLASS);
      frame.classList.add("dragging-ports");   // masque les labels : tous les ports posés se réduisent à des pastilles (cf. CSS)
      const move = (e: PointerEvent) => {
        markDirty();
        const rect = stage.getBoundingClientRect();
        const res = alignAt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height, id, e.altKey);   // Alt = libre
        place[id].x = res.x; place[id].y = res.y;
        markerEl.style.left = (res.x * 100) + "%"; markerEl.style.top = (res.y * 100) + "%";
        drawGuides(res);   // guides reconstruits à chaque déplacement (vidés si Alt / aucune accroche)
      };
      // Fin du glisser : restaure les labels (retrait de la classe), efface les guides ; mode leader → re-render
      // (l'étiquette + la ligne du port suivent sa nouvelle position — le re-render existant s'en charge).
      const up = () => {
        // La classe pastille reste si un port est ACTIVÉ (pose 2 clics : les références restent des pastilles).
        markerEl.classList.remove("dragging"); frame.classList.toggle("dragging-ports", !!activePortId); clearGuides();
        document.body.classList.remove(NO_CURSOR_CLASS);   // le curseur revient au relâchement
        document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
        if (portDisplay === "leader") render();
      };
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
        FacePanelBands.ears(eq, side).forEach((band) => { const e = document.createElement("div"); e.className = "face-ear"; e.style.cssText = "left:" + (band.left * 100) + "%;width:" + (band.width * 100) + "%;top:" + vt + "%;height:" + vh + "%;bottom:auto;"; frame.appendChild(e); });
      }

      // GUIDES d'alignement (overlay du stage) : vide au repos, rempli pendant un glisser / un aperçu de pose
      // (cf. drawGuides). viewBox 0..100 + preserveAspectRatio:none → coordonnées en % du stage (comme les marqueurs).
      ghostDot = null;   // l'ancienne pastille fantôme vient d'être détachée par le vidage du stage
      guidesOv = document.createElementNS(NS_SVG, "svg") as SVGSVGElement;
      guidesOv.setAttribute("class", "face-guides"); guidesOv.setAttribute("viewBox", "0 0 100 100"); guidesOv.setAttribute("preserveAspectRatio", "none");
      stage.appendChild(guidesOv);
      // PORTS posés sur CETTE face. En pose 2 clics (port ACTIVÉ), ils RESTENT affichés mais réduits à des PASTILLES
      // (classe `dragging-ports` sur le frame, même rendu que pendant un glisser) pour servir de RÉFÉRENCES visuelles.
      frame.classList.toggle("dragging-ports", !!activePortId);
      const roleCls = (p: any) => PortRoles.markerRoleClass(p.role);   // "" (data) · role-mgmt/power/poe
      const placedHere = ports.filter((p) => place[p.id] && place[p.id].side === side);
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
          if (placeMode === "click") { activePortId = (activePortId === p.id) ? null : p.id; render(); return; }   // active (les autres ports deviennent des pastilles de référence)
          markDirty(); place[p.id] = { x: 0.5, y: 0.5, side }; render();            // pose au centre de la face (mode auto, sans aimantation)
        };
        palette.appendChild(c);
      });
      applyZoom();   // ré-applique zoom/pan au frame reconstruit
    }
    // MODE 2 CLICS : un port ACTIVÉ se pose au clic sur la face, à la position AIMANTÉE (FaceAlign au point cliqué ;
    // Alt = position libre). Un APERÇU (pastille fantôme + guides) suit le curseur pendant le survol du stage.
    stage.addEventListener("click", (e) => {
      if (placeMode !== "click" || !activePortId) return;
      const rect = stage.getBoundingClientRect();
      const res = alignAt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height, activePortId, (e as MouseEvent).altKey);
      markDirty(); place[activePortId] = { x: res.x, y: res.y, side }; activePortId = null; clearGhost(); render();
    });
    stage.addEventListener("pointermove", (e) => {
      if (placeMode !== "click" || !activePortId) return;
      const rect = stage.getBoundingClientRect();
      const res = alignAt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height, activePortId, e.altKey);
      if (!ghostDot) { ghostDot = document.createElement("div"); ghostDot.className = "face-dot ghost"; stage.appendChild(ghostDot); }
      ghostDot.style.left = (res.x * 100) + "%"; ghostDot.style.top = (res.y * 100) + "%";
      drawGuides(res);
    });
    stage.addEventListener("pointerleave", clearGhost);
    const syncModes = () => {
      placeBtn.className = "btn btn-sm " + (placeMode === "click" ? "btn-primary" : "btn-ghost");
      leaderBtn.className = "btn btn-sm " + (portDisplay === "leader" ? "btn-primary" : "btn-ghost");
    };
    placeBtn.onclick = () => { placeMode = placeMode === "click" ? "auto" : "click"; FaceEditor.sessionPlaceMode = placeMode; activePortId = null; syncModes(); render(); };
    leaderBtn.onclick = () => { portDisplay = portDisplay === "leader" ? "chip" : "leader"; syncModes(); render(); };   // change aussi la marge verticale (bande)
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
      if (!await FormSave.batch(store, ops)) return; // refusé par le Store (toast rouge) : ne rien annoncer, garder la saisie
      host.setDirty?.(true); Notify.toast(I18n.t("face.saved"));
      opts.onSaved?.();   // appelant empilé (fiche détail) → reconstruit sa vue avec l'état frais du store
    };
    Dialog.custom({
      title: I18n.t("face.title", { name: Html.escape(eq.name || I18n.t("face.equipName")) }), message: subtitle, wide: true,
      confirmLabel: opts.onApply ? I18n.t("face.apply") : I18n.t("ui.action.save"), cancelLabel: I18n.t("ui.action.close"),
      build: (h2) => { h2.appendChild(root); return { validate: () => true as const, collect: () => true }; },
    }).then(async (res) => {
      document.removeEventListener("keydown", onKey, true);
      document.body.classList.remove(NO_CURSOR_CLASS);   // filet : une fermeture EN COURS de glisser laisserait le curseur masqué pour toute l'app
      if (res) await applyResult();
    });
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
