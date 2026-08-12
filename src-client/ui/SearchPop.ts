import { StaleGate } from "./StaleGate";
import { Icons } from "./Icons";
import { OverlayA11y } from "./OverlayA11y";
import { Fullscreen } from "./Fullscreen";
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
   ajoutées pour ça, toutes NEUTRES pour l'usage historique (la sélection d'entité
   des interventions) qui ne les emploie pas :
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

   EXTENSIONS DU LOT L3 « éditeur de route » (cadrage route-editor, décision D4) —
   toutes ADDITIVES et OPTIONNELLES, aucun consommateur existant ne change :
     - EN-TÊTES DE GROUPE : un résultat peut porter `group` (+ `groupHint` discret,
       ex. « · conteneur du bout B ») ; un en-tête se peint quand le groupe change
       entre deux items consécutifs. Les groupes vides disparaissent d'eux-mêmes :
       le filtrage AMONT (celui du `fetch`) retire leurs items, donc leur en-tête ;
     - LIGNE DE MOTIF sous un item `disabled` (`reason`) : le « pourquoi pas »
       s'apprend en LISANT la liste, au lieu d'être découvert par un refus ;
     - `itemClass` : classe CSS additionnelle d'un item (mise en avant d'une
       catégorie — ex. exits accentués de l'éditeur de route) — une CLASSE, jamais
       un style en dur, pour que le thème reste dans le CSS ;
     - `footHint` : ligne d'aide ÉPINGLÉE au pied du popover (raccourcis clavier) ;
     - `onPick` reçoit les MODIFICATEURS du geste (`shift`) — support de
       « Maj+Entrée = ajouter et rouvrir » chez les consommateurs qui enchaînent ;
     - mode PORTAIL (`portal`) : le popover s'accroche à l'HÔTE COURANT (<body>,
       ou l'élément plein écran via `Fullscreen.host()`) en position:fixed le temps
       d'être ouvert. INDISPENSABLE quand le champ vit dans un conteneur qui ROGNE
       (corps DÉFILANT d'une modale, liste à max-height, panneau 3D `.dc-side`) : un
       popover en position absolue y est coupé par l'overflow. Repositionné au scroll
       (capture — les défilements INTERNES de la modale comptent) et au resize,
       re-parqué dans le champ à la fermeture (il meurt donc avec lui).
   La navigation clavier SAUTE en-têtes, motifs et pied : seuls les items vivent
   dans `itemNodes`/`current`, le reste est `role="presentation"`.

   MODE HÉBERGÉ (`host`, refonte du filtre CIBLE 2026-08-03 — maquette
   design-system/briefs/filtre-cible-porteur-maquette §3/§10) : le champ et la
   liste se rendent DANS des conteneurs FOURNIS par l'hôte (le panneau du
   déclencheur de ui/FilterBar) au lieu du couple « champ nu + popover
   flottant ». TOUTE la mécanique reste ici — anti-rebond, StaleGate, clavier
   ↑↓/↵/Échap, ARIA combobox, rendu des items — l'hôte ne peint que son
   HABILLAGE d'états (invite, squelette, vide, pied) au fil des rappels
   `onState` : zéro logique de recherche dupliquée (principe n°14). Extension
   RÉTROCOMPATIBLE : sans `host`, rien ne change d'un pixel.
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
  /** EN-TÊTE DE GROUPE : un en-tête est peint quand `group` change entre deux résultats consécutifs
      (le producteur fournit une liste DÉJÀ ordonnée par groupes). Absent = pas d'en-tête. */
  group?: string;
  /** Complément DISCRET de l'en-tête de groupe (« · conteneur du bout B ») — pertinence, provenance.
      Lu sur le PREMIER item du groupe (les suivants n'ont pas à le répéter). */
  groupHint?: string;
  /** MOTIF affiché SOUS un résultat `disabled` : pourquoi ce choix est refusé ICI. Ignoré sur un
      résultat sélectionnable (un motif sous un item cliquable serait un contresens). */
  reason?: string;
  /** Classe CSS ADDITIONNELLE de l'item (ex. `rc-pop-exit` : exits saillants de l'éditeur de
      route). Une classe et non un style : la teinte reste dans le CSS, thème compris. */
  itemClass?: string;
  /** MENTION épinglée en FIN de rangée (classe `.dc-search-tail`) : un ÉTAT court lisible d'un coup
      d'œil — ex. « déjà pris » du filtre cible (maquette filtre-cible §4). L'explication LONGUE d'un
      refus passe, elle, par `reason` (ligne dédiée sous l'item) : deux registres, deux champs. */
  tail?: string;
}

