/* =============================================================================
   RichTooltip — moteur de TOOLTIPS ENRICHIS (bandeau de titre, sous-titre,
   sections, paires clé/valeur), pour les contrôles dont l'icône seule ne suffit
   pas à expliquer l'effet (cf. actions de la page Certificats).

   HABILLAGE : réutilise le CSS `.app-tooltip` DÉJÀ présent dans dc-manager.css
   (`.tt-title`/`.ricon`, `.tt-sub`, `.tt-sec`, `.tt-line` k/v, `.tt-sep`,
   `.tt-pill`) — ce moteur ne fait qu'instancier l'élément et le positionner.

   CONTENU PAR CLÉ (et non par HTML dans l'attribut) : un élément porte
   `data-rich-tooltip="<clé>"`, le contenu vit dans une MAP typée
   (`register`). Deux raisons :
   - SÉCURITÉ : le moteur construit le DOM lui-même via `textContent` → toute
     donnée interpolée est échappée PAR CONSTRUCTION, une fois, ici. (Passer du
     HTML par attribut obligeait chaque appelant à échapper à la main — et
     l'ancien code ne traitait que `&` et `"`, pas `<`.) Seule exception :
     `icon`, un SVG de CONFIANCE venu de `ui/Icons` — jamais une donnée saisie.
   - Le DOM ne porte plus de blobs de balisage dupliqués sur chaque bouton.

   DÉLÉGATION UNIQUE sur `document` (un seul jeu d'écouteurs, quel que soit le
   nombre de boutons) : `pointerover`/`focusin` → `closest([data-rich-tooltip])`.
   Le tooltip est un COMPLÉMENT : chaque cible garde `aria-label` + `title`
   court, seuls supports lus par les lecteurs d'écran et repli si JS/CSS tombe
   (le CSS pose `pointer-events:none` → le tooltip n'intercepte jamais un clic).

   PLACEMENT : `place()` est une fonction PURE (aucun DOM) → testable headless.
   ============================================================================= */

/** Paire clé/valeur d'une section (rendue en `.tt-line`). */
export interface TipLine { k: string; v: string; }

/** Section d'un tooltip : un intitulé (`.tt-sec`) + du texte libre et/ou des paires. */
export interface TipSection { head?: string; body?: string; lines?: TipLine[]; }

/** Contenu TYPÉ d'un tooltip enrichi. */
export interface TipContent {
  title: string;
  /** SVG BRUT — constante de CONFIANCE (`ui/Icons`) : seul champ injecté en innerHTML. */
  icon?: string;
  sub?: string;
  sections?: TipSection[];
}

/** Rectangle d'ancrage (sous-ensemble de DOMRect — types plats pour rester testable sans DOM). */
export interface TipRect { left: number; top: number; right: number; bottom: number; width: number; height: number; }
export interface TipSize { width: number; height: number; }
export interface TipPoint { x: number; y: number; }

export class RichTooltip {
  /** Attribut porteur de la CLÉ de contenu. */
  static readonly ATTR = "data-rich-tooltip";
  /** Écart entre l'ancre et le tooltip (px). */
  static readonly GAP = 8;

  private static contents = new Map<string, TipContent>();
  private static el: HTMLElement | null = null;
  private static installed = false;

  /* ---------------- Contenus (pur) ---------------- */

  /** Enregistre (ou remplace) le contenu d'une clé. */
  static register(key: string, content: TipContent): void { RichTooltip.contents.set(key, content); }

  /** Enregistre un lot de contenus (`{ "certs.revoke": {...}, … }`). */
  static registerAll(map: { [key: string]: TipContent }): void {
    Object.keys(map).forEach((k) => RichTooltip.register(k, map[k]));
  }

  static get(key: string): TipContent | null { return RichTooltip.contents.get(key) || null; }

  /* ---------------- Placement (PUR — testable headless) ---------------- */

  /** Position du tooltip pour une ancre donnée. Règles :
      - par défaut SOUS l'ancre, centré horizontalement dessus ;
      - FLIP au-dessus si ça déborde en bas ET qu'il y a la place au-dessus
        (sinon on garde le bas et on laisse le clamp faire au mieux) ;
      - CLAMP dans le viewport (jamais de coordonnée négative ; si le tooltip est
        plus grand que le viewport, on colle au bord 0 plutôt que de partir hors-champ). */
  static place(anchor: TipRect, tip: TipSize, vp: TipSize, gap: number = RichTooltip.GAP): TipPoint {
    let y = anchor.bottom + gap;
    const overflowsBottom = y + tip.height > vp.height;
    const roomAbove = anchor.top - gap - tip.height >= 0;
    if (overflowsBottom && roomAbove) y = anchor.top - gap - tip.height;
    y = Math.max(0, Math.min(y, Math.max(0, vp.height - tip.height)));

    let x = anchor.left + anchor.width / 2 - tip.width / 2;
    x = Math.max(0, Math.min(x, Math.max(0, vp.width - tip.width)));
    return { x, y };
  }

