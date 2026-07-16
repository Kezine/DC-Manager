import type { VmProviderStatus } from "./VmSyncService.js";
import type { ProviderTokenError, ProviderListItem } from "./ProviderConfigDb.js";

/* =============================================================================
   ENRICHISSEMENT DES STATUTS DE PROVIDER — module `vm/` AMOVIBLE, logique PURE
   (aucun accès DB/réseau/Express) donc testable en isolation.

   POURQUOI ce module existe (incident vécu 2026-07) : `VmSyncService.statusFor`
   liste les providers via `ProviderConfigSource.providersFor`, qui EXCLUT tout
   provider dont le jeton STOCKÉ est INDÉCHIFFRABLE — cas typique : la clé
   `DCMANAGER_SECRETS_KEY` a changé (ou a été perdue), le jeton chiffré au repos
   n'est plus lisible (cf. ProviderConfigDb.providersFor + SecretBox.decrypt).
   Conséquence AVANT correctif : ces providers disparaissaient PUREMENT de l'UI —
   la vue « Clusters » affichait une liste VIDE, sans la moindre explication ;
   l'opérateur ne voyait rien à l'écran et devait fouiller les logs serveur.

   Ce module RÉINJECTE ces providers exclus sous forme de statuts EN ERREUR
   (ok:false) portant le message SecretBox déjà mémorisé (« le secret doit être
   ressaisi ») : la vue Clusters les rend alors comme les autres cartes (pastille
   « en erreur » + message actionnable) au lieu du silence. SÛR : le message de
   SecretBox ne contient AUCUN jeton (invariant du coffre), il est donc renvoyable
   au client tel quel.
   ============================================================================= */
export class VmStatusEnrichment {
  /** Complète `statuses` (issus de `statusFor`/`syncDocument`) avec un statut EN ERREUR par
      provider dont le jeton est indéchiffrable (`tokenErrors`, mémorisés au dernier `providersFor`).
      L'identité/kind/intervalle vient de la liste CRUD (`listItems`, qui inclut les providers
      cassés — elle ne déchiffre AUCUN jeton) ; à défaut d'y figurer, on retombe sur des valeurs
      neutres. Déduplique par `provider_id` : un provider déjà décrit dans `statuses` n'est jamais
      doublé (en pratique l'exclusion est mutuelle — un provider est SOIT déchiffré et présent, SOIT
      en erreur et absent — mais la garde reste défensive). Renvoie un NOUVEAU tableau (entrées
      d'origine en tête, entrées d'erreur ajoutées à la fin), sans muter les entrées. */
  static withTokenErrors(
    statuses: VmProviderStatus[],
    tokenErrors: ProviderTokenError[],
    listItems: ProviderListItem[],
  ): VmProviderStatus[] {
    if (!tokenErrors.length) return statuses.slice();
    const present = new Set(statuses.map((s) => s.provider_id));
    const byId = new Map(listItems.map((item) => [item.id, item]));
    const extra: VmProviderStatus[] = [];
    for (const err of tokenErrors) {
      if (present.has(err.id)) continue; // déjà présent (ne devrait pas arriver) → pas de doublon
      const item = byId.get(err.id);
      extra.push({
        provider_id: err.id,
        kind: item ? item.kind : "?",
        interval_sec: item ? item.interval_sec : 0,
        last_attempt: null,
        last_success: null,
        ok: false,
        message: err.message, // message SecretBox actionnable, SANS jeton
        counts: null,
        cluster: null,
      });
    }
    return [...statuses, ...extra];
  }
}
