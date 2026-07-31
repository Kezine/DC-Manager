/* =============================================================================
   RouteChainEditor — LA ROUTE COMME UNE CHAÎNE ORDONNÉE.

   Remplace, dans les DEUX formulaires (câble et faisceau), les trois champs
   historiques : le nuage de cases « Points de passage » groupé par TYPE, le hint
   de route en texte, et la seconde liste « Ordre des points » à boutons ↑/↓. Ces
   trois-là disaient la même chose deux fois (sélection d'un côté, ordre de
   l'autre) alors qu'une route EST une séquence — c'est le mal n°1 du carton
   `design-system/briefs/route-editor-waypoints.md` §2.3.

   Rendu conforme à la maquette `route-editor-waypoints.maquette.html` : deux
   ANCRES fixes encadrent la liste, des BANDEAUX découpent les tronçons par
   conteneur (« Transit » en pointillé quand un exit reste ouvert), chaque ÉTAPE
   porte son n°, son glyphe, son nom, son conteneur et ses actions, chaque ERREUR
   se pose SUR SON ÉTAPE, et le pied garde la synthèse.

   COUPLAGE PAR INTERFACE (principe n°2) : ce composant n'importe AUCUN
   formulaire et ne connaît NI le store NI le modèle. Tout passe par
   `RouteChainHost` — le brouillon (lu/écrit), l'ANALYSE (`cableRoute` ou
   `bundleRoute`, c'est l'appelant qui tranche), les ancres, les libellés, les
   candidats, l'action d'inversion et le signal « modifié ». C'est ce qui rend le
   composant STRICTEMENT le même pour les deux formulaires (carton §4.5) : seules
   les ancres changent — des ports d'un côté, des patchs de l'autre.

   LA GRAMMAIRE N'EST PAS ICI. Toutes les décisions (une étape est-elle fautive ?
   la route est-elle en transit ? ce candidat est-il proposable ?) viennent de
   `core/RouteEligibility`, module PUR et testé, qui lui-même CONSOMME
   `store/CableRouteAnalyzer`. Ce fichier ne fait que peindre.

   ---------------------------------------------------------------------------
   PISTE D'AMÉLIORATION — REPLI D'UNE CHAÎNE LONGUE (décision D1 du cadrage,
   tranchée par l'utilisateur le 2026-07-31 : PAS de repli pour l'instant).
   La liste défile dans un conteneur à hauteur maximale (`.rc-steps`, ~340 px).
   SI ce défilement s'avérait insuffisant à l'usage — routes de 10+ étapes, ou
   modale déjà dense — la piste retenue serait un REPLI de la chaîne quand elle
   est VALIDE et longue : une ligne « 7 étapes · voir » qui se déplie au clic.
   Volontairement NON implémenté : on ne replie pas ce qu'on n'a pas encore vu
   déborder. Les BANDEAUX COLLANTS en tête du défilement, eux, relèvent du lot L4
   (confort), au même titre que le glisser-déposer et le responsive tactile.
   ============================================================================= */
import { IconButton } from "../../ui/IconButton";
import { Icons } from "../../ui/Icons";
import { SearchPop } from "../../ui/SearchPop";
import type { SearchPopResult } from "../../ui/SearchPop";
import { I18n } from "../../i18n/I18n";
import { RouteEligibility } from "../../core/RouteEligibility";
import type { RouteAnalyze, RouteBlockCode, RouteCandidate, RouteInsertState } from "../../core/RouteEligibility";
import type { RouteAnalysis } from "../../store/CableRouteAnalyzer";
import { PlacementContainers } from "../../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../../src-shared/PlacementContainers";

/** Une ANCRE (bout d'un câble, extrémité d'un faisceau) telle que l'hôte la décrit. */
export interface RouteChainAnchor {
  /** Étiquette courte de la colonne de gauche (« Bout A », « Extrémité A »). */
  tag: string;
  /** Sujet employé DANS UNE PHRASE (« le bout A », « l'extrémité A ») — le message d'alerte est
      unique et paramétré, plutôt que dupliqué en version câble et version faisceau. */
  subject: string;
  /** Libellé affiché (« GPFS21 · port 3 »), ou vide si le bout n'est pas encore choisi. */
  label: string;
  container: PlacementContainer | null;
}

