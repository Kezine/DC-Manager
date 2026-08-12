import { I18n } from "../../i18n/I18n";

/* =============================================================================
   AsyncSection — RÉSERVER LA PLACE d'une section de fiche alimentée en ASYNC.

   Garde G7 du chantier « lazy-load des collections » (cf. docs/hydratation.md
   § Vague 2). Les sections « Pièces jointes » / « Applications hébergées » des
   fiches lisaient le cache du Store en SYNCHRONE ; sur une collection chargée
   paresseusement, elles s'afficheraient VIDES alors que le serveur a des lignes.
   Elles lisent désormais des jumeaux ASYNC (`Store.attachmentsOfEquipmentAsync`…),
   ce qui pose un problème d'ordre de rendu : une fiche est construite d'un trait,
   de haut en bas, et `root.appendChild` au retour d'une promesse placerait la
   section EN FIN de fiche, après la façade, les ports et les câbles.

   D'où cette brique : elle appende IMMÉDIATEMENT un conteneur — la place de la
   section est réservée au bon endroit —, et le remplit quand les lignes arrivent.
   Elle est PARTAGÉE par les deux sections (principe n°3) : sans elle, la même
   mécanique (conteneur, état de chargement, jeton d'obsolescence, silence en
   échec) serait recopiée dans `AttachmentUi` et dans `ApplicationUi`.

   Ce qu'elle garantit :
   - AUCUN FLASH « vide » : tant que rien n'est arrivé, on affiche « Chargement… »
     et jamais l'état vide — un bloc absent et un bloc pas encore chargé ne disent
     pas la même chose. En mode fichier (et sur une collection hydratée), la
     promesse est résolue AVANT le premier rendu du navigateur : l'utilisateur ne
     voit jamais ce libellé, et il n'y a donc aucun écart visible (principe n°15) ;
   - liste VIDE → conteneur laissé VIDE : la section reste MASQUÉE, comportement
     historique des deux sections (on n'ajoute pas un bloc muet à une fiche dense) ;
   - ÉCHEC réseau → ligne discrète « Chargement impossible » plutôt qu'un silence
     qui se lirait « aucune pièce jointe » (une fiche qui ment est pire qu'une fiche
     qui s'excuse) ; jamais d'erreur remontée, jamais de rendu bloqué.
   ============================================================================= */
export class AsyncSection {
  /** Réserve un conteneur dans `root` et le remplit avec `render(host, rows)` à l'arrivée des lignes.
      `render` reçoit le conteneur (vidé au préalable) et décide de TOUT son contenu — y compris de ne
      rien rendre si la liste est vide. */
  static attach<T>(root: HTMLElement, rows: Promise<T[]>, render: (host: HTMLElement, rows: T[]) => void): void {
    const holder = document.createElement("div");
    root.appendChild(holder);   // la PLACE est prise tout de suite : l'ordre des sections est celui du code

    const pending = document.createElement("div");
    pending.className = "form-hint";
    pending.textContent = I18n.t("ui.section.loading");
    holder.appendChild(pending);

    rows.then((list) => {
      holder.innerHTML = "";
      render(holder, list || []);
    }).catch(() => {
      holder.innerHTML = "";
      const failed = document.createElement("div");
      failed.className = "form-hint";
      failed.textContent = I18n.t("ui.section.loadError");
      holder.appendChild(failed);
    });
  }
}
