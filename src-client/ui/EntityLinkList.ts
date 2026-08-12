import { SearchPop } from "./SearchPop";
import type { SearchPopResult } from "./SearchPop";
import { IconButton } from "./IconButton";
import { Icons } from "./Icons";
import { Notify } from "./Notify";
import { TargetSearch } from "../core/TargetSearch";

/* =============================================================================
   EntityLinkList — LISTE ÉDITABLE de liens d'entité MULTI-valeur, à champ de
   recherche unifié. C'est le pendant MULTI d'`EntityPicker` (mono-valeur par
   construction) : là où le picker porte UNE valeur, celui-ci en porte PLUSIEURS,
   dans un ORDRE qui compte.

   POURQUOI (principe n°14, retour utilisateur « le design des pièces jointes /
   applications est mieux ») : la seule surface multi-valeur de liaison d'entité
   de l'app (l'éditeur de liens des interventions) était un assemblage AD HOC —
   un `SearchPop` nu + une liste de rangées câblés à la main DANS la vue. On
   applique ici l'idiome déjà éprouvé du mono-valeur : un CHAMP DE RECHERCHE
   unifié qui balaye toutes les familles à la fois, le CLIC ajoute ; en dessous,
   la liste ordonnée des liens, chaque rangée retirable par un bouton-icône.

   COMPOSITION, PAS MODE (comme `EntityPicker`) : `SearchPop` reste le composant
   de RECHERCHE (champ + popover) ; ce module porte la VALEUR (la liste) et tout
   ce qui en découle — rendu des rangées, dédup, retrait, état vide, orphelins.

   GÉNÉRICITÉ (principe n°2) — le composant ne connaît NI le Store, NI les
   interventions : tout ce qui est métier est INJECTÉ par les options. La source
   de candidats (`search`), la résolution de libellé (`labelOf`), le libellé et
   l'icône de famille (`kindLabel`/`kindIcon`) et TOUS les textes (`labels`)
   viennent de l'appelant. Ce module se réutilise donc pour n'importe quelle
   liaison multi-valeur, pas seulement les cibles d'intervention.

   LA LISTE EST LA VALEUR : `value` initialise, `onChange(value)` notifie une
   COPIE à chaque mutation (ajout / retrait). L'ORDRE = la position (le
   consommateur des interventions remplace intégralement la liste à
   l'enregistrement, donc l'ordre affiché est celui qui sera persisté).

   ENCODAGE COMPOSITE : toute clé « famille+id » passe par `TargetSearch.key`
   (convention UNIQUE de l'app) — jamais de concaténation `kind + ":" + id` à la
   main, ni pour la dédup (`excludedKeys` passé à `search`) ni pour l'id de
   résultat du popover.

   POPOVER EN PORTAIL (toujours) : ce composant vit dans le corps DÉFILANT d'une
   modale (`.modal-body`, `overflow-y:auto`) ; le `SearchPop` est monté en
   `portal: true` pour que sa liste échappe à l'overflow de l'ancêtre au lieu
   d'y être coupée (acquis du lot 1 « popovers en portail »).

   AUCUNE CSS NOUVELLE : l'état vide et les rangées réutilisent `.form-hint`
   (invite italique), la classe `gi` (icône de famille), `var(--fg-dimmer)`
   (orphelin grisé) et `IconButton` (`.icon-action` du retrait) — tout existe déjà.
   ============================================================================= */

/** Un lien : couple famille + identifiant. L'ORDRE dans la liste vaut position. */
export interface EntityLinkRef {
  kind: string;
  id: string;
}

/** TEXTES injectés (localisés par l'appelant — le composant reste i18n-agnostique). */
export interface EntityLinkListLabels {
  /** Placeholder du champ de recherche. */
  searchPlaceholder: string;
  /** Invite affichée en italique quand la liste est vide. */
  empty: string;
  /** Nom accessible + tooltip du bouton de retrait d'une rangée. */
  remove: string;
  /** Libellé de repli d'un lien ORPHELIN (cible disparue, `labelOf` → null). */
  unknown: string;
  /** Toast discret quand on tente d'ajouter un lien DÉJÀ présent (doublon résiduel). */
  duplicate: string;
}

/** Options du composant — tout le métier (source, libellés, icônes, textes) est INJECTÉ. */
export interface EntityLinkListOptions {
  /** Valeur initiale : la LISTE des liens (l'ordre = la position). */
  value: EntityLinkRef[];
  /** Notifie une NOUVELLE valeur (copie) après chaque ajout/retrait — l'appelant la recopie chez lui. */
  onChange: (value: EntityLinkRef[]) => void;
  /** Source des candidats : reçoit la requête ET les clés « famille+id » DÉJÀ liées à écarter (dédup).
      ASYNCHRONE (candidats serveur en mode API, locaux en mode fichier). */
  search: (query: string, excludedKeys: Set<string>) => Promise<Array<{ kind: string; id: string; label: string }>>;
  /** Libellé COURANT d'un lien, ou null si la cible a disparu (orphelin). */
  labelOf: (kind: string, id: string) => string | null;
  /** Libellé de FAMILLE (badge du résultat de recherche ET de la rangée). */
  kindLabel: (kind: string) => string;
  /** Code SVG OPTIONNEL de l'icône de famille (constante de confiance `ui/Icons` côté appelant). */
  kindIcon?: (kind: string) => string;
  /** Textes injectés (cf. `EntityLinkListLabels`). */
  labels: EntityLinkListLabels;
  /** Nb de caractères minimal avant recherche — défaut 1 (transmis à `SearchPop`). */
  minChars?: number;
  /** Anti-rebond des saisies (ms) — transmis tel quel à `SearchPop` (son défaut s'applique si absent). */
  debounceMs?: number;
}