/** De quoi peindre UNE étape — le strict nécessaire, dérivé du `Waypoint` par l'hôte. */
export interface RouteChainStep {
  /** Glyphe de `Waypoint.glyph` (◆ ▬ ▦ ⏏ ◎) — on n'en invente pas d'autres (carton §7). */
  glyph: string;
  name: string;
}

/** Un waypoint proposable, décrit pour `RouteEligibility` PLUS son habillage d'affichage. */
export interface RouteChainCandidate extends RouteCandidate {
  glyph: string;
  name: string;
}

/** Ce que le composant attend de son hôte (aucun import de formulaire — cf. en-tête). */
export interface RouteChainHost {
  /** Le BROUILLON courant. Relu à chaque rendu : l'hôte reste propriétaire de son tableau. */
  ids(): string[];
  /** Écrit le brouillon. L'hôte décide QUOI en faire (ici : remplacer le contenu de `wpState.ids`). */
  setIds(next: string[]): void;
  /** L'ANALYSE — `store.cableRoute({…, waypoint_ids})` ou `store.bundleRoute({…})`. */
  analyze: RouteAnalyze;
  /** Résumé lisible d'une analyse (`store.cableRouteSummary`). */
  summary(analysis: RouteAnalysis): string;
  /** Libellé d'un conteneur (`store.containerLabel`) — `null` s'il n'y a rien à nommer. */
  containerLabel(container: PlacementContainer | null): string | null;
  anchorA(): RouteChainAnchor;
  anchorB(): RouteChainAnchor;
  /** TOUS les waypoints proposables du document (l'hôte fournit la liste, jamais le filtre). */
  candidates(): RouteChainCandidate[];
  /** Habillage d'une étape ; `null` pour un id qui ne résout aucun waypoint (ligne omise — parité
      avec l'ancien « Ordre des points », qui les sautait déjà silencieusement). */
  describe(waypointId: string): RouteChainStep | null;
  /** « Ce niveau de modale a changé ». INDISPENSABLE : la chaîne n'a AUCUN champ de saisie, donc
      l'instantané de `Modal` (qui ne lit que `input`/`select`/`textarea`) ne verrait RIEN bouger et
      laisserait fermer la modale sans confirmation — alors que l'ancien nuage de CASES À COCHER,
      lui, y était visible. C'est la régression que ce signal referme. */
  changed(): void;
}

/** Bandeau posé en dernier — sert à ne pas répéter deux fois le même conteneur d'affilée. */
type DerniereBande = { kind: "transit" } | { kind: "container"; container: PlacementContainer | null } | null;

export class RouteChainEditor {
  private readonly root: HTMLElement;
  /** État initial de l'automate : une route VIDE n'est jamais en transit (aucun exit ne l'a ouverte). */
  private static readonly ETAT_INITIAL: RouteInsertState = { transit: false, container: null, left: null };

  /** ⚠ NE SE PEINT PAS À LA CONSTRUCTION — l'hôte appelle `render()` quand il est prêt.
      Un formulaire construit ses CHAMPS de haut en bas puis, seulement ensuite, ses fonctions de
      synchronisation (`refresh`, `syncStatus`, les contraintes de conteneur…). Or les rappels de
      l'hôte s'appuient dessus : peindre dans le constructeur les invoquerait AVANT leur déclaration.
      Les formulaires appellent déjà `render()` dans leur ligne d'initialisation, avec les autres
      synchronisations — le composant s'y range au lieu d'imposer un ordre de construction. */
  constructor(private readonly host: RouteChainHost) {
    this.root = document.createElement("div");
  }

  /** L'élément à insérer dans le formulaire (contenu repeint par `render`). */
  get element(): HTMLElement { return this.root; }

