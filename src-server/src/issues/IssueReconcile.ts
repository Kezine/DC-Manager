import type { IssueRecord, IssueResolution } from "./IssueProvider.js";
import { IssueSync, ISSUE_SOURCE_FIELDS } from "../../../src-shared/IssueSync.js";
import type { IssueSourceFields } from "../../../src-shared/IssueSync.js";

/* =============================================================================
   RÉCONCILIATION DES TICKETS — module `issues/` amovible. Fonction PURE :
   (résolution rendue par un tracker, tickets SUIVIS du document) → opérations
   {mises à jour, introuvables} à appliquer par le chemin d'écriture transactionnel.

   🚨 IL N'Y A PAS DE `creates` ICI, ET CE N'EST PAS UN OUBLI ─────────────────
   C'est L'ÉCART STRUCTURANT du chantier (§3 du cadrage). Dans `vm/` et `wifi/`,
   la SOURCE énumère (`inventory()` rend TOUT l'inventaire) et le document suit :
   tout ce qui apparaît chez la source devient un enregistrement. ICI c'est
   L'INVERSE — le DOCUMENT énumère (les tickets que l'utilisateur a choisi de
   SUIVRE) et la source n'est interrogée QUE sur ces identifiants-là.
   Conséquence directe : une passe de synchro ne peut RIEN créer. Un ticket que la
   source rendrait sans qu'il soit suivi est IGNORÉ (compté dans `untracked`, pour
   qu'il reste observable), jamais matérialisé. Les DEUX seules portes d'entrée de
   l'assiette sont des ACTES utilisateur — « Suivre un ticket » et « Ouvrir un
   ticket » — et elles vivent ailleurs (`IssueSyncService.followReference`, lot L5).
   Recopier `WifiReconcile` tel quel peuplerait le document de tickets que
   personne n'a demandés : la feature serait fausse, et son assiette vidée de sens.

   AGNOSTIQUE DE MARQUE : ce module ne connaît QUE le contrat `IssueResolution` et
   la frontière partagée `src-shared/IssueSync` — jamais un adaptateur, jamais une
   marque. Ajouter un tracker d'une autre marque ne le touche pas.

   Sémantique (le reste est calqué sur `VmReconcile`/`WifiReconcile`) :
   - clé de réconciliation = `ext_id` (l'identifiant INTERNE du ticket, JAMAIS la
     clé lisible : celle-ci CHANGE au déplacement de projet — décision D2, risque
     n°1 du cadrage), PÉRIMÈTRE = une instance de provider : seuls les tickets du
     document portant CE `provider_id` participent (un document multi-trackers ne
     marque pas « introuvables » ceux des AUTRES) ;
   - la synchro n'écrase QUE les champs SOURCE (liste partagée `ISSUE_SOURCE_FIELDS`) —
     les enrichissements locaux (`notes`, `description`, et surtout `targets`, le
     rattachement MANUEL aux objets du modèle) ne sont JAMAIS touchés ;
   - `orphan` est à DOUBLE SENS et c'est le retour qu'on oublie : `true` pour un
     identifiant rendu INTROUVABLE, et RETOUR à `false` dès qu'il est de nouveau
     résolu. Le retour ne demande aucun cas particulier — `orphan` est un champ
     SOURCE, donc le diff champ à champ le couvre — mais il est testé pour lui-même :
     un jour où il cesserait d'être un champ source, rien d'autre ne le signalerait.
     ⚠ Ici « orphelin » veut dire INTROUVABLE (ticket supprimé, projet archivé,
     permission perdue) et non « déconnecté » (wifi) : ce n'est PAS un événement
     banal, et il n'entraîne JAMAIS de suppression — l'enregistrement porte des
     notes et des liens que le tracker ne connaît pas ;
   - IDEMPOTENCE : patchs MINIMAUX (champ à champ sur valeurs NORMALISÉES des deux
     côtés) ; `last_sync` est EXCLU du diff puis posé UNIQUEMENT sur une écriture
     réelle. Re-synchroniser un état inchangé ne produit AUCUNE opération — donc ni
     révision, ni SSE, ni bruit d'undo.
   ============================================================================= */