  /* ---------------- Rendu (DOM) ---------------- */

  /** Construit le corps du tooltip. TOUT passe par `textContent` (échappement par
      construction) sauf `icon`, SVG de confiance. */
  static render(c: TipContent, root: HTMLElement): void {
    root.replaceChildren();
    const title = document.createElement("div"); title.className = "tt-title";
    if (c.icon) { const ic = document.createElement("span"); ic.className = "ricon"; ic.innerHTML = c.icon; title.appendChild(ic); }
    const tx = document.createElement("span"); tx.textContent = c.title; title.appendChild(tx);
    root.appendChild(title);

    if (c.sub) { const s = document.createElement("div"); s.className = "tt-sub"; s.textContent = c.sub; root.appendChild(s); }

    (c.sections || []).forEach((sec) => {
      if (sec.head) { const h = document.createElement("div"); h.className = "tt-sec"; h.textContent = sec.head; root.appendChild(h); }
      if (sec.body) { const b = document.createElement("div"); b.textContent = sec.body; root.appendChild(b); }
      (sec.lines || []).forEach((ln) => {
        const row = document.createElement("div"); row.className = "tt-line";
        const k = document.createElement("span"); k.className = "tt-k"; k.textContent = ln.k;
        const v = document.createElement("span"); v.className = "tt-v"; v.textContent = ln.v;
        row.append(k, v); root.appendChild(row);
      });
    });
  }

  /* ---------------- Cycle de vie (DOM) ---------------- */

  /** Arme la délégation. Idempotent — appelable depuis le bootstrap sans garde. */
  static install(): void {
    if (RichTooltip.installed || typeof document === "undefined") return;
    RichTooltip.installed = true;
    document.addEventListener("pointerover", (e) => RichTooltip.onEnter(e.target));
    document.addEventListener("focusin", (e) => RichTooltip.onEnter(e.target));
    document.addEventListener("pointerout", (e) => RichTooltip.onLeave(e.target));
    document.addEventListener("focusout", () => RichTooltip.hide());
    // Un tooltip en position:fixed ne suit pas le défilement de son ancre → on le referme.
    window.addEventListener("scroll", () => RichTooltip.hide(), true);
    document.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") RichTooltip.hide(); });
  }

  private static onEnter(target: EventTarget | null): void {
    const host = (target && (target as Element).closest) ? (target as Element).closest("[" + RichTooltip.ATTR + "]") : null;
    if (!host) return;
    const key = host.getAttribute(RichTooltip.ATTR) || "";
    const content = RichTooltip.get(key);
    if (!content) return;   // clé inconnue → aucun tooltip (le `title` natif reste)
    RichTooltip.show(host as HTMLElement, content);
  }

  private static onLeave(target: EventTarget | null): void {
    const host = (target && (target as Element).closest) ? (target as Element).closest("[" + RichTooltip.ATTR + "]") : null;
    if (host) RichTooltip.hide();
  }

  private static show(host: HTMLElement, content: TipContent): void {
    const el = RichTooltip.ensureEl();
    RichTooltip.render(content, el);
    // Afficher AVANT de mesurer : un élément en display:none n'a pas de dimensions.
    el.style.display = "block"; el.style.left = "0px"; el.style.top = "0px";
    const a = host.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const p = RichTooltip.place(
      { left: a.left, top: a.top, right: a.right, bottom: a.bottom, width: a.width, height: a.height },
      { width: t.width, height: t.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.style.left = p.x + "px"; el.style.top = p.y + "px";
  }

  private static hide(): void { if (RichTooltip.el) RichTooltip.el.style.display = "none"; }

  private static ensureEl(): HTMLElement {
    if (!RichTooltip.el || !RichTooltip.el.isConnected) {
      const d = document.createElement("div"); d.className = "app-tooltip";
      document.body.appendChild(d); RichTooltip.el = d;
    }
    return RichTooltip.el;
  }
}
