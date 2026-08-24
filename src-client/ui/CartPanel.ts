/* =============================================================================
   CARTPANEL — LE panier d'actions groupées : sa persistance, sa pastille et sa
   modale. Documentation : docs/panier.md (cadrage du 2026-08-24).

   DÉCOUPE : l'état est PUR (`core/CartModel`), la carte des familles est PURE
   (`core/CartFamilies`) ; ici ne vivent que le stockage, le DOM et l'orchestration.

   INJECTION NULLE (patron `LabelPrintDialog`/`AccessState`) : `setup()` n'est
   appelé par main.ts QUE si au moins une action groupée est disponible — en
   V1-Beta la seule est l'impression d'étiquettes, qui est MODE API SEULEMENT.
   Partout ailleurs `available()` rend faux, la pastille reste masquée et les
   listings ne posent aucune case, sans le moindre test de mode dispersé
   (décision P11). Le jour où une action non-serveur existe, il suffira que le
   bootstrap appelle `setup` dans les deux modes.

   CLOISONNEMENT PAR DOCUMENT : un panier de câbles du document A n'a aucun sens
   dans B. Plutôt que de câbler un « changement de document » à travers toute
   l'app, le document est relu à CHAQUE accès (`host.docKey()`) et comparé à la
   portée chargée : dès qu'il change, le panier est rechargé depuis le stockage —
   donc vide si le stockage appartient à un autre document. Un seul point de
   vérité, aucune notification à ne pas oublier de brancher.

   PORTÉE (décision P2) : `localStorage`, donc LOCAL à l'appareil — remplir sur
   le téléphone et imprimer sur le PC n'est PAS offert (ce serait un panier
   serveur, arbitré « non »). Survit au F5 et à la fermeture du navigateur.

   ⚠ V1-Beta — ce qui n'est PAS ici, à dessein (cf. docs/panier.md § Limites) :
   pas de synchro entre ONGLETS (le dernier écrivain gagne), pas de dialogue de
   REMPLACEMENT au conflit de famille (impossible à déclencher tant qu'une seule
   famille porte une action : les cases n'apparaissent que sur les listings de
   cette famille), pas de « tout cocher le résultat du filtre » — la case
   d'en-tête coche la PAGE.
   ============================================================================= */

import type { ModalOptions } from "./Modal";
import { Icons } from "./Icons";
import { IconButton } from "./IconButton";
import { Notify } from "./Notify";
import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";
import { CartModel, type CartItem } from "../core/CartModel";
import { CartFamilies, type CartFamily } from "../core/CartFamilies";

/** Ce que le panier attend de l'application (câblé UNE fois par main.ts). */
export interface CartHost {
  openModal(opts: ModalOptions): void;
  /** Identité du document courant — clé de cloisonnement (cf. en-tête). */
  docKey(): string;
  /** Le compte a changé : la topbar met sa pastille à jour. */
  onCount(count: number): void;
  /** Repeint la vue courante. Appelé UNIQUEMENT quand la modale du panier a retiré ou vidé
      quelque chose : les cases du listing qui est DESSOUS seraient sinon restées cochées
      jusqu'au prochain rendu (un tri, un filtre, un changement de page). */
  refreshView(): void;
  /** LA seule action groupée de la V1-Beta. L'hôte résout les enregistrements,
      construit les sujets d'étiquette et ouvre `LabelPrintDialog`. */
  print(items: CartItem[]): void;
  /** Familles portant au moins une action — les SEULES qui entrent au panier. */
  families: CartFamily[];
}

/** Clé de stockage. Versionnée : une évolution de forme n'aura pas à lire l'ancienne. */
const STORAGE_KEY = "dcmanager.cart.v1";

export class CartPanel {
  private static host: CartHost | null = null;
  private static model = new CartModel();
  /** Document dont `model` est le panier — `null` tant que rien n'a été chargé. */
  private static scope: string | null = null;

  /** Câblage (mode API seulement en V1-Beta — cf. en-tête). */
  static setup(host: CartHost): void { CartPanel.host = host; }

  /** Le panier est-il offert ? (patron `LabelPrintDialog.available`.) */
  static available(): boolean { return !!CartPanel.host; }

  /** Cette collection entre-t-elle au panier ? (famille connue ET portant une action.) */
  static accepts(collection: string): boolean {
    const host = CartPanel.host;
    if (!host) return false;
    const family = CartFamilies.of(collection);
    return !!family && host.families.indexOf(family) >= 0;
  }

  static count(): number { return CartPanel._model().size(); }

  static isSelected(collection: string, id: string): boolean {
    return CartPanel._model().has(collection, id);
  }