/** Enregistrement générique du document (le serveur manipule du JSON brut). */
type Rec = { [k: string]: any };

export interface IssueReconcileInput {
  /** Instance de provider réconciliée (`IssueProviderConfig.id`) — délimite le périmètre. */
  providerId: string;
  /** Résultat de `adapter.resolve(extIds)` : les tickets RETROUVÉS et les identifiants NON résolus. */
  resolution: IssueResolution;
  /** Tickets ACTUELS du document (toutes instances confondues — le plan filtre lui-même). */
  existingIssues: Rec[];
  /** Horodatage ISO de CETTE passe (injecté : Date côté serveur, fixe en test). */
  nowIso: string;
}

export interface IssueReconcileOps {
  /** Patchs MINIMAUX (champs source modifiés uniquement) sur des tickets DÉJÀ suivis. */
  updates: { id: string; patch: Rec }[];
  /** Tickets non résolus à marquer « introuvables » (patch dédié — JAMAIS de delete). */
  orphans: { id: string; patch: Rec }[];
  /** Tickets déjà à jour (observabilité : compteurs du statut). */
  unchanged: number;
  /** Tickets rendus par la SOURCE sans être suivis par le document → IGNORÉS (cf. l'en-tête).
      Compté plutôt que tu : ce nombre devrait rester à 0, et un adaptateur qui rendrait des tickets
      non demandés est une anomalie qu'on veut voir dans les journaux, pas une donnée qui s'invite. */
  untracked: number;
}

export class IssueReconcile {
  /** Calcule le plan d'opérations — PUR : ne touche ni document, ni réseau, ni horloge. */
  static plan(input: IssueReconcileInput): IssueReconcileOps {
    const ops: IssueReconcileOps = { updates: [], orphans: [], unchanged: 0, untracked: 0 };

    // PÉRIMÈTRE : les tickets de CETTE instance uniquement (multi-trackers par document).
    const mine = input.existingIssues.filter((issue) => issue && issue.provider_id === input.providerId);
    const byExtId = new Map<string, Rec>();
    for (const issue of mine) {
      // Doublon d'ext_id (ne devrait pas exister — « Suivre un ticket » le refuse) : le premier
      // gagne, le doublon reste inerte (ni mis à jour, ni introuvable) — tolérance, pas correction.
      if (typeof issue.ext_id === "string" && issue.ext_id !== "" && !byExtId.has(issue.ext_id)) byExtId.set(issue.ext_id, issue);
    }

    const seen = new Set<string>();
    for (const record of input.resolution.found || []) {
      // Garde-fou : l'adaptateur estampille provider_id — un record d'une AUTRE instance (bug
      // d'appelant) est écarté plutôt que de polluer le périmètre.
      if (!record || record.provider_id !== input.providerId) continue;
      const desired = IssueReconcile.sourceOf(record, input.nowIso);
      if (desired.ext_id === "") continue;      // sans clé de réconciliation → inexploitable
      if (seen.has(desired.ext_id)) continue;   // doublon de résolution (défensif) → premier gagne
      seen.add(desired.ext_id);

      const existing = byExtId.get(desired.ext_id);
      if (!existing) {
        // ⚠ LE POINT DU CHANTIER : un ticket rendu par la source SANS être suivi n'est PAS créé.
        // La synchro RAFRAÎCHIT une assiette choisie par l'utilisateur, elle ne la PEUPLE jamais.
        ops.untracked++;
        continue;
      }

      // Diff champ à champ sur états NORMALISÉS des DEUX côtés : élimine les faux écarts (champ
      // absent du document vs défaut, null vs "", ordre des étiquettes…) qui feraient réécrire le
      // document à chaque passe. `last_sync` est EXCLU du diff — il ne constitue jamais À LUI SEUL
      // une raison d'écrire, sans quoi l'idempotence serait perdue dès la première passe.
      const current = IssueSync.normalizeSource(existing);
      const patch: Rec = {};
      for (const field of ISSUE_SOURCE_FIELDS) {
        if (field === "last_sync") continue;
        if (!IssueSync.sourceEquals(current, desired, field)) patch[field] = desired[field];
      }
      // (RETOUR D'ORPHELINAT : un ticket redevenu résolu — orphan true → false — est couvert par la
      // boucle ci-dessus, `orphan` étant un champ source ; aucun cas particulier n'est nécessaire.)

      if (Object.keys(patch).length === 0) { ops.unchanged++; continue; }
      patch.last_sync = input.nowIso;   // écriture réelle → le ticket est « touché par la synchro »
      ops.updates.push({ id: existing.id, patch });
    }

    // INTROUVABLES — dérivés des `missing` de la résolution, et SURTOUT PAS d'une différence
    // d'ensembles « suivi mais pas revenu ». La nuance est vitale : le service PLAFONNE le nombre
    // d'identifiants interrogés par passe (l'assiette est pilotée par l'utilisateur, rien ne la
    // borne), donc un ticket suivi peut n'avoir tout simplement PAS été demandé. Le déduire d'une
    // différence d'ensembles le marquerait « introuvable » à tort, à chaque passe tronquée.
    for (const extId of input.resolution.missing || []) {
      if (typeof extId !== "string" || extId === "") continue;
      const existing = byExtId.get(extId);
      if (!existing) continue;                                    // non suivi (ou autre instance) → rien à marquer
      if (seen.has(extId)) continue;                              // rendu ET déclaré manquant (défensif) : la résolution gagne
      if (existing.orphan === true) { ops.unchanged++; continue; } // déjà marqué → aucune op (idempotence)
      ops.orphans.push({ id: existing.id, patch: { orphan: true, last_sync: input.nowIso } });
    }

    return ops;
  }