export class EntityLinkList {
  /** Construit le contrôle : un `<div>` contenant le champ de recherche (portail) PUIS la liste des
      liens. La valeur est détenue EN INTERNE (copie de `opts.value`) ; chaque mutation appelle
      `onChange` avec une nouvelle copie — l'appelant reste seul propriétaire de sa référence. */
  static build(opts: EntityLinkListOptions): HTMLElement {
    const minChars = opts.minChars != null ? opts.minChars : 1;
    // Copie DÉFENSIVE : le composant travaille sur SA liste et n'altère jamais l'objet de l'appelant.
    // Ce dernier reçoit une copie fraîche à chaque `onChange`, à recopier dans sa propre référence.
    let value: EntityLinkRef[] = opts.value.map((v) => ({ kind: v.kind, id: v.id }));

    const root = document.createElement("div");

    // Notifie l'appelant d'une nouvelle valeur (copie — il ne partage pas notre tableau interne).
    const emitChange = (): void => { opts.onChange(value.map((v) => ({ kind: v.kind, id: v.id }))); };

    // -- LISTE des liens : une rangée par lien (icône de famille + libellé + ✕), état vide en italique. --
    const listEl = document.createElement("div"); listEl.style.marginTop = "8px";
    const renderLinks = (): void => {
      listEl.innerHTML = "";
      if (!value.length) {
        const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic";
        empty.textContent = opts.labels.empty; listEl.appendChild(empty); return;
      }
      value.forEach((ref, index) => {
        const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 0";
        // Icône de famille FACULTATIVE : sans `kindIcon`, la rangée commence directement par le libellé.
        if (opts.kindIcon) {
          const icon = document.createElement("span"); icon.className = "gi"; icon.setAttribute("aria-hidden", "true");
          icon.innerHTML = opts.kindIcon(ref.kind);
          row.appendChild(icon);
        }
        const resolved = opts.labelOf(ref.kind, ref.id);
        const text = document.createElement("span");
        text.textContent = opts.kindLabel(ref.kind) + " · " + (resolved !== null ? resolved : opts.labels.unknown);
        // Cible disparue (orphelin) : le lien RESTE affiché mais grisé — on ne le supprime pas en douce
        // (aucune FK côté serveur, l'orphelin est toléré), l'utilisateur voit ce qui pend.
        if (resolved === null) text.style.color = "var(--fg-dimmer)";
        // Retrait par bouton-ICÔNE (principe n°14 : aria-label + tooltip via IconButton).
        const del = IconButton.build({ icon: Icons.CLOSE, label: opts.labels.remove, onClick: () => { value.splice(index, 1); renderLinks(); emitChange(); } });
        del.style.marginLeft = "auto";
        row.append(text, del);
        listEl.appendChild(row);
      });
    };
    renderLinks();

    // -- CHAMP de recherche unifié : balaye TOUTES les familles à la fois ; chaque résultat porte son
    //    badge de famille (`tag`) ; le CLIC lie l'élément. --
    const pop = new SearchPop({
      placeholder: opts.labels.searchPlaceholder,
      minChars,
      // PORTAIL : le champ vit dans le corps DÉFILANT d'une modale — un popover absolu y serait rogné.
      portal: true,
      debounceMs: opts.debounceMs,
      fetch: (query) => {
        // Dédup calculée à CHAQUE frappe sur l'état COURANT de la liste (encodage via TargetSearch.key,
        // convention UNIQUE de l'app) : les cibles déjà liées sont écartées des résultats.
        const excludedKeys = new Set(value.map((v) => TargetSearch.key(v.kind, v.id)));
        return opts.search(query, excludedKeys).then((results) => results.map((r): SearchPopResult => ({
          id: TargetSearch.key(r.kind, r.id), label: r.label,
          tag: opts.kindLabel(r.kind), data: r,
        })));
      },
      onPick: (result) => {
        const t = result.data as { kind: string; id: string; label: string };
        // Un doublon résiduel (course entre deux frappes) est IGNORÉ avec un toast discret plutôt que
        // silencieusement dupliqué : la dédup du fetch n'est pas atomique avec le clic.
        if (value.some((v) => v.kind === t.kind && v.id === t.id)) { Notify.toast(opts.labels.duplicate, "info"); return; }
        value.push({ kind: t.kind, id: t.id });
        renderLinks(); emitChange();
      },
    });
    const searchWrap = document.createElement("div"); searchWrap.style.marginTop = "6px";
    searchWrap.appendChild(pop.element);

    root.append(searchWrap, listEl);
    return root;
  }
}