  /** Repeint TOUT. Appelé à chaque mutation de route, et par l'hôte quand les ANCRES changent
      (choix d'un port, d'un équipement, d'un patch) — l'alerte d'ancre en dépend. */
  render(): void {
    const ids = this.host.ids();
    const analysis = this.host.analyze(ids);
    const reports = RouteEligibility.stepReports(ids, this.host.analyze);
    const anchorA = this.host.anchorA(), anchorB = this.host.anchorB();
    const reversed = RouteEligibility.isReversed(analysis);
    const mismatchA = RouteChainEditor.mismatch(analysis.containerA, analysis.startContainer);
    const mismatchB = RouteChainEditor.mismatch(analysis.containerB, analysis.endContainer);

    const box = document.createElement("div"); box.className = "rc";
    box.appendChild(this.anchorRow("a", anchorA, mismatchA, reversed ? "reversed" : (mismatchA ? "mismatch" : null), analysis));
    box.appendChild(this.stepsBox(ids, analysis, reports));
    // L'alerte du bout B ne se dédouble pas quand la route est simplement à l'envers : le message et
    // l'action vivent alors sur le bout A, une seule fois (maquette 6.7b).
    box.appendChild(this.anchorRow("b", anchorB, mismatchB, (!reversed && mismatchB) ? "mismatch" : null, analysis));
    box.appendChild(this.foot(ids, analysis, reports, anchorB, reversed));
    this.root.replaceChildren(box);
  }

  /** Deux conteneurs RENSEIGNÉS qui diffèrent : l'ancre n'est pas desservie par la route. Un terme
      absent n'est pas une incohérence — c'est une route (ou un bout) encore incomplet. */
  private static mismatch(anchor: PlacementContainer | null, route: PlacementContainer | null): boolean {
    return !!(anchor && route && !PlacementContainers.same(anchor, route));
  }

  /* ---------------------------------------------------------------- ancres -- */

  private anchorRow(
    side: "a" | "b",
    anchor: RouteChainAnchor,
    alert: boolean,
    message: "reversed" | "mismatch" | null,
    analysis: RouteAnalysis,
  ): HTMLElement {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "rc-anchor " + side + (alert ? " alert" : "");
    const tag = document.createElement("span"); tag.className = "rc-anchor-tag"; tag.textContent = anchor.tag;
    const name = document.createElement("span"); name.className = "rc-anchor-nm";
    name.textContent = anchor.label || I18n.t("cable.route.anchorEmpty");
    const spacer = document.createElement("span"); spacer.className = "rc-sp";
    const pill = document.createElement("span");
    pill.className = "pill rc-ctn-pill" + (alert ? " rc-alert" : "");
    pill.textContent = this.host.containerLabel(anchor.container) || I18n.t("cable.route.containerNone");
    row.append(tag, name, spacer, pill);
    wrap.appendChild(row);
    if (message) wrap.appendChild(this.anchorMessage(anchor, message, analysis));
    return wrap;
  }

  private anchorMessage(anchor: RouteChainAnchor, kind: "reversed" | "mismatch", analysis: RouteAnalysis): HTMLElement {
    const box = document.createElement("div"); box.className = "rc-anchor-msg";
    const start = this.host.containerLabel(analysis.startContainer) || I18n.t("cable.route.containerNone");
    const end = this.host.containerLabel(analysis.endContainer) || I18n.t("cable.route.containerNone");
    const text = document.createElement("span");
    if (kind === "reversed") {
      text.textContent = I18n.t("cable.route.reversed", { start, end });
      box.appendChild(text);
      // L'ACTION plutôt que le blocage : le moteur tolère déjà l'inversion au rendu (carton §4.4).
      // ⚠ On inverse LA ROUTE (l'ordre des étapes), PAS les bouts (décision utilisateur 2026-07-31) :
      // les bouts sont la vérité saisie — les permuter les fausserait et il faudrait reconstruire la
      // chaîne à la main. L'inverse d'une route valide est valide : la grammaire est SYMÉTRIQUE (les
      // tronçons se lisent dans les deux sens, exits et pins compris) — l'analyse re-jugera de toute
      // façon le résultat au repeint. `commit` = le point unique (setIds + « modifié » + rendu).
      const action = document.createElement("button");
      action.type = "button"; action.className = "btn btn-sm rc-swap";
      IconButton.decorate(action, Icons.SWAP);
      action.appendChild(document.createTextNode(I18n.t("cable.route.swapAction")));
      action.onclick = () => { this.commit(this.host.ids().slice().reverse()); };
      box.appendChild(action);
    } else {
      text.textContent = I18n.t("cable.route.anchorMismatch", {
        start, end, anchor: anchor.subject,
        name: this.host.containerLabel(anchor.container) || I18n.t("cable.route.containerNone"),
      });
      box.appendChild(text);
    }
    return box;
  }

