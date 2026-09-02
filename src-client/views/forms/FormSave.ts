import type { Store } from "../../store";

/* =============================================================================
   FormSave — ÉCRITURE d'un enregistrement depuis un formulaire, et le seul
   endroit qui dise si l'on a le droit d'annoncer un succès.

   LE DÉFAUT QU'ELLE FERME. Onze formulaires écrivaient ainsi :

       if (existant) await store.update("sites", existant.id, payload);
       else          await store.create("sites", payload);
       Notify.toast("Site mis à jour"); onSaved?.(); return true;

   Or `Store.create`/`Store.update` rendent **`null`** quand la validation
   partagée REFUSE l'écriture (cf. `Store.accepts`) — sans lever d'exception. Le
   formulaire enchaînait donc sur « Site mis à jour », marquait le document
   modifié et se FERMAIT, pendant que le `Store` affichait en parallèle un toast
   ROUGE nommant les règles violées. Deux messages contradictoires, et la saisie
   perdue à la fermeture.

   Le cas le plus net est celui des règles de DÉPENDANCE INVERSE (V5b) :
   rétrécir un site sous ses propres plans d'étage est refusé par le `Store`,
   mais `LiveValidation` ne joue pas ces règles-là — rien n'est surligné dans la
   modale, et sans ce garde-fou rien n'empêchait le message de succès.

   POURQUOI UN MODULE, ET PAS UN `if` RECOPIÉ ONZE FOIS (principes n°2/n°3) : ce
   qui est dupliqué n'est pas seulement le contrôle, c'est aussi le choix
   « créer ou mettre à jour », écrit onze fois sous la même forme ternaire. Les
   deux vivent ici, et un verrou de test (`test-views-tools.js`) refuse qu'un
   formulaire réintroduise l'écriture directe suivie d'un toast de succès.

   CE QUE CETTE CLASSE NE FAIT PAS : afficher un message d'échec. Le `Store`
   notifie déjà, via `onInvalid`, un toast rouge qui CITE les règles violées ;
   en superposer un second, générique, chasserait le précis hors de l'écran.
   L'appelant a seulement à rendre `false` — la modale reste alors ouverte, la
   saisie intacte, et l'utilisateur lit la vraie raison.
   ============================================================================= */
export class FormSave {
  /** Crée ou met à jour un enregistrement, selon que `existingId` est fourni.

      Rend l'enregistrement ÉCRIT, ou **`null` si le `Store` a refusé** — auquel cas l'appelant DOIT
      rendre `false` sans rien annoncer (cf. l'en-tête). Le retour porte l'enregistrement plutôt qu'un
      booléen parce que plusieurs appelants ont besoin de l'id tout juste créé (routage d'un câble,
      sélection d'un groupe neuf). */
  static async record(store: Store, collection: string, existingId: string | null | undefined,
                      payload: Record<string, any>): Promise<any | null> {
    return existingId
      ? await store.update(collection, existingId, payload)
      : await store.create(collection, payload);
  }

  /** Applique un LOT d'écritures et dit si le `Store` l'a ACCEPTÉ (validation CONSCIENTE DU LOT : chaque
      op est vérifiée contre l'état POST-lot, cf. `Store.saveBatch`).

      ⚠ Existe pour lever une AMBIGUÏTÉ, pas seulement pour raccourcir : `updateBatch` rend le NOMBRE
      d'enregistrements écrits, donc **`0` aussi bien pour un refus que pour un lot sans effet**. Un appelant
      qui écrirait `if (!await store.updateBatch(ops))` traiterait « rien à faire » comme un échec.
      « Rien à faire » recouvre DEUX cas, et le second est arrivé avec le filtre no-op du chantier T9 : le lot
      VIDE (aucune op), et le lot dont toutes les ops sont SANS EFFET (le fameux « Enregistrer » d'un formulaire
      non modifié — depuis T9 il n'écrit plus rien, donc ne compte plus rien). Les deux sont des SUCCÈS : il n'y
      avait rien à refuser. D'où le passage par `saveBatch`, dont le verdict `ok` répond exactement à la question
      posée ici, au lieu d'un comptage qu'il fallait ré-interpréter. */
  static async batch(store: Store, ops: Array<{ collection: string; id: string; patch: Record<string, any> }>): Promise<boolean> {
    if (!ops.length) return true;
    return (await store.saveBatch({ updates: ops })).ok;
  }
}