  /* --------------------------------------------------------------------------
     Normalisation d'un pivot — PUBLIQUE, parce qu'elle est aussi la matière de la
     porte d'entrée « Suivre un ticket » (cf. `IssueSyncService.followReference`).
     ⚠ Ce n'est PAS un constructeur d'enregistrement : elle rend les champs SOURCE,
     rien d'autre. L'assemblage d'un enregistrement NEUF (id, dates, champs LOCAUX)
     vit chez l'appelant qui, lui, a le droit de créer — ce module n'a pas ce droit,
     et lui prêter un `buildCreate` brouillerait précisément ce qu'il affirme.
     -------------------------------------------------------------------------- */

  /** Pivot d'adaptateur → champs SOURCE du document, normalisés par la définition PARTAGÉE (mêmes
      valeurs que produirait le modèle client — sinon : faux deltas à chaque passe).

      La recopie parcourt `ISSUE_SOURCE_FIELDS` plutôt que d'énumérer les champs à la main : le pivot
      serveur et la frontière partagée sont tenus ÉGAUX (sonde de type + test d'invariant du lot L2),
      donc AUCUN mappage de nom n'est nécessaire ici — et un champ source ajouté demain est recopié
      sans qu'on ait à y penser. Une liste écrite à la main ferait, elle, silencieusement l'impasse.

      RÉ-ESTAMPILLAGE de deux champs qui appartiennent au SERVICE et non à l'adaptateur (partage des
      rôles documenté sur `IssueRecord`) :
      - `orphan: false` — un ticket présent dans `found` est RÉSOLU par définition ; l'adaptateur,
        lui, ignore ce que le document suit et ne saurait pas lever le drapeau inverse ;
      - `last_sync` — UNE passe doit porter UN SEUL horodatage, ce qu'un adaptateur qui ne voit qu'un
        LOT ne peut pas garantir. (Il est ensuite EXCLU du diff : cf. `plan`.) */
  static sourceOf(record: IssueRecord, nowIso: string): IssueSourceFields {
    const raw: Rec = {};
    // Indexation TYPÉE : `ISSUE_SOURCE_FIELDS` porte des clés de `IssueSourceFields`, et le pivot
    // serveur en déclare exactement les mêmes — la boucle ne compile que tant que c'est vrai.
    for (const field of ISSUE_SOURCE_FIELDS) raw[field] = record[field];
    raw.orphan = false;
    raw.last_sync = nowIso;
    return IssueSync.normalizeSource(raw);
  }
}