  /* ---------------------------------------------------------------- étapes -- */

  private stepsBox(ids: string[], analysis: RouteAnalysis, reports: ReturnType<typeof RouteEligibility.stepReports>): HTMLElement {
    const box = document.createElement("div"); box.className = "rc-steps";
    // Lignes AFFICHABLES : un id qui ne résout aucun waypoint ne produit pas d'étape dans l'analyse,
    // il ne doit donc pas produire de ligne — sinon l'appariement ligne ⇄ étape (et donc le
    // rattachement des erreurs) se décalerait d'un cran.
    const rows = ids
      .map((id, index) => ({ id, index, step: this.host.describe(id) }))
      .filter((row): row is { id: string; index: number; step: RouteChainStep } => row.step != null);
    const count = Math.min(rows.length, analysis.steps.length, reports.length);

    if (!count) {
      const empty = document.createElement("div"); empty.className = "rc-empty";
      empty.textContent = I18n.t("cable.route.empty");
      box.appendChild(empty);
      box.appendChild(this.addRow(false));
      return box;
    }

    const list = document.createElement("div"); list.setAttribute("role", "list");
    let derniere: DerniereBande = null;
    for (let k = 0; k < count; k++) {
      const before = k === 0 ? RouteChainEditor.ETAT_INITIAL : reports[k - 1].after;
      const after = reports[k].after;
      /* BANDEAU. Un tronçon ouvert par un exit et REFERMÉ par l'étape suivante ne mérite pas de
         bandeau « Transit » (maquette 6.3, deux exits d'affilée) ; un tronçon qui reste ouvert AU-DELÀ
         de l'étape, si (maquette 6.6). D'où la lecture de l'état AVANT et APRÈS, que
         `RouteEligibility.stepReports` fournit — les seuls conteneurs d'étape ne le diraient pas. */
      if (before.transit && after.transit) derniere = this.pushTransitBand(list, derniere, before.left);
      else derniere = this.pushContainerBand(list, derniere, analysis.steps[k].container);
      const error = reports[k].error;
      list.appendChild(this.stepRow(rows, k, analysis.steps[k].container, error ? error.code : null));
      if (error) list.appendChild(RouteChainEditor.stepMessage(error.message, error.code === "unplaced"));
    }
    box.appendChild(list);

    // FIN DE ROUTE en transit : l'état devient VISIBLE (bandeau + bloc pointillé) au lieu d'être une
    // erreur découverte à l'enregistrement — c'est tout le propos de `exit_unpaired` (carton §4.3).
    const finale = reports[count - 1].after;
    if (finale.transit) {
      this.pushTransitBand(box, null, finale.left);
      const bloc = document.createElement("div"); bloc.className = "rc-transit";
      const fleche = document.createElement("span"); fleche.className = "rc-transit-ic"; fleche.setAttribute("aria-hidden", "true"); fleche.textContent = "⇢";
      const texte = document.createElement("span"); texte.className = "rc-transit-l"; texte.textContent = I18n.t("cable.route.transitHint");
      bloc.append(fleche, texte);
      box.appendChild(bloc);
    }
    box.appendChild(this.addRow(finale.transit));
    return box;
  }

  private pushTransitBand(parent: HTMLElement, derniere: DerniereBande, left: PlacementContainer | null): DerniereBande {
    if (derniere && derniere.kind === "transit") return derniere;
    const band = document.createElement("div"); band.className = "rc-band transit";
    const leftLabel = this.host.containerLabel(left);
    band.textContent = leftLabel ? I18n.t("cable.route.transitBandFrom", { name: leftLabel }) : I18n.t("cable.route.transitBand");
    parent.appendChild(band);
    return { kind: "transit" };
  }

