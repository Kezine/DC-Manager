import { Notify } from "./Notify";
import { Icons } from "./Icons";
import { Dialog } from "./Dialog";
import { Fullscreen } from "./Fullscreen";
import { OverlayA11y } from "./OverlayA11y";
import { ModalStack, type ModalKind, type ModalStackEntry } from "../core/ModalStack";
import { I18n } from "../i18n/I18n";

export interface ModalOptions {
  title?: string;
  subtitle?: string;
  body: HTMLElement;
  onSave?: () => any | Promise<any>;
  onCancel?: () => void;
  /** Rappelé quand CE NIVEAU DISPARAÎT, quelle qu'en soit la cause (annulation, ← Retour, croix,
      clic hors-modale, OU enregistrement réussi) — contrairement à `onCancel` (annulation seule).
      Signal GÉNÉRIQUE de « ce niveau n'est plus là », utile pour libérer une ressource attachée à
      lui (ex. `clearWeakPassphraseGuard` de la page Certificats).
      ⚠ Ce n'est PLUS le mécanisme des ALLERS-RETOURS entre modales : depuis que `Modal` est une
      PILE, revenir en arrière est STRUCTUREL (le niveau du dessous est conservé vivant et réaffiché
      au pop). Un `onClose` qui rouvrirait la modale d'origine irait désormais CONTRE le geste — un
      ✕ demande de fermer la file, pas de la reconstruire. Pour se rafraîchir au retour, un niveau
      déclare `onResume` (ci-dessous), pas un `onClose` chez son voisin. */
  onClose?: () => void;
  /** Rappelé quand ce niveau REVIENT AU PREMIER PLAN (le niveau ouvert par-dessus vient d'être
      dépilé). Point d'inversion de dépendance (décision D7) : ce n'est plus la modale ouverte qui
      doit savoir comment rouvrir celle du dessous — c'est CHAQUE niveau qui déclare, à sa propre
      ouverture, comment se remettre à jour.
      USAGE TYPE (les FICHES) : `onResume: () => this.equipmentDetail(...)` — la fiche se
      RECONSTRUIT depuis le store, donc avec les données fraîches que la modale du dessus vient
      d'écrire. Pendant l'exécution du rappel, le prochain `open()` REMPLACE ce niveau au lieu d'en
      empiler un de plus (sinon chaque retour ajouterait un étage).
      LES FORMULAIRES N'EN FOURNISSENT PAS : leur DOM est conservé tel quel, donc la SAISIE en
      cours survit — c'est le défaut sain, on ne perd jamais de frappe par omission. */
  onResume?: () => void;
  hideFooter?: boolean;
  saveLabel?: string;
  confirmClose?: boolean;
  wide?: boolean;
  /** Rappelé À LA FIN d'`open` (après le focus initial), avec le bouton « Enregistrer » de la modale.
      Point d'accroche pour PILOTER ce bouton depuis l'appelant (ex. temporiser sa ré-activation via
      `CountdownButton`). Le libellé et l'état `disabled` du bouton sont DÉJÀ posés par `open` quand
      `onReady` s'exécute → capturer la base APRÈS ce rappel. Additif, aucun impact sur l'existant. */
  onReady?: (ctx: { saveButton: HTMLButtonElement }) => void;
}

/** Un NIVEAU vivant de la pile : sa nature et son libellé (contrat de `ModalStack`) + tout l'état
    qu'il faut lui rendre quand il revient au premier plan. Le `bodyEl` est le corps FOURNI par
    l'appelant : il est DÉTACHÉ de la modale (jamais détruit) le temps qu'un niveau soit au-dessus,
    ce qui préserve intégralement la saisie en cours et les écouteurs déjà posés dessus. */