/** MODIFICATEURS du geste de sélection (clic ou Entrée). `shift` porte « ajouter et ROUVRIR »
    (Maj+Entrée / Maj+clic) chez les consommateurs qui enchaînent les ajouts — le composant ne fait
    que TRANSMETTRE le geste, l'interprétation appartient au `onPick`. */
export interface SearchPopPickModifiers { shift: boolean }

/** États annoncés à l'HÔTE du mode hébergé : repos (rien à montrer — invite), chargement (fetch en
    vol — squelette), vide (aucun résultat pour la saisie), résultats (la liste est peinte). */
export type SearchPopHostState = "idle" | "loading" | "empty" | "results";

/** Conteneurs de l'HÔTE du mode hébergé (cf. bloc d'en-tête « MODE HÉBERGÉ »). */
export interface SearchPopHost {
  /** Conteneur du CHAMP : l'input s'y INSÈRE (l'hôte y a déjà posé sa loupe). L'input n'y reçoit ni
      la classe `.search-input` ni les styles compacts : l'écrin visuel (bordure, hauteur, focus)
      appartient à l'hôte (`.tf-field` + `.tf-field input` côté CSS). Pas de bouton ✕ non plus —
      l'effacement d'une valeur POSÉE appartient au panneau (rangée `.tf-cur-x`), pas au champ. */
  field: HTMLElement;
  /** Conteneur de la LISTE : il DEVIENT la listbox (rôle, id, contenu, `aria-controls` du champ) —
      le popover flottant n'existe pas dans ce mode ; la VISIBILITÉ de ce conteneur est pilotée par
      l'hôte au fil des états (`onState`), jamais par la classe `.open`. */
  list: HTMLElement;
  /** Rappel d'ÉTAT à chaque transition. `count` = nombre de résultats affichés (sert au pied
      « plafond atteint » de l'hôte). */
  onState?: (state: SearchPopHostState, query: string, count: number) => void;
}

/** Options d'un SearchPop — tout est injecté (le composant est agnostique de la donnée). */
export interface SearchPopOptions {
  placeholder: string;
  /** Source des résultats d'une requête (asynchrone : réseau, index en mémoire…). */
  fetch: (query: string) => Promise<SearchPopResult[]>;
  /** Effet du clic / de la touche Entrée sur un résultat (navigation, sélection…). Le second
      paramètre (modificateurs du geste) est OPTIONNEL : les consommateurs historiques l'ignorent. */
  onPick: (result: SearchPopResult, modifiers?: SearchPopPickModifiers) => void;
  /** Anti-rebond des saisies (ms) — défaut 180 (parité ListView / vue 3D). */
  debounceMs?: number;
  /** Nombre de caractères minimal avant de lancer une recherche — défaut 2. `0` ouvre la liste
      complète dès le focus (mode sélecteur : on doit pouvoir PARCOURIR sans taper). */
  minChars?: number;
  /** Mode « barre de listing » (revue design lot C) : le champ devient EXTENSIBLE (flex:1), à la HAUTEUR
      de contrôle unifiée, avec la loupe INTÉGRÉE (`Icons.SEARCH`) — même vocabulaire que la recherche des
      ListView. Défaut false : rendu compact d'origine (sélecteur d'entité en modale, etc.). */
  grow?: boolean;
  /** Ligne d'AIDE épinglée au pied du popover (raccourcis clavier…). Absente par défaut. */
  footHint?: string;
  /** Mode PORTAIL : le popover, ouvert, est accroché à `<body>` en position:fixed (classe
      `.dc-pop-portal`) et suit son champ au scroll/resize — il ÉCHAPPE ainsi à tout conteneur qui
      rogne (corps défilant d'une modale, liste à max-height). Défaut false : popover absolu dans le
      champ, comportement historique. */
  portal?: boolean;
  /** Mode HÉBERGÉ : champ et liste rendus DANS les conteneurs de l'hôte (cf. `SearchPopHost` et le
      bloc d'en-tête). Exclusif de `portal` : le conteneur hôte (panneau du filtre cible) est
      LUI-MÊME un portail — la liste, en flux dedans, n'a rien à fuir. */
  host?: SearchPopHost;
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
  /** Mode PORTAIL (cf. SearchPopOptions.portal). */
  private readonly portal: boolean;
  /** Mode HÉBERGÉ (cf. SearchPopOptions.host) — null = comportement historique. */
  private readonly host: SearchPopHost | null;

