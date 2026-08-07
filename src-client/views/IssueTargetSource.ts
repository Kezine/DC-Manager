/* =============================================================================
   IssueTargetSource — CONTRAT des cibles liables d'un ticket, injecté via
   `FormHost` (patron `InterventionFicheHooks` / `CertFicheHooks`).

   POURQUOI UN CONTRAT plutôt qu'un accès direct au Store (principe n°2) : la
   fiche et le formulaire d'un ticket n'ont PAS à savoir dans quelles collections
   vivent les objets ciblables, ni comment on nomme un spare sans nom, ni si les
   candidats viennent du cache local (mode fichier) ou d'une recherche transverse
   SERVEUR (mode API). Ils posent une question — « quels candidats pour cette
   saisie ? », « comment s'appelle CETTE cible ? » — et `main.ts` répond.

   ⚠ CE CONTRAT EST SATISFAIT STRUCTURELLEMENT par `ListTargetFilter`
   (`views/ListTargets.issueTarget`), qui décrit DÉJÀ la dimension « Cible » du
   listing des tickets : mêmes familles, même règle de nommage, même source de
   candidats. `main.ts` passe donc LE MÊME descripteur aux deux surfaces — le
   listing et l'éditeur de liens ne peuvent pas diverger, et il n'existe qu'une
   seule table de familles à tenir à jour.

   ⚠ INJECTÉ DANS LES DEUX MODES, contrairement aux hooks d'interventions/certs
   (null hors mode API). C'est la décision D9 du cadrage : les `targets` sont des
   données DU DOCUMENT, pas du tracker — elles restent donc éditables en mode
   fichier, où la source de candidats se rabat simplement sur le cache local.
   ============================================================================= */
import type { TargetSearchItem } from "../core/TargetSearch";

export interface IssueTargetSource {
  /** Libellé d'une cible EXISTANTE, ou `null` si elle a disparu du document. En temps normal ce
      `null` ne se produit PAS pour un ticket : la cascade partagée retire la clé quand l'objet est
      supprimé (écart assumé avec les interventions, dont les cibles vivent dans une autre base).
      Il reste possible sur un document IMPORTÉ, écrit par une autre porte — l'UI grise alors la
      ligne au lieu de planter. */
  labelOf(kind: string, id: string): string | null;
  /** Candidats d'une saisie, familles CONFONDUES, déjà triés par pertinence et bornés. ASYNCHRONE
      (norme n°15) : mode API → candidats SERVEUR (au-delà du corpus chargé) ; mode fichier →
      candidats LOCAUX (promesse résolue). `excluded` = clés « famille:id » DÉJÀ liées, écartées des
      résultats (dédup silencieuse à chaque frappe). */
  search(query: string, excluded?: ReadonlySet<string>): Promise<TargetSearchItem[]>;
  /** Badge de FAMILLE d'un résultat (`tag` du SearchPop) — "" pour n'en afficher aucun. */
  tagOf(kind: string): string;
}
