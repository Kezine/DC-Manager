import { StaleGate } from "./StaleGate";
import { Icons } from "./Icons";
import { OverlayA11y } from "./OverlayA11y";
import { I18n } from "../i18n/I18n";

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

   SERT AUSSI DE SÉLECTEUR D'ENTITÉ (principe n°14) : `ui/EntityPicker` le compose
   pour remplacer les `<select>` d'équipement/de port. Trois capacités lui ont été
   ajoutées pour ça, toutes NEUTRES pour les usages historiques (Certificats,
   interventions) qui ne les emploient pas :
     - un résultat peut être `disabled` (visible, non sélectionnable — parité
       `<option disabled>` : un port occupé reste affiché avec le nom du câble qui
       l'occupe) ;
     - NAVIGATION AU CLAVIER complète (↑/↓, Entrée, Échap) + rôles ARIA de combobox :
       un contrôle qui remplace un `<select>` doit rester utilisable sans souris ;
     - `setPlaceholder` : le libellé de repli d'un sélecteur DÉPEND de l'état du
       formulaire (« Choisir un équipement d'abord » → « Aucun port compatible »).
   ⚠ `minChars: 0` était DÉJÀ praticable (`?? 2` ne se déclenche pas sur 0, et les
   gardes comparent `< minChars`) : rien n'a eu à changer pour ouvrir la liste
   complète au focus — vérifié avant de coder, pas supposé.
   ============================================================================= */

/** Un résultat affichable : identifiant, libellé (ellipsé si trop long), badge (`tag`),
    et une charge utile libre `data` que le consommateur récupère au clic (`onPick`). */
export interface SearchPopResult {
  id: string;
  label: string;
  /** Badge de famille. FACULTATIF : un sélecteur d'entité mono-famille n'a rien à y mettre, et une
      pastille vide (46 px de large, bordée) serait un artefact — on n'émet alors pas l'élément. */
  tag?: string;
  data?: unknown;
  /** Résultat VISIBLE mais NON sélectionnable (grisé, ni clic ni clavier). Sert aux options hors
      jeu qu'il faut malgré tout MONTRER — port occupé, mention « + N masqués ». */
  disabled?: boolean;
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
  /** Nombre de caractères minimal avant de lancer une recherche — défaut 2. `0` ouvre la liste
      complète dès le focus (mode sélecteur : on doit pouvoir PARCOURIR sans taper). */
  minChars?: number;
  /** Mode « barre de listing » (revue design lot C) : le champ devient EXTENSIBLE (flex:1), à la HAUTEUR
      de contrôle unifiée, avec la loupe INTÉGRÉE (`Icons.SEARCH`) — même vocabulaire que la recherche des
      ListView. Défaut false : rendu compact d'origine (sélecteur d'entité en modale, etc.). */
  grow?: boolean;
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
  /** Résultats actuellement affichés — sert à la touche Entrée (= résultat ACTIF). */
  private current: SearchPopResult[] = [];
  /** Nœuds des résultats affichés, INDEXÉS COMME `current` (même rang) — support de la surbrillance
      clavier et de `aria-activedescendant`. */
  private itemNodes: HTMLElement[] = [];
  /** Rang du résultat ACTIF (surligné, cible d'Entrée) ; -1 = aucun. */
  private activeIndex = -1;
  /** Préfixe d'identifiants DOM unique à cette instance (plusieurs SearchPop peuvent coexister dans
      une même modale — deux bouts de câble) : sans lui, `aria-activedescendant` désignerait l'item
      d'un AUTRE champ. */
  private readonly domId: string;

  constructor(private readonly opts: SearchPopOptions) {
    this.debounceMs = opts.debounceMs ?? 180;
    this.minChars = opts.minChars ?? 2;
    this.domId = OverlayA11y.nextId("searchpop");

    const grow = opts.grow === true;
    this.wrap = document.createElement("div");
    // position:relative : ancre le popover absolu au conteneur (indépendant de la toolbar hôte).
    // Mode `grow` (barre de listing) : la classe `.lc-searchpop` porte la loupe, la bordure et la hauteur
    // de contrôle unifiée ; le champ y est extensible et sans bordure propre (box = le conteneur).
    if (grow) this.wrap.className = "lc-searchpop";
    else this.wrap.style.cssText = "position:relative;display:flex;align-items:center;gap:4px";

    this.input = document.createElement("input");
    this.input.type = "text"; this.input.className = "search-input";
    this.input.placeholder = opts.placeholder;
    if (!grow) this.input.style.cssText = "min-width:220px;max-width:320px;padding:6px 10px;flex:none";

    const clear = document.createElement("button");
    clear.type = "button"; clear.className = "btn btn-ghost btn-sm";
    clear.innerHTML = Icons.CLOSE; clear.title = I18n.t("ui.search.clear");
    clear.setAttribute("aria-label", I18n.t("ui.search.clear"));   // une icône seule n'a pas de nom accessible
    clear.onclick = () => this.reset();

    this.pop = document.createElement("div"); this.pop.className = "dc-search-pop";

    // ARIA de COMBOBOX : le couple champ + liste déroulante n'a de sens pour un lecteur d'écran que
    // s'il est ANNONCÉ comme tel. `aria-label` double le placeholder, qui n'est PAS un nom accessible
    // fiable (certains lecteurs l'ignorent, et il disparaît dès la première frappe).
    this.pop.id = this.domId + "-list";
    this.pop.setAttribute("role", "listbox");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-controls", this.pop.id);
    this.input.setAttribute("aria-expanded", "false");
    this.input.setAttribute("aria-label", opts.placeholder);

    this.input.oninput = () => this.onInput();
    this.input.onfocus = () => { if (this.input.value.trim().length >= this.minChars) this.schedule(); };
    // Blur DIFFÉRÉ : laisser passer le `mousedown` d'un item (qui déclenche la sélection avant le blur).
    this.input.onblur = () => { window.setTimeout(() => this.hide(), 150); };
    this.input.onkeydown = (e) => this.onKey(e);

    // Loupe INTÉGRÉE en tête (mode barre de listing) — repère visuel, non focusable (aria-hidden).
    if (grow) {
      const icon = document.createElement("span"); icon.className = "lc-search-ic";
      icon.setAttribute("aria-hidden", "true"); icon.innerHTML = Icons.SEARCH;
      this.wrap.append(icon, this.input, clear, this.pop);
    } else {
      this.wrap.append(this.input, clear, this.pop);
    }
  }

  /** Conteneur à insérer dans une toolbar (input + bouton ✕ + popover). */
  get element(): HTMLElement { return this.wrap; }

  /** Vide le champ et ferme le popover (invalide toute réponse en vol). */
  reset(): void {
    this.input.value = "";
    this.hide();
  }

  /** Donne le focus au champ de saisie. Utile aux composants qui ENVELOPPENT ce composant : leur
      élément racine est un `<div>`, donc non focusable — sans ce relais, un `focus()` de formulaire
      (ouverture de modale, focus du 1er champ fautif) tomberait dans le vide. */
  focus(): void { this.input.focus(); }

  /** Change le texte de repli du champ (et son nom accessible, qui en dérive). Un sélecteur d'entité
      en a besoin : son libellé de repli SUIT l'état du formulaire (« Choisir un équipement d'abord »
      devient « Aucun port compatible » quand l'équipement est choisi mais n'offre rien). */
  setPlaceholder(text: string): void {
    this.input.placeholder = text;
    this.input.setAttribute("aria-label", text);
  }

  /** Ferme le popover, annule l'anti-rebond en cours et périme les réponses en vol. */
  private hide(): void {
    this.gate.bump();
    if (this.timer != null) { window.clearTimeout(this.timer); this.timer = null; }
    this.pop.classList.remove("open");
    this.pop.innerHTML = "";
    this.current = [];
    this.itemNodes = [];
    this.activeIndex = -1;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
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
    this.itemNodes = [];
    this.activeIndex = -1;
    if (!results.length) {
      this.pop.classList.remove("open");
      this.input.setAttribute("aria-expanded", "false");
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    results.forEach((r, index) => {
      const item = document.createElement("div"); item.className = "dc-search-item";
      item.id = this.domId + "-opt-" + index;
      item.setAttribute("role", "option");
      item.title = r.label;   // le libellé est ELLIPSÉ dans un popover de 380 px : le texte entier reste lisible au survol
      if (r.tag) { const tag = document.createElement("span"); tag.className = "dc-search-tag"; tag.textContent = r.tag; item.appendChild(tag); }
      const lab = document.createElement("span"); lab.textContent = r.label;
      lab.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      item.appendChild(lab);
      if (r.disabled) {
        // NON sélectionnable : ni `onmousedown`, ni rang atteignable au clavier. Le style est posé EN
        // LIGNE et non par une classe : une déclaration en ligne l'emporte sur `.dc-search-item:hover`
        // (qui, sinon, ferait paraître l'item cliquable au survol) — et le CSS partagé avec la
        // recherche 3D reste INCHANGÉ, ce qui évite de rouvrir `dc-manager.css` (BOM + commentaires
        // double-encodés : toute retouche s'y fait au niveau octets).
        item.setAttribute("aria-disabled", "true");
        item.style.cssText = "opacity:0.5;cursor:default;background:transparent";
      } else {
        // mousedown (et non click) : se déclenche AVANT le blur du champ, comme la recherche 3D.
        item.onmousedown = (e) => { e.preventDefault(); this.pick(r); };
      }
      this.itemNodes.push(item);
      this.pop.appendChild(item);
    });
    this.pop.classList.add("open");
    this.input.setAttribute("aria-expanded", "true");
    // Actif par DÉFAUT = premier résultat sélectionnable. C'est ce qui préserve à l'identique
    // l'ancien contrat « Entrée = 1er résultat » tant qu'aucun résultat n'est `disabled` et
    // qu'aucune flèche n'a été pressée.
    this.setActive(this.nextSelectable(-1, +1));
  }

  /** Rang du prochain résultat SÉLECTIONNABLE à partir de `from` dans la direction `step`
      (+1 bas, -1 haut). Sans bouclage (on s'arrête aux extrémités, comme `ui/Autocomplete`) ;
      -1 si la liste n'en contient aucun. */
  private nextSelectable(from: number, step: number): number {
    for (let i = from + step; i >= 0 && i < this.current.length; i += step) {
      if (!this.current[i].disabled) return i;
    }
    return from >= 0 && from < this.current.length && !this.current[from].disabled ? from : -1;
  }

  /** Surligne le résultat de rang `index` (et lui seul), et le relie au champ via
      `aria-activedescendant`. Le fond est posé EN LIGNE avec la MÊME variable que `:hover`
      (`--bg-3`) : un survol et une sélection clavier doivent se ressembler. */
  private setActive(index: number): void {
    this.activeIndex = index;
    this.itemNodes.forEach((node, i) => {
      if (this.current[i] && this.current[i].disabled) return;   // item grisé : son style en ligne ne se touche pas
      const on = i === index;
      node.style.background = on ? "var(--bg-3)" : "";
      if (on) node.setAttribute("aria-selected", "true"); else node.removeAttribute("aria-selected");
    });
    const node = index >= 0 ? this.itemNodes[index] : null;
    if (node) {
      this.input.setAttribute("aria-activedescendant", node.id);
      // Le popover plafonne à 340 px : sans ça, la navigation aux flèches sortirait du champ visible.
      try { node.scrollIntoView({ block: "nearest" }); } catch (_) { /* jsdom / navigateurs anciens */ }
    } else this.input.removeAttribute("aria-activedescendant");
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") { this.hide(); this.input.blur(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Liste fermée + flèche bas = « montre-moi les choix » (raccourci d'un `<select>` natif).
      if (!this.itemNodes.length) {
        if (e.key === "ArrowDown" && this.input.value.trim().length >= this.minChars) { e.preventDefault(); this.schedule(); }
        return;
      }
      e.preventDefault();
      const target = this.nextSelectable(this.activeIndex, e.key === "ArrowDown" ? +1 : -1);
      if (target >= 0) this.setActive(target);
      return;
    }
    if (e.key === "Enter") {
      const active = this.activeIndex >= 0 ? this.current[this.activeIndex] : null;
      if (active && !active.disabled) { e.preventDefault(); this.pick(active); }
    }
  }

  /** Sélection d'un résultat : FERME le popover AVANT d'invoquer l'effet (il ne doit pas survivre
      à une navigation déclenchée par `onPick`), puis délègue au consommateur. */
  private pick(r: SearchPopResult): void {
    this.hide();
    this.input.blur();
    this.opts.onPick(r);
  }
}