  constructor(private readonly opts: SearchPopOptions) {
    this.debounceMs = opts.debounceMs ?? 180;
    this.minChars = opts.minChars ?? 2;
    this.host = opts.host ?? null;
    // Portail et mode hébergé s'EXCLUENT (cf. SearchPopOptions.host) : l'hôte prime.
    this.portal = opts.portal === true && !this.host;
    this.domId = OverlayA11y.nextId("searchpop");

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = opts.placeholder;

    if (this.host) {
      // -- MODE HÉBERGÉ : aucun wrap propre, aucun bouton ✕, aucun popover — champ et liste vivent
      // dans les conteneurs de l'HÔTE. L'input reste NU (ni `.search-input` ni styles compacts) :
      // l'écrin visuel est celui de l'hôte (`.tf-field`). `wrap` = le conteneur du champ, pour que
      // les gardes d'ancrage (`wrap.isConnected`) restent vraies partout.
      this.wrap = this.host.field;
      this.pop = this.host.list;
      this.wrap.appendChild(this.input);
    } else {
      const grow = opts.grow === true;
      this.wrap = document.createElement("div");
      // position:relative : ancre le popover absolu au conteneur (indépendant de la toolbar hôte).
      // Mode `grow` (barre de listing) : la classe `.lc-searchpop` porte la loupe, la bordure et la hauteur
      // de contrôle unifiée ; le champ y est extensible et sans bordure propre (box = le conteneur).
      if (grow) this.wrap.className = "lc-searchpop";
      else this.wrap.style.cssText = "position:relative;display:flex;align-items:center;gap:4px";

      this.input.className = "search-input";
      if (!grow) this.input.style.cssText = "min-width:220px;max-width:320px;padding:6px 10px;flex:none";

      const clear = document.createElement("button");
      clear.type = "button"; clear.className = "btn btn-ghost btn-sm";
      clear.innerHTML = Icons.CLOSE; clear.title = I18n.t("ui.search.clear");
      clear.setAttribute("aria-label", I18n.t("ui.search.clear"));   // une icône seule n'a pas de nom accessible
      clear.onclick = () => this.reset();

      this.pop = document.createElement("div"); this.pop.className = "dc-search-pop";
      // La classe portail porte position:fixed + z-index AU-DESSUS des dialogues (le popover sera un
      // enfant direct de l'hôte courant — body ou élément plein écran — le temps d'être ouvert) ; les
      // coordonnées, elles, sont posées en ligne par `portalPosition` à chaque ouverture/défilement.
      if (this.portal) this.pop.classList.add("dc-pop-portal");

      // Loupe INTÉGRÉE en tête (mode barre de listing) — repère visuel, non focusable (aria-hidden).
      if (grow) {
        const icon = document.createElement("span"); icon.className = "lc-search-ic";
        icon.setAttribute("aria-hidden", "true"); icon.innerHTML = Icons.SEARCH;
        this.wrap.append(icon, this.input, clear, this.pop);
      } else {
        this.wrap.append(this.input, clear, this.pop);
      }
    }

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
    // PAS en mode hébergé : la vie du panneau hôte est pilotée par LUI (clic extérieur, Échap) — un
    // hide() au blur viderait la liste dès qu'on clique un ✕ de valeur courante dans le panneau.
    if (!this.host) this.input.onblur = () => { window.setTimeout(() => this.hide(), 150); };
    this.input.onkeydown = (e) => this.onKey(e);
  }