  private pushContainerBand(parent: HTMLElement, derniere: DerniereBande, container: PlacementContainer | null): DerniereBande {
    if (derniere && derniere.kind === "container" && PlacementContainers.same(derniere.container, container)) return derniere;
    if (derniere && derniere.kind === "container" && !derniere.container && !container) return derniere;
    const band = document.createElement("div"); band.className = "rc-band";
    band.textContent = this.host.containerLabel(container) || I18n.t("cable.route.containerNone");
    parent.appendChild(band);
    return { kind: "container", container };
  }

  private stepRow(
    rows: Array<{ id: string; index: number; step: RouteChainStep }>,
    k: number,
    container: PlacementContainer | null,
    errorCode: string | null,
  ): HTMLElement {
    const row = rows[k];
    // Un waypoint NON POSÉ n'est pas une faute de grammaire mais un AVERTISSEMENT : il est ignoré au
    // tracé (maquette 6.9). D'où une étape ATTÉNUÉE plutôt qu'un liseré rouge.
    const ghosted = errorCode === "unplaced";
    const el = document.createElement("div");
    el.className = "rc-step" + (ghosted ? " ghosted" : (errorCode ? " err" : ""));
    el.setAttribute("role", "listitem");

    const num = document.createElement("span"); num.className = "pill rc-num"; num.textContent = String(k + 1);
    const glyph = document.createElement("span");
    glyph.className = "rc-glyph" + (row.step.glyph === "⏏" ? " exit" : (row.step.glyph === "◎" ? " pin" : ""));
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = row.step.glyph;
    const name = document.createElement("span"); name.className = "rc-nm"; name.textContent = row.step.name;
    const spacer = document.createElement("span"); spacer.className = "rc-sp";
    el.append(num, glyph, name, spacer);

    const containerLabel = this.host.containerLabel(container);
    if (containerLabel) { const c = document.createElement("span"); c.className = "rc-ctn"; c.textContent = containerLabel; el.appendChild(c); }
    if (ghosted) { const p = document.createElement("span"); p.className = "pill rc-warn"; p.textContent = I18n.t("cable.route.notPlacedPill"); el.appendChild(p); }

    const acts = document.createElement("span"); acts.className = "rc-acts";
    acts.appendChild(IconButton.build({
      icon: Icons.MOVE_UP, label: I18n.t("cable.route.moveEarlier"), disabled: k === 0,
      onClick: () => this.moveRow(rows, k, -1),
    }));
    acts.appendChild(IconButton.build({
      icon: Icons.MOVE_DOWN, label: I18n.t("cable.route.moveLater"), disabled: k === rows.length - 1,
      onClick: () => this.moveRow(rows, k, +1),
    }));
    acts.appendChild(IconButton.build({
      icon: Icons.CLOSE, label: I18n.t("cable.route.removeStep"), danger: true,
      onClick: () => this.removeRow(row.index),
    }));
    el.appendChild(acts);
    return el;
  }

  /** Message SOUS l'étape fautive (carton §4.3). Le libellé vient de la GRAMMAIRE (déjà traduit) :
      le reformuler ici en créerait une seconde version, vouée à diverger. */
  private static stepMessage(message: string, soft: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "rc-step-msg" + (soft ? " soft" : "");
    el.textContent = soft ? I18n.t("cable.route.notPlacedMsg") : message;
    return el;
  }

  /* -------------------------------------------------------------- mutation -- */

  /** Déplace une étape d'un cran, en visant la ligne VOISINE (et non l'index voisin) : entre deux
      lignes peuvent dormir des ids pendants, qu'un `±1` brut ferait « permuter » sans rien changer
      à l'écran. */
  private moveRow(rows: Array<{ id: string; index: number }>, k: number, direction: -1 | 1): void {
    const voisin = rows[k + direction];
    if (!voisin) return;
    const ids = this.host.ids().slice();
    const ici = rows[k].index;
    const la = voisin.index;
    const tmp = ids[ici]; ids[ici] = ids[la]; ids[la] = tmp;
    this.commit(ids);
  }

  private removeRow(index: number): void {
    const ids = this.host.ids().slice();
    ids.splice(index, 1);
    this.commit(ids);
  }

