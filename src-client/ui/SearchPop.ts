import { StaleGate } from "./StaleGate";

/* =============================================================================
   SearchPop — champ de recherche + popover de résultats, composant RÉUTILISABLE
   (input `.search-input` + liste déroulante `.dc-search-pop`).

   Calqué sur la recherche de la vue 3D (`DcPanels.buildSearchBox`) dont il REPREND
   le balisage et le CSS (`.search-input`, `.dc-search-pop`/`.open`, `.dc-search-item`,
   `.dc-search-tag`) SANS les dupliquer. GÉNÉRIQUE : la source des résultats (`fetch`)
   et l'effet du clic (`onPick`) sont INJECTÉS — le composant ne connaît ni le réseau,
   ni la vue qui l'emploie (principe n°2 : couplage par paramètres, pas par import).

   Piste de rangement (cadrage certs §4) : la vue Datacenter n'est PAS migrée sur ce
   composant dans ce chantier (`DcPanels` reste tel quel) ; l'y migrer serait une
   simplification future — le CSS est déjà partagé.

   FRAÎCHEUR DES RÉPONSES : les fetchs sont asynchrones et concurrents ; la réponse
   d'une saisie ANCIENNE ne doit pas écraser l'affichage d'une saisie récente. Un
   `StaleGate` (compteur de génération, pur et testé) tranche à la résolution.
   ============================================================================= */

/** Un résultat affichable : identifiant, libellé (ellipsé si trop long), badge (`tag`),
    et une charge utile libre `data` que le consommateur récupère au clic (`onPick`). */
export interface SearchPopResult {
  id: string;
  label: string;
  tag: string;
  data?: unknown;
}

/** Options d'un SearchPop — tout est injecté (le composant est agnostique de la donnée). */
export interface SearchPopOptions {
  placeholder: string;
  /** Source des résultats d'une requête (asynchrone : réseau, index en mémoire…). */
  fetch: (query: string) => Promise<SearchPopResult[]>;
  /** Effet du clic / de la touche Entrée sur un résultat (navigation, sélection…). */
  onPick: (result: SearchPopResult) => void;
  /** Anti-rebond des saisies (ms) — défaut 180 (parité ListView / vue 3D). */
  debounceMs?: number;
  /** Nombre de caractères minimal avant de lancer une recherche — défaut 2. */
  minChars?: number;
}

export class SearchPop {
  /** Conteneur positionné (contexte du popover absolu) : input + bouton ✕ + popover. */
  private readonly wrap: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly pop: HTMLElement;
  /** Garde de fraîcheur : ignore la réponse d'une saisie devancée par une plus récente. */
  private readonly gate = new StaleGate();
  private readonly debounceMs: number;
  private readonly minChars: number;
  /** Timer d'anti-rebond en cours (null = aucun). */
  private timer: number | null = null;
  /** Résultats actuellement affichés — sert à la touche Entrée (= 1er résultat). */
  private current: SearchPopResult[] = [];

  constructor(private readonly opts: SearchPopOptions) {
    this.debounceMs = opts.debounceMs ?? 180;
    this.minChars = opts.minChars ?? 2;

    this.wrap = document.createElement("div");
    // position:relative : ancre le popover absolu au conteneur (indépendant de la toolbar hôte).
    this.wrap.style.cssText = "position:relative;display:flex;align-items:center;gap:4px";

    this.input = document.createElement("input");
    this.input.type = "text"; this.input.className = "search-input";
    this.input.placeholder = opts.placeholder;
    this.input.style.cssText = "min-width:220px;max-width:320px;padding:6px 10px;flex:none";

    const clear = document.createElement("button");
    clear.type = "button"; clear.className = "btn btn-ghost btn-sm";
    clear.textContent = "✕"; clear.title = "Effacer la recherche";
    clear.onclick = () => this.reset();

    this.pop = document.createElement("div"); this.pop.className = "dc-search-pop";

    this.input.oninput = () => this.onInput();
    this.input.onfocus = () => { if (this.input.value.trim().length >= this.minChars) this.schedule(); };
    // Blur DIFFÉRÉ : laisser passer le `mousedown` d'un item (qui déclenche la sélection avant le blur).
    this.input.onblur = () => { window.setTimeout(() => this.hide(), 150); };
    this.input.onkeydown = (e) => this.onKey(e);

    this.wrap.append(this.input, clear, this.pop);
  }

  /** Conteneur à insérer dans une toolbar (input + bouton ✕ + popover). */
  get element(): HTMLElement { return this.wrap; }

  /** Vide le champ et ferme le popover (invalide toute réponse en vol). */
  reset(): void {
    this.input.value = "";
    this.hide();
  }

  /** Ferme le popover, annule l'anti-rebond en cours et périme les réponses en vol. */
  private hide(): void {
    this.gate.bump();
    if (this.timer != null) { window.clearTimeout(this.timer); this.timer = null; }
    this.pop.classList.remove("open");
    this.pop.innerHTML = "";
    this.current = [];
  }

  private onInput(): void {
    if (this.input.value.trim().length < this.minChars) { this.hide(); return; }
    this.schedule();
  }

  /** (Re)programme un fetch après l'anti-rebond — une saisie annule le fetch programmé précédent. */
  private schedule(): void {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.run(); }, this.debounceMs);
  }

  /** Lance le fetch et n'applique la réponse que si elle est encore FRAÎCHE (StaleGate). */
  private async run(): Promise<void> {
    const q = this.input.value.trim();
    if (q.length < this.minChars) { this.hide(); return; }
    const token = this.gate.begin();
    let results: SearchPopResult[];
    // Échec silencieux : un champ de recherche ne doit pas bloquer l'UI ni afficher d'erreur intrusive.
    try { results = await this.opts.fetch(q); }
    catch (_) { if (this.gate.isCurrent(token)) this.hide(); return; }
    if (!this.gate.isCurrent(token)) return;   // une saisie plus récente est partie → réponse périmée
    this.renderResults(results);
  }

  private renderResults(results: SearchPopResult[]): void {
    this.current = results;
    this.pop.innerHTML = "";
    if (!results.length) { this.pop.classList.remove("open"); return; }
    for (const r of results) {
      const item = document.createElement("div"); item.className = "dc-search-item";
      const tag = document.createElement("span"); tag.className = "dc-search-tag"; tag.textContent = r.tag;
      const lab = document.createElement("span"); lab.textContent = r.label;
      lab.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      item.append(tag, lab);
      // mousedown (et non click) : se déclenche AVANT le blur du champ, comme la recherche 3D.
      item.onmousedown = (e) => { e.preventDefault(); this.pick(r); };
      this.pop.appendChild(item);
    }
    this.pop.classList.add("open");
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") { this.hide(); this.input.blur(); }
    else if (e.key === "Enter") { if (this.current.length) this.pick(this.current[0]); }   // Entrée = 1er résultat
  }

  /** Sélection d'un résultat : FERME le popover AVANT d'invoquer l'effet (il ne doit pas survivre
      à une navigation déclenchée par `onPick`), puis délègue au consommateur. */
  private pick(r: SearchPopResult): void {
    this.hide();
    this.input.blur();
    this.opts.onPick(r);
  }
}