interface ModalLevel extends ModalStackEntry {
  kind: ModalKind;
  /** Libellé AFFICHABLE du niveau (« Titre — sous-titre ») : toast D9 et info-bulle du ← Retour. */
  title: string;
  titleText: string;
  subtitleHtml: string;
  bodyEl: HTMLElement;
  hideFooter: boolean;
  wide: boolean;
  saveLabel: string;
  /** Faut-il confirmer avant d'abandonner ce niveau ? (défaut : oui dès qu'il y a un `onSave`.) */
  confirmClose: boolean;
  /** Modification NON-SAISIE signalée à la main (ajout de port, glisser un marqueur…). */
  dirty: boolean;
  /** Instantané des champs du corps À L'OUVERTURE — comparé au corps COURANT pour détecter une saisie. */
  snapshot: string;
  onSave: (() => any | Promise<any>) | null;
  onCancel: (() => void) | null;
  onClose: (() => void) | null;
  onResume: (() => void) | null;
  /** Élément qui avait le focus au moment où ce niveau a été recouvert — rendu au retour. */
  focusAtPush: HTMLElement | null;
}

/* =============================================================================
   MODALE de l'application — une PILE de niveaux dans UN SEUL overlay.

   MODÈLE (refonte du 2026-07-30, cf. `.notes/toDos/pile-de-modales-cadrage-2026-07-30.md`).
   Ouvrir une modale alors qu'une autre est affichée EMPILE : le niveau courant
   n'est pas détruit, son corps est simplement DÉTACHÉ et gardé vivant, avec son
   titre, son pied, son instantané de saisie et ses rappels. Revenir DÉPILE.
   Auparavant l'overlay swappait son contenu et les allers-retours étaient émulés
   par un `onClose` qui RECONSTRUISAIT la modale d'origine — d'où deux défauts
   qui n'existent plus : impossible de tout fermer d'un coup (✕ faisait « retour »),
   et toute saisie non enregistrée du niveau quitté était perdue par construction.

   LES GESTES, et ce qu'ils font :
     - Enregistrer (succès) ........ POP silencieux (pas de confirmation)
     - Annuler / ← Retour / Retour arrière (Backspace) ... POP, garde « modifié »
       DU NIVEAU (le dialogue de confirmation habituel si le formulaire a changé)
     - ✕ / Échap / clic hors modale ... FERMETURE TOTALE de la file, sous garde D9a
     - pile vidée .................. fermeture réelle (verrou de défilement rendu,
       focus restitué au déclencheur INITIAL)
   À profondeur 1, ← ≡ Annuler ≡ ✕ : « revenir » et « fermer » coïncident.

   LES DEUX GARDES (D9), portées par le module PUR `core/ModalStack` :
     - D9b : pousser une ÉDITION alors qu'une édition vit déjà dans la pile est
       REFUSÉ (toast « Vous éditez … »). Invariant : au plus UNE saisie vivante,
       donc un seul point d'arrêt et un message jamais ambigu ;
     - D9a : une fermeture TOTALE qui rencontrerait une édition ENFOUIE sous des
       fiches ne la détruit pas — elle dépile les fiches et la REND à l'écran
       (toast). L'utilisateur tranche alors explicitement. Une édition AU SOMMET,
       elle, est visible : on ferme, garde « modifié » comprise.
   Corollaire ASSUMÉ : la fermeture totale ne pose JAMAIS de confirmation globale
   « N formulaires seront perdus » — les niveaux qu'elle détruit réellement sont
   des fiches (rien à perdre), et le seul formulaire possible est celui du sommet,
   déjà couvert par le garde-fou par niveau.

   FRAÎCHEUR AU RETOUR (D4) : le DOM conservé peut être PÉRIMÉ (une fiche maître
   dont on vient d'éditer un sous-équipement). Chaque niveau déclare donc, à SON
   ouverture, comment se remettre à jour : `onResume` (cf. ModalOptions). Les
   fiches en fournissent un (reconstruction depuis le store) ; les formulaires
   non — leur saisie doit survivre.

   ACCESSIBILITÉ (socle partagé avec Dialog, cf. ui/OverlayA11y) :
     - la boîte porte `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
       vers l'ID du titre ; les boutons ← et ✕ ont un `aria-label` localisé ;
     - le verrou de défilement et la mémorisation du DÉCLENCHEUR sont pris UNE
       fois (à la 1re ouverture) et rendus UNE fois (à la fermeture réelle) —
       l'empilement n'y touche pas ;
     - chaque niveau mémorise en plus l'élément focalisé au moment où il a été
       recouvert (`focusAtPush`) et le retrouve au retour : la restitution de
       focus est donc à DEUX étages, intermédiaire et final ;
     - Tab / Maj+Tab bouclent DANS la modale (piège de focus) ; Échap ferme la
       file. Tout le clavier est SUSPENDU tant qu'un `Dialog` est ouvert
       par-dessus (z-index supérieur) : c'est lui qui capte alors les touches.
   ============================================================================= */