  /** Conteneur à insérer dans une toolbar (input + bouton ✕ + popover). ⚠ Mode HÉBERGÉ : ne PAS
      l'insérer — champ et liste vivent déjà dans les conteneurs de l'hôte. */
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

  /** RELANCE la recherche courante (si la saisie atteint le minimum ; sinon, retour au repos).
      Sert à l'hôte du mode hébergé dont la DÉCORATION des résultats dépend d'un état EXTERNE au
      composant — ex. la mention « déjà pris » du filtre cible après le retrait d'une valeur : les
      items affichés ont été décorés au fetch, seul un nouveau fetch les remet d'aplomb. */
  refresh(): void {
    if (this.input.value.trim().length >= this.minChars) this.schedule();
    else this.hide();
  }

  /** Ferme le popover, annule l'anti-rebond en cours et périme les réponses en vol. */
  private hide(): void {
    this.gate.bump();
    if (this.timer != null) { window.clearTimeout(this.timer); this.timer = null; }
    // Mode portail : re-parquer le popover DANS le champ. S'il restait sur son hôte, un champ détruit
    // (repeint de formulaire, fermeture de modale) laisserait un nœud orphelin dans la page ; parqué
    // dans son wrap, il disparaît AVEC lui. Les écouteurs de suivi n'ont plus lieu d'être fermés.
    // On compare à l'hôte COURANT (body OU élément plein écran) — c'est là que `openPortal` l'a posé
    // et que `Fullscreen.rehomeAll` le maintient au fil des `fullscreenchange`.
    if (this.portal && this.pop.parentElement === Fullscreen.host()) {
      window.removeEventListener("scroll", this.portalFollow, true);
      window.removeEventListener("resize", this.portalFollow);
      this.pop.style.top = ""; this.pop.style.left = "";
      this.wrap.appendChild(this.pop);
    }
    if (!this.host) this.pop.classList.remove("open");
    this.clearResults();
    this.notifyHost("idle");
  }

  /** Vide la liste et l'état ARIA associé — partagé entre `hide` et le rendu « aucun résultat » du
      mode hébergé, où une liste vide n'est PAS une fermeture (l'hôte affiche son état « vide »). */
  private clearResults(): void {
    this.pop.innerHTML = "";
    this.current = [];
    this.itemNodes = [];
    this.activeIndex = -1;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }

  /** Annonce un ÉTAT à l'hôte (mode hébergé seulement — no-op sinon). */
  private notifyHost(state: SearchPopHostState): void {
    if (this.host && this.host.onState) this.host.onState(state, this.input.value.trim(), this.current.length);
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
    // Mode hébergé : la requête PART — l'hôte peut montrer son squelette (il choisit de garder les
    // résultats déjà affichés s'il y en a : « ne blanchit jamais », parité listings).
    this.notifyHost("loading");
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
      // Mode hébergé : « aucun résultat » n'est PAS une fermeture — l'hôte peint son état vide (qui
      // CITE la saisie). Le popover flottant, lui, n'a rien à montrer et se ferme (historique).
      if (this.host) { this.clearResults(); this.notifyHost("empty"); }
      else this.hide();   // en mode portail, il faut AUSSI re-parquer le popover et couper le suivi
      return;
    }
    // Groupe du résultat PRÉCÉDENT : un en-tête se peint quand il change (les groupes vides ont
    // déjà disparu — le producteur ne fournit pas d'item, donc pas d'en-tête).
    let previousGroup: string | null = null;
    results.forEach((r, index) => {
      const group = r.group != null ? r.group : null;
      if (group !== null && group !== previousGroup) {
        // EN-TÊTE : hors du contrat de listbox (`role="presentation"`) — la navigation clavier ne le
        // voit pas (seuls les items vivent dans `itemNodes`), les lecteurs d'écran ne le comptent
        // pas comme option.
        const head = document.createElement("div"); head.className = "dc-search-grp";
        head.setAttribute("role", "presentation");
        const title = document.createElement("span"); title.textContent = group;
        head.appendChild(title);
        if (r.groupHint) {
          const why = document.createElement("span"); why.className = "dc-search-grp-why";
          why.textContent = r.groupHint;
          head.appendChild(why);
        }
        this.pop.appendChild(head);
      }
      previousGroup = group;
      const item = document.createElement("div");
      item.className = "dc-search-item" + (r.itemClass ? " " + r.itemClass : "");
      item.id = this.domId + "-opt-" + index;
      item.setAttribute("role", "option");
      item.title = r.label;   // le libellé est ELLIPSÉ dans un popover de 380 px : le texte entier reste lisible au survol
      if (r.tag) { const tag = document.createElement("span"); tag.className = "dc-search-tag"; tag.textContent = r.tag; item.appendChild(tag); }
      // Classe `dc-search-lb` : accroche de MISE EN PAGE des hôtes (le panneau du filtre cible étire
      // le libellé pour épingler la mention de fin à droite — règle scopée `.tf-list`) ; aucun style
      // global n'y est attaché, l'ellipse reste portée par le style en ligne historique.
      const lab = document.createElement("span"); lab.className = "dc-search-lb"; lab.textContent = r.label;
      lab.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      item.appendChild(lab);
      // Mention ÉPINGLÉE en fin de rangée (ex. « déjà pris » du filtre cible) — un état court, pas
      // une explication (l'explication d'un refus passe par `reason`, ligne dédiée sous l'item).
      if (r.tail) {
        const tail = document.createElement("span"); tail.className = "dc-search-tail";
        tail.textContent = r.tail;
        item.appendChild(tail);
      }
      if (r.disabled) {
        // NON sélectionnable : ni `onmousedown`, ni rang atteignable au clavier. Le style passe par la
        // classe `.dc-search-off` (opacité + hover neutralisé) — HISTORIQUEMENT posé en ligne pour ne
        // pas rouvrir `dc-manager.css` ; la refonte du filtre cible a rouvert le fichier ET exige de
        // pouvoir SURCLASSER l'estompe (item « déjà pris » accentué `.is-on`, maquette §4), chose
        // impossible face à un style en ligne. Mêmes déclarations, pixel pour pixel, pour les
        // consommateurs historiques (EntityPicker, éditeur de route).
        item.setAttribute("aria-disabled", "true");
        item.classList.add("dc-search-off");
      } else {
        // mousedown (et non click) : se déclenche AVANT le blur du champ, comme la recherche 3D.
        // Maj+clic transmet le modificateur — même contrat que Maj+Entrée (cf. onKey).
        item.onmousedown = (e) => { e.preventDefault(); this.pick(r, { shift: e.shiftKey }); };
      }
      this.itemNodes.push(item);
      this.pop.appendChild(item);
      // MOTIF sous l'item grisé : le « pourquoi pas » se lit dans la liste (maquette route §04).
      if (r.disabled && r.reason) {
        const reason = document.createElement("div"); reason.className = "dc-search-reason";
        reason.setAttribute("role", "presentation");
        reason.textContent = r.reason;
        this.pop.appendChild(reason);
      }
    });
    // Pied d'AIDE épinglé (sticky en CSS) — hors listbox lui aussi.
    if (this.opts.footHint) {
      const foot = document.createElement("div"); foot.className = "dc-search-foot";
      foot.setAttribute("role", "presentation");
      foot.textContent = this.opts.footHint;
      this.pop.appendChild(foot);
    }
    // Mode hébergé : la visibilité du conteneur hôte est pilotée par l'hôte (onState) — la classe
    // `.open` n'appartient qu'au popover flottant.
    if (!this.host) this.pop.classList.add("open");
    if (this.portal) this.openPortal();
    this.input.setAttribute("aria-expanded", "true");
    // Actif par DÉFAUT = premier résultat sélectionnable. C'est ce qui préserve à l'identique
    // l'ancien contrat « Entrée = 1er résultat » tant qu'aucun résultat n'est `disabled` et
    // qu'aucune flèche n'a été pressée.
    this.setActive(this.nextSelectable(-1, +1));
    this.notifyHost("results");
  }

  /* ------------------------------------------------------------ mode portail -- */

  /** Accroche le popover ouvert à l'HÔTE COURANT (`<body>` hors plein écran, sinon l'élément plein
      écran) et démarre le SUIVI de son champ. On ne l'accroche PAS en dur à `<body>` : un `.dc-side`
      qui porte un entityPicker peut être en plein écran, et un enfant de `<body>` y serait masqué par
      le « top layer ». `position:fixed` reste écran-relatif dans un élément plein écran, donc
      `portalPlace` (coordonnées viewport) reste valable. ⚠ JAMAIS `.modal-overlay` : son
      `backdrop-filter` et l'animation `slideUp` de `.modal` créent des blocs conteneurs pour `fixed`.
      Le scroll est écouté en CAPTURE : les défilements qui déplacent le champ sont ceux de conteneurs
      INTERNES (corps de la modale, liste d'étapes), dont les événements ne remontent pas jusqu'à
      `window` en bouillonnant. */
  private openPortal(): void {
    if (!this.wrap.isConnected) { this.hide(); return; }
    const host = Fullscreen.host();
    if (this.pop.parentElement !== host) {
      host.appendChild(this.pop);
      window.addEventListener("scroll", this.portalFollow, true);
      window.addEventListener("resize", this.portalFollow);
    }
    this.portalPosition();
  }

  /** Suivi (scroll/resize) : si le champ a disparu (repeint, modale fermée), on FERME au lieu de
      laisser un popover flotter sans ancre. */
  private readonly portalFollow = (): void => {
    if (!this.wrap.isConnected) { this.hide(); return; }
    this.portalPosition();
  };

  /** POSITIONNEMENT PARTAGÉ d'un élément porté sur `<body>` (`.dc-pop-portal`) sous une ANCRE :
      sous elle, borné aux bords de l'écran, BASCULÉ au-dessus quand la place manque dessous et
      qu'il y en a davantage dessus. Mesure APRÈS insertion dans le DOM (offsetHeight réel — la
      hauteur dépend du contenu). STATIQUE et public : le PANNEAU du filtre cible (ui/FilterBar)
      ancre sa coque `.tf-panel` au déclencheur avec la MÊME règle (maquette filtre-cible §5,
      « aucun code de positionnement nouveau »). */
  static portalPlace(anchor: HTMLElement, portal: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const gap = 4;   // même écart que le popover absolu historique (top: calc(100% + 4px))
    const portalHeight = portal.offsetHeight;
    let top = rect.bottom + gap;
    if (top + portalHeight > window.innerHeight && rect.top - gap - portalHeight >= 0) {
      top = rect.top - gap - portalHeight;
    }
    const portalWidth = portal.offsetWidth;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - portalWidth - 8));
    portal.style.top = Math.round(top) + "px";
    portal.style.left = Math.round(left) + "px";
  }

  /** Coordonnées viewport du popover portail de CETTE instance (délègue à la règle partagée). */
  private portalPosition(): void { SearchPop.portalPlace(this.wrap, this.pop); }

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
      if (this.current[i] && this.current[i].disabled) return;   // item grisé : jamais surligné (il n'est pas une cible d'Entrée)
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
      // Maj+Entrée transmet le modificateur (« ajouter et rouvrir » chez qui veut l'entendre).
      if (active && !active.disabled) { e.preventDefault(); this.pick(active, { shift: e.shiftKey }); }
    }
  }

  /** Sélection d'un résultat : FERME le popover AVANT d'invoquer l'effet (il ne doit pas survivre
      à une navigation déclenchée par `onPick`), puis délègue au consommateur — modificateurs du
      geste inclus (les consommateurs historiques les ignorent : paramètre optionnel). */
  private pick(r: SearchPopResult, modifiers: SearchPopPickModifiers): void {
    this.hide();
    this.input.blur();
    this.opts.onPick(r, modifiers);
  }
}