  /** Coche/décoche un élément. Rend FAUX si le geste n'a pas abouti (le listing
      remet alors sa case où elle était — cf. `ListSelection`). */
  static setSelected(collection: string, id: string, on: boolean, record: any): boolean {
    const model = CartPanel._model();
    if (!on) {
      if (model.remove(collection, id)) CartPanel._changed();
      return true;
    }
    const verdict = model.add({ collection, id, label: CartPanel._labelOf(record, id) });
    if (verdict === "added") { CartPanel._changed(); return true; }
    if (verdict === "already") return true;   // idempotent : la case est déjà dans le bon état
    if (verdict === "full") Notify.toast(I18n.t("cart.full", { max: CartModel.MAX }), "err");
    else if (verdict === "conflict") Notify.toast(I18n.t("cart.conflict", { family: CartPanel._familyLabel(model.family()) }), "err");
    return false;
  }

  /** Ouvre la modale du panier (pile standard, sans pied Enregistrer/Annuler). */
  static open(): void {
    const host = CartPanel.host;
    if (!host) return;
    const model = CartPanel._model();
    const body = document.createElement("div");
    body.className = "cart-panel";

    const list = document.createElement("div");
    list.className = "cart-list";
    /* Le listing qui est SOUS la modale garde ses cases telles quelles ; on ne le repeint qu'à la
       fermeture, et seulement si le panier a effectivement changé ici. */
    let mutated = false;
    const printBtn = document.createElement("button");
    printBtn.type = "button"; printBtn.className = "btn btn-primary";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button"; clearBtn.className = "btn";
    clearBtn.textContent = I18n.t("cart.clear");

    /* Repeint le CONTENU sans refermer la modale : retirer un élément est un geste
       courant, il ne doit pas coûter une réouverture. */
    const paint = () => {
      const items = model.all();
      printBtn.textContent = I18n.t("cart.printLabels", { n: items.length });
      printBtn.disabled = items.length === 0;
      clearBtn.disabled = items.length === 0;
      if (!items.length) {
        list.innerHTML = `<div class="empty-state">${Html.escape(I18n.t("cart.empty"))}</div>`;
        return;
      }
      list.innerHTML = items.map((it) => `
        <div class="cart-row" data-col="${Html.escape(it.collection)}" data-id="${Html.escape(it.id)}">
          <span class="cart-row-label">${Html.escape(it.label || it.id)}</span>
          ${IconButton.html({ icon: Icons.DELETE, label: I18n.t("cart.remove"), act: "remove", danger: true })}
        </div>`).join("");
      list.querySelectorAll("[data-act='remove']").forEach((button) => {
        (button as HTMLElement).onclick = () => {
          const row = (button as HTMLElement).closest(".cart-row") as HTMLElement | null;
          if (!row) return;
          model.remove(row.dataset.col || "", row.dataset.id || "");
          mutated = true;
          CartPanel._changed();
          paint();
        };
      });
    };

    printBtn.onclick = () => host.print(model.all());
    clearBtn.onclick = () => { model.clear(); mutated = true; CartPanel._changed(); paint(); };
    body.appendChild(list);
    paint();

    host.openModal({
      title: I18n.t("cart.title"),
      subtitle: I18n.t("cart.subtitle", { n: model.size(), family: CartPanel._familyLabel(model.family()) }),
      body,
      hideFooter: true,
      footerActions: [clearBtn, printBtn],
      stackKey: "cart",
      onClose: () => { if (mutated) host.refreshView(); },
    });
  }

  /* --------------------------------- interne --------------------------------- */

  /** Le panier du document COURANT — rechargé si le document a changé (cf. en-tête). */
  private static _model(): CartModel {
    const doc = CartPanel.host ? CartPanel.host.docKey() : "";
    if (CartPanel.scope === doc) return CartPanel.model;
    CartPanel.scope = doc;
    CartPanel.model = CartPanel._load(doc);
    CartPanel.host?.onCount(CartPanel.model.size());
    return CartPanel.model;
  }

  private static _load(doc: string): CartModel {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return new CartModel();
      const payload = JSON.parse(raw);
      // Panier d'un AUTRE document : on n'en hérite pas (cloisonnement).
      if (!payload || payload.doc !== doc) return new CartModel();
      return CartModel.fromJSON(payload);
    } catch (e) {
      console.warn("CartPanel : lecture du panier impossible", e);
      return new CartModel();
    }
  }

  /** Persiste + notifie la pastille. Appelé après CHAQUE mutation, jamais avant. */
  private static _changed(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ doc: CartPanel.scope || "", items: CartPanel.model.all() }));
    } catch (e) {
      console.warn("CartPanel : écriture du panier impossible", e);
    }
    CartPanel.host?.onCount(CartPanel.model.size());
  }

  /** Libellé de secours d'un élément (cf. CartModel § « ce qu'on stocke »). */
  private static _labelOf(record: any, id: string): string {
    if (!record) return id;
    const name = record.displayName ? record.displayName() : record.name;
    return String(name || id);
  }

  private static _familyLabel(family: CartFamily | null): string {
    return family ? I18n.t("cart.family." + family) : "";
  }
}