  /** Écrit le brouillon, SIGNALE la modification, repeint. Point de passage UNIQUE de toute mutation :
      oublier `changed()` sur une seule branche rouvrirait le trou de la garde « non enregistré ». */
  private commit(ids: string[]): void {
    this.host.setIds(ids);
    this.host.changed();
    this.render();
  }

  /* ------------------------------------------------------------ ajout (+) -- */

  /** Rangée « + Ajouter une étape… ». Le bouton cède la place au SÉLECTEUR À RECHERCHE de l'app
      (`SearchPop`, principe n°14) — jamais un nuage de cases. L'insertion se fait en FIN de route ;
      l'insertion AU MILIEU (le « + » entre deux étapes) et les GROUPES par conteneur dans le popover
      relèvent du lot L3. */
  private addRow(transit: boolean): HTMLElement {
    const row = document.createElement("div"); row.className = "rc-addrow";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost btn-sm rc-add" + (transit ? " warn" : "");
    IconButton.decorate(button, Icons.PLUS);
    // En transit, l'appel à l'action nomme ce qu'il reste à faire — la grammaire devient lisible
    // AVANT le refus, au lieu d'être découverte par un toast après coup (carton §2.3 mal n°4).
    button.appendChild(document.createTextNode(transit ? I18n.t("cable.route.closeSegment") : I18n.t("cable.route.addStep")));

    const pop = new SearchPop({
      placeholder: I18n.t("cable.route.searchPlaceholder"),
      minChars: 0,           // le contrôle doit se PARCOURIR sans taper (parité `entityPicker`)
      debounceMs: 0,         // source en mémoire : l'anti-rebond n'a rien à protéger
      fetch: (query) => Promise.resolve(this.results(query)),
      onPick: (result) => { this.commit(RouteEligibility.insertAt(this.host.ids(), String(result.id))); },
    });
    const picker = pop.element;
    picker.style.display = "none";

    button.onclick = () => {
      button.style.display = "none";
      picker.style.display = "";
      pop.focus();
    };
    // Sortie du champ SANS sélection : on rend la place au bouton. Différé, pour laisser passer le
    // `mousedown` d'un résultat (que `SearchPop` traite avant le blur, cf. son en-tête).
    picker.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (picker.contains(document.activeElement)) return;
        picker.style.display = "none";
        button.style.display = "";
      }, 180);
    });

    row.append(button, picker);
    return row;
  }

  /** Les résultats du popover pour une saisie : la liste PLATE de `RouteEligibility`, déjà ordonnée
      par PERTINENCE (① conteneur courant, ② conteneurs des bouts, ③ le reste, ④ la salle quittée),
      filtrée sur le texte. Les candidats IMPOSSIBLES restent VISIBLES et `disabled`, motif compris :
      « grisé ≠ caché », la règle s'apprend en lisant plutôt que par un toast de refus (maquette §04). */
  private results(query: string): SearchPopResult[] {
    const ids = this.host.ids();
    const plan = RouteEligibility.plan(this.host.candidates(), ids, this.host.analyze, {
      a: this.host.anchorA().container,
      b: this.host.anchorB().container,
    });
    const needle = String(query || "").trim().toLocaleLowerCase();
    const out: SearchPopResult[] = [];
    plan.flat.forEach((verdict) => {
      // `RouteEligibility` ne rend que le `RouteCandidate` qu'il a reçu — c'est-à-dire l'objet même
      // que `candidates()` a fourni, donc un `RouteChainCandidate` complet (glyphe et nom compris).
      const candidate = verdict.candidate as RouteChainCandidate;
      const containerLabel = this.host.containerLabel(candidate.container);
      let label = candidate.glyph + " " + candidate.name + (containerLabel ? " · " + containerLabel : "");
      if (!needle || label.toLocaleLowerCase().indexOf(needle) >= 0) {
        // Le motif est CONCATÉNÉ au libellé, et non posé à part : `SearchPop` recopie le libellé dans
        // le `title` de l'item — le motif est donc lisible en ligne ET au survol, sans toucher au
        // composant (les en-têtes de groupe et la ligne de motif dédiée sont le lot L3).
        if (!verdict.usable && verdict.reason) label += " — " + RouteChainEditor.reasonLabel(verdict.reason);
        out.push({ id: candidate.id, label, disabled: !verdict.usable, data: candidate });
      }
    });
    return out;
  }

  /** Motif de refus (CODE stable de `RouteEligibility`) → phrase traduite. La table est EXHAUSTIVE
      par construction : `RouteBlockCode` est une union fermée, `tsc` refuse un cas manquant. */
  private static reasonLabel(reason: RouteBlockCode): string {
    return I18n.t(RouteChainEditor.REASON_KEYS[reason]);
  }
  private static readonly REASON_KEYS: Record<RouteBlockCode, string> = {
    already_in_route: "cable.route.reasonAlreadyInRoute",
    unplaced: "cable.route.reasonUnplaced",
    floor_pin_in_room: "cable.route.reasonFloorPinInRoom",
    in_transit: "cable.route.reasonInTransit",
    room_wp_on_floor: "cable.route.reasonRoomWpOnFloor",
    wrong_room: "cable.route.reasonWrongRoom",
    exit_wrong_room: "cable.route.reasonExitWrongRoom",
    exit_reentry: "cable.route.reasonExitReentry",
    breaks_route: "cable.route.reasonBreaksRoute",
    invalid_here: "cable.route.reasonInvalidHere",
  };

  /* ------------------------------------------------------------------ pied -- */

  /** SYNTHÈSE : une pastille d'état + une phrase. Le détail, lui, vit sur les étapes — le pied ne
      répète pas ce que la chaîne montre déjà. */
  private foot(
    ids: string[],
    analysis: RouteAnalysis,
    reports: ReturnType<typeof RouteEligibility.stepReports>,
    anchorB: RouteChainAnchor,
    reversed: boolean,
  ): HTMLElement {
    const foot = document.createElement("div"); foot.className = "rc-foot";
    const badge = document.createElement("span"); badge.className = "pill rc-badge";
    const text = document.createElement("span"); text.className = "rc-sum";

    // `exit_unpaired` n'est plus compté comme un PROBLÈME : c'est l'état « transit », désormais
    // VISIBLE dans la chaîne (bandeau pointillé). Le compter ferait dire « 1 problème » à une route
    // simplement en cours de saisie.
    const problems = analysis.errors.filter((e) => e.code !== "exit_unpaired");
    const hard = problems.filter((e) => e.code !== "unplaced");
    const transit = reports.length ? reports[reports.length - 1].after.transit : false;

    if (reversed) {
      badge.classList.add("warn"); badge.textContent = I18n.t("cable.route.sensToConfirm");
      text.textContent = I18n.t("cable.route.reversedFoot");
    } else if (hard.length) {
      badge.classList.add("err"); badge.textContent = I18n.t("cable.route.problems", { n: hard.length });
      text.textContent = this.firstProblemText(hard[0].message, reports);
    } else if (problems.length) {
      badge.classList.add("warn"); badge.textContent = I18n.t("cable.route.warnings", { n: problems.length });
      text.textContent = this.firstProblemText(problems[0].message, reports);
    } else if (transit) {
      badge.classList.add("warn"); badge.textContent = I18n.t("cable.route.transitOpen");
      const gap = RouteEligibility.endGap(analysis, anchorB.container);
      const gapLabel = gap ? this.host.containerLabel(gap) : null;
      text.textContent = gapLabel
        ? I18n.t("cable.route.suggestMissingExit", { name: gapLabel, anchor: anchorB.subject })
        : I18n.t("cable.route.transitHint");
    } else {
      badge.classList.add("ok"); badge.textContent = I18n.t("cable.route.valid");
      text.textContent = ids.length ? this.host.summary(analysis) : I18n.t("cable.route.directHint");
    }
    foot.append(badge, text);
    return foot;
  }

  /** « Étape N — <message> » quand le problème se rattache à une étape ; le message nu sinon (les
      erreurs d'ANCRE, elles, sont déjà affichées sur l'ancre). */
  private firstProblemText(message: string, reports: ReturnType<typeof RouteEligibility.stepReports>): string {
    const index = reports.findIndex((report) => report.error != null && report.error.message === message);
    return index >= 0 ? I18n.t("cable.route.stepPrefix", { n: index + 1, message }) : message;
  }
}