export class Modal {
  /** Mode visualiseur : bloque les modales d'ÉDITION (laisse passer les fiches hideFooter). */
  editLocked = false;

  private overlay!: HTMLElement;
  private elTitle!: HTMLElement;
  private elSubtitle!: HTMLElement;
  private elBody!: HTMLElement;
  private elFooter!: HTMLElement;
  private elBox!: HTMLElement;
  private btnSave!: HTMLButtonElement;
  private btnBack!: HTMLButtonElement;
  /** LA pile : politique dans `core/ModalStack` (pure, testée), état DOM ici. */
  private readonly stack = new ModalStack<ModalLevel>();
  /** Verrou de défilement pris + déclencheur mémorisé ? (armé à la 1re ouverture, rendu à la dernière.) */
  private a11yArmed = false;
  /** Élément ayant le focus AVANT la 1re ouverture — restitué à la fermeture réelle. */
  private restoreFocus: HTMLElement | null = null;
  /** Un `onResume` est en cours : le prochain `open()` REMPLACE le niveau au lieu d'en empiler un. */
  private resuming = false;

  constructor() { this._build(); }

  private _build(): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <div class="modal-header-left"><div class="modal-titles">
            <div class="modal-title"></div><div class="modal-subtitle"></div>
          </div></div>
          <div class="modal-header-actions">
            <button type="button" class="modal-back" aria-label="${I18n.t("ui.action.back")}">${Icons.BACK}</button>
            <button type="button" class="modal-close" aria-label="${I18n.t("ui.action.close")}">${Icons.CLOSE}</button>
          </div>
        </div>
        <div class="modal-body"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost modal-cancel">${I18n.t("ui.action.cancel")}</button>
          <button type="button" class="btn btn-primary modal-save">${I18n.t("ui.action.save")}</button>
        </div>
      </div>`;
    Fullscreen.host().appendChild(overlay);   // plein écran : dans l'élément FS courant (sinon <body>)
    this.overlay = overlay;
    this.elBox = overlay.querySelector(".modal") as HTMLElement;
    this.elTitle = overlay.querySelector(".modal-title") as HTMLElement;
    this.elSubtitle = overlay.querySelector(".modal-subtitle") as HTMLElement;
    this.elBody = overlay.querySelector(".modal-body") as HTMLElement;
    this.elFooter = overlay.querySelector(".modal-footer") as HTMLElement;
    this.btnSave = overlay.querySelector(".modal-save") as HTMLButtonElement;
    this.btnBack = overlay.querySelector(".modal-back") as HTMLButtonElement;
    // Rôles ARIA : boîte = dialogue modal, nommée par son titre (ID stable généré une fois).
    const titleId = OverlayA11y.nextId("dcm-modal-title");
    this.elTitle.id = titleId;
    this.elBox.setAttribute("role", "dialog");
    this.elBox.setAttribute("aria-modal", "true");
    this.elBox.setAttribute("aria-labelledby", titleId);
    // ← Retour et Annuler sont le MÊME geste (dépiler d'un cran) ; ✕ et le clic hors modale sont
    // l'AUTRE (vider la file). Le bouton ← est présent dans TOUTES les modales, par uniformité
    // (décision D2) : une fiche n'a pas de pied, donc pas d'« Annuler » — sans lui, elle n'offrirait
    // aucun retour visible.
    this.btnBack.onclick = () => { void this.requestPop(); };
    (overlay.querySelector(".modal-cancel") as HTMLElement).onclick = () => { void this.requestPop(); };
    (overlay.querySelector(".modal-close") as HTMLElement).onclick = () => { void this.requestCloseAll(); };
    let down = false;
    overlay.addEventListener("mousedown", (e) => { down = (e.button === 0 && e.target === overlay); });
    overlay.addEventListener("mouseup", (e) => { if (down && e.button === 0 && e.target === overlay) void this.requestCloseAll(); down = false; });
    // Clavier (capture, niveau document). Suspendu si un DIALOGUE est ouvert par-dessus (z-index
    // supérieur) → c'est lui, plus haut dans la pile, qui capte alors les touches (son propre
    // gestionnaire, cf. Dialog). Garde donc l'aller-retour intact.
    document.addEventListener("keydown", (e) => {
      if (!this.a11yArmed || Dialog.isOpen()) return;
      if (e.key === "Escape") { e.preventDefault(); void this.requestCloseAll(); }
      else if (e.key === "Tab") OverlayA11y.trapTab(this.elBox, e);
      else if (e.key === "Backspace" && Modal._backspacePops(e.target)) { e.preventDefault(); void this.requestPop(); }
    }, true);
  }

  /** RETOUR ARRIÈRE (Backspace) = équivalent clavier du bouton ← (décision D8).
      ⚠ MAPPING EN TEST : ce choix de touche est explicitement provisoire. En cas d'audit général
      d'optimisation de l'interface, C'EST UN POINT À REVOIR — Backspace est la touche d'EFFACEMENT
      de texte, et son détournement ne tient que par la garde ci-dessous.
      La garde : on n'intercepte JAMAIS quand la SAISIE a le focus (`input`/`textarea`/`select`/
      contenu éditable) — sinon la frappe serait détruite au lieu de reculer d'un caractère, et les
      fiches elles-mêmes contiennent des champs de recherche. Le `preventDefault` de l'appelant
      complète la garde : Chrome moderne n'y câble plus l'historique, mais Firefox peut encore le
      faire selon sa configuration — on ne parie pas là-dessus. */
  private static _backspacePops(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return true;   // cible non élémentaire (document) → aucune saisie en jeu
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return false;
    return !el.isContentEditable;
  }

  /** Signale une modification NON-SAISIE (ajout de port, glisser un marqueur…) sur le niveau COURANT. */
  markDirty(): void { const level = this.stack.top(); if (level) level.dirty = true; }

  /** Instantané des champs d'un corps DONNÉ (et non du corps affiché) : un niveau enfoui doit rester
      comparable à son instantané alors que sa DOM est détachée de l'overlay. */
  private static _snapshotOf(body: HTMLElement): string {
    const parts: string[] = [];
    body.querySelectorAll("input, select, textarea").forEach((el: any, i) => {
      if (el.hasAttribute("data-nosnap")) return;
      const v = (el.type === "checkbox" || el.type === "radio") ? (el.checked ? "1" : "0") : (el.value != null ? String(el.value) : "");
      parts.push(i + ":" + v);
    });
    return parts.join("");
  }

  /** Ce niveau a-t-il des modifications à protéger ? (drapeau manuel OU champs différents de l'instantané) */
  private static _isDirty(level: ModalLevel): boolean {
    return level.dirty || Modal._snapshotOf(level.bodyEl) !== level.snapshot;
  }

  /** Libellé affichable d'un niveau : « Titre — sous-titre » quand le sous-titre porte du TEXTE
      (il nomme l'objet : « Équipement — sw-01 »), le titre seul sinon. C'est ce libellé que voient
      le toast « Vous éditez … » et l'info-bulle du ← Retour — les deux doivent nommer la même chose. */
  private static _label(titleText: string, subtitleText: string): string {
    const t = (titleText || "").trim() || "—";
    const s = (subtitleText || "").trim();
    return s ? (t + " — " + s) : t;
  }

  /** Peint un niveau dans l'overlay : titres, corps (RÉ-ATTACHÉ, jamais recréé), pied, bouton
      d'enregistrement, info-bulle du ← Retour. Ne touche NI au focus NI à la pile. */
  private _show(level: ModalLevel): void {
    this.elTitle.textContent = level.titleText || "—";
    this.elSubtitle.innerHTML = level.subtitleHtml;
    this.elBody.replaceChildren(level.bodyEl);   // détache le corps du niveau précédent SANS le détruire
    this.elFooter.style.display = level.hideFooter ? "none" : "flex";
    this.elBox.classList.toggle("wide", level.wide);
    this.btnSave.textContent = level.saveLabel;
    this.btnSave.disabled = false;
    this.btnSave.onclick = async () => {
      if (this.btnSave.disabled) return;
      this.btnSave.disabled = true;
      try {
        // Enregistrement RÉUSSI (l'appelant n'a pas rendu `false`) → on dépile SANS confirmation :
        // il n'y a plus rien à perdre, la saisie vient d'être écrite.
        if (level.onSave) { const ok = await level.onSave(); if (ok !== false) this.closeQuiet(); }
        else this.closeQuiet();
      } catch (e: any) { console.error(e); Notify.toast(I18n.t("ui.modal.errorPrefix", { message: e.message }), "err"); }
      finally { this.btnSave.disabled = false; }
    };
    // Info-bulle DYNAMIQUE du ← : le libellé du niveau où l'on retourne (mini fil d'Ariane gratuit),
    // ou « Annuler » à profondeur 1, où revenir revient à fermer.
    const previous = this.stack.at(this.stack.depth() - 2);
    this.btnBack.title = previous ? previous.title : I18n.t("ui.action.cancel");
  }

  open(opts: ModalOptions): void {
    const { title, subtitle, body, onSave, onCancel, onClose, onResume, hideFooter, saveLabel, confirmClose, wide, onReady } = opts;
    if (this.editLocked && !hideFooter) return;   // viewer : bloque l'édition
    // Un `open` déclenché PENDANT le `onResume` d'un niveau le REMPLACE (il se reconstruit sur
    // place) au lieu d'en empiler un de plus. Le drapeau est CONSOMMÉ ici : un second `open` dans le
    // même rappel empilerait normalement (cas dégénéré, mais jamais corrompu).
    const replacing = this.resuming;
    this.resuming = false;

    // Nature du niveau : porter un `onSave`, c'est porter une SAISIE (règles D9). Une fiche
    // (`hideFooter`, lecture seule) est un `info`.
    const kind: ModalKind = (typeof onSave === "function") ? "edit" : "info";
    if (!replacing && this.stack.depth() > 0) {
      // D9b — REFUS d'une édition sur une édition vivante. On ne touche à RIEN : la pile reste telle
      // quelle, l'utilisateur reste où il est, et le toast lui dit ce qu'il doit finir ou annuler.
      const verdict = this.stack.pushAllowed(kind);
      if (!verdict.ok) { Notify.toast(I18n.t("ui.modal.editingToast", { title: verdict.editingTitle })); return; }
    }

    if (!this.a11yArmed) {
      // 1re ouverture : mémoriser le déclencheur pour lui rendre le focus à la fermeture RÉELLE, et
      // prendre le verrou de défilement. Un empilement ne re-capture NI ne re-verrouille.
      this.restoreFocus = (document.activeElement as HTMLElement) || null;
      OverlayA11y.lockScroll();
      this.a11yArmed = true;
    }

    if (replacing) this.stack.pop();                                   // remplacement : le niveau n'a pas DISPARU, aucun rappel à jouer
    else { const covered = this.stack.top(); if (covered) covered.focusAtPush = (document.activeElement as HTMLElement) || null; }

    const level: ModalLevel = {
      kind, title: "", titleText: title || "—", subtitleHtml: subtitle || "",
      bodyEl: body,
      hideFooter: !!hideFooter, wide: !!wide, saveLabel: saveLabel || I18n.t("ui.action.save"),
      confirmClose: (typeof confirmClose === "boolean") ? confirmClose : (typeof onSave === "function"),
      dirty: false, snapshot: Modal._snapshotOf(body),
      onSave: (typeof onSave === "function") ? onSave : null,
      onCancel: (typeof onCancel === "function") ? onCancel : null,
      onClose: (typeof onClose === "function") ? onClose : null,
      onResume: (typeof onResume === "function") ? onResume : null,
      focusAtPush: null,
    };
    this.stack.push(level);
    this._show(level);
    // Libellé LU dans la DOM : le sous-titre est du HTML fourni par l'appelant, seul son TEXTE nomme
    // l'objet. On le prend une fois posé, plutôt que de re-parser la chaîne dans un coin.
    level.title = Modal._label(this.elTitle.textContent || "", this.elSubtitle.textContent || "");

    this.overlay.classList.add("open");
    // Focus DANS la modale (1er champ d'un formulaire, sinon 1er focusable). Les formulaires qui
    // ciblent un champ précis via un setTimeout raffinent ensuite ce focus — sans conflit.
    OverlayA11y.focusInitial(this.elBox);
    // Accroche APRÈS coup (bouton « Enregistrer » prêt : libellé + état posés ci-dessus) — cf. ModalOptions.onReady.
    if (typeof onReady === "function") onReady({ saveButton: this.btnSave });
  }

  /** Neutralise l'état a11y à la fermeture RÉELLE (verrou de défilement + restitution du focus au
      déclencheur initial). Appelé AVANT les rappels de fermeture : un rappel qui rouvrirait une
      modale re-capture alors le déclencheur RESTITUÉ — le focus revient in fine dessus. */
  private _teardownA11y(): void {
    if (!this.a11yArmed) return;
    this.a11yArmed = false;
    OverlayA11y.unlockScroll();
    const el = this.restoreFocus; this.restoreFocus = null;
    if (el && typeof el.focus === "function" && document.contains(el)) { try { el.focus(); } catch (_) { /* sans effet */ } }
  }

  private static _invoke(cb: (() => void) | null): void {
    if (cb) { try { cb(); } catch (e) { console.warn(e); } }
  }

  /** Détruit le niveau du SOMMET sans rien réafficher (usage : fermeture totale, où l'on démonte
      plusieurs étages d'affilée). Les rappels sont CAPTURÉS puis NEUTRALISÉS avant invocation : un
      rappel qui rouvrirait une modale ne doit pas se re-déclencher sur la nouvelle ouverture. */
  private _discardTop(cancelled: boolean): void {
    const level = this.stack.pop();
    if (!level) return;
    const cancel = cancelled ? level.onCancel : null;
    const closed = level.onClose;
    level.onCancel = null; level.onClose = null; level.onResume = null;
    Modal._invoke(cancel);
    Modal._invoke(closed);
  }

  /** Réaffiche le niveau redevenu sommet : sa DOM (donc sa saisie) telle qu'elle était, son focus,
      puis son `onResume` s'il en a déclaré un. */
  private _restoreTop(): void {
    const level = this.stack.top();
    if (!level) return;
    this._show(level);
    const el = level.focusAtPush; level.focusAtPush = null;
    if (el && typeof el.focus === "function" && document.contains(el)) { try { el.focus(); } catch (_) { OverlayA11y.focusInitial(this.elBox); } }
    else OverlayA11y.focusInitial(this.elBox);
    // Rafraîchissement DÉCLARÉ PAR LE NIVEAU LUI-MÊME (D4/D7) : il se reconstruit avec les données
    // que la modale du dessus vient éventuellement d'écrire. Sans `onResume`, la DOM restaurée reste
    // telle quelle — défaut sain (on ne perd jamais de saisie par omission).
    this._resume(level);
  }

  /** Rejoue l'`onResume` d'un niveau, en armant le drapeau qui fait REMPLACER (et non empiler) le
      prochain `open`. Sans ce drapeau, une fiche qui se reconstruit ajouterait un étage à chaque
      rafraîchissement. */
  private _resume(level: ModalLevel): void {
    const resume = level.onResume;
    if (!resume) return;
    this.resuming = true;
    try { resume(); } catch (e) { console.warn(e); }
    finally { this.resuming = false; }
  }

  /** Redemande au niveau COURANT de se remettre à jour, SANS rien dépiler : il rejoue son `onResume`
      et se reconstruit EN PLACE. Sert aux mutations déclenchées DEPUIS une fiche mais qui ne passent
      pas par un niveau de pile — un `Dialog` empilé par-dessus (éditeur de façade), une suppression
      de ligne, un rattachement d'adresse : le contenu affiché devient faux alors que rien n'a été
      dépilé. Avant la pile, ces sites se ré-ouvraient eux-mêmes (l'ouverture SWAPPAIT le contenu) ;
      désormais une ré-ouverture EMPILERAIT — d'où ce chemin explicite.
      Sans effet si le niveau n'a pas déclaré d'`onResume` (rien à reconstruire). */
  refresh(): void {
    const level = this.stack.top();
    if (level) this._resume(level);
  }

  /** Dépile UN niveau : le détruit, puis réaffiche celui du dessous (ou ferme pour de bon si c'était
      le dernier). L'ordre — réafficher AVANT d'invoquer les rappels du niveau quitté — est le même
      qu'avant la refonte : il garantit que le verrou de défilement et le focus sont déjà rendus
      quand un rappel s'exécute. */
  private _pop(cancelled: boolean): void {
    const level = this.stack.pop();
    if (!level) return;
    const cancel = cancelled ? level.onCancel : null;
    const closed = level.onClose;
    level.onCancel = null; level.onClose = null; level.onResume = null;
    if (this.stack.depth() === 0) { this.overlay.classList.remove("open"); this._teardownA11y(); }
    else this._restoreTop();
    Modal._invoke(cancel);
    Modal._invoke(closed);
  }

  /** Ferme le niveau COURANT (POP) en jouant son annulation — chemin d'`host.closeModal`. */
  close(): void { this._pop(true); }

  /** Ferme le niveau COURANT (POP) SANS jouer son annulation — chemin de l'enregistrement réussi. */
  closeQuiet(): void { this._pop(false); }

  /** Vide TOUTE la file, sans garde ni confirmation. Réservé aux gestes qui QUITTENT les modales
      pour de bon (ex. « Localiser » : on bascule sur la vue 3D — laisser un étage ouvert masquerait
      la scène qu'on vient d'aller voir). Les gestes d'interface passent, eux, par `requestCloseAll`. */
  closeAll(): void {
    if (this.stack.depth() === 0) return;
    this.overlay.classList.remove("open");
    this._teardownA11y();
    while (this.stack.depth() > 0) this._discardTop(true);
  }

  /** Geste « revenir » (Annuler, ← Retour, Retour arrière) : garde « modifications non enregistrées »
      DU NIVEAU COURANT, puis dépile d'un cran. */
  async requestPop(): Promise<void> {
    const level = this.stack.top();
    if (!level) return;
    if (level.confirmClose && Modal._isDirty(level)) {
      const ok = await Dialog.confirm({
        title: I18n.t("ui.modal.confirmCloseTitle"),
        message: I18n.t("ui.modal.confirmCloseMessage"),
        confirmLabel: I18n.t("ui.modal.confirmCloseConfirm"), cancelLabel: I18n.t("ui.modal.confirmCloseCancel"), danger: true,
      });
      if (!ok) return;
    }
    this._pop(true);
  }

  /** Geste « je quitte » (✕, Échap, clic hors modale) : vide la file — sauf si une ÉDITION est
      ENFOUIE sous des fiches (garde D9a), auquel cas on s'arrête dessus et on la signale. */
  async requestCloseAll(): Promise<void> {
    const target = this.stack.closeAllTarget();
    if (target.action === "popTo") {
      // Les niveaux au-dessus sont des FICHES : rien à confirmer, rien à perdre. On les démonte
      // (leurs `onClose` jouent), on rend l'édition à l'écran, et on dit pourquoi la file est restée.
      while (this.stack.depth() > target.index + 1) this._discardTop(true);
      this._restoreTop();
      Notify.toast(I18n.t("ui.modal.editingToast", { title: target.editingTitle }));
      return;
    }
    const top = this.stack.top();
    if (!top) return;
    // Seul le SOMMET peut être un formulaire modifié (invariant D9b) → une seule garde suffit, celle
    // qui existait déjà. Pas de « confirmation globale » : il n'y a jamais N formulaires à perdre.
    if (top.confirmClose && Modal._isDirty(top)) {
      const ok = await Dialog.confirm({
        title: I18n.t("ui.modal.confirmCloseTitle"),
        message: I18n.t("ui.modal.confirmCloseMessage"),
        confirmLabel: I18n.t("ui.modal.confirmCloseConfirm"), cancelLabel: I18n.t("ui.modal.confirmCloseCancel"), danger: true,
      });
      if (!ok) return;
    }
    this.closeAll();
  }
}
