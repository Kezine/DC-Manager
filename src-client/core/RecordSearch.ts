/* =============================================================================
   RecordSearch — « quel texte trouve cet enregistrement », côté CLIENT.

   SOURCE UNIQUE, et la MÊME que le serveur : le module partagé
   `src-shared/SearchTerms`. Ce fichier ne décide RIEN sur le contenu des termes,
   il ne fait qu'adapter la forme des enregistrements du client (instances du
   Store) et exposer les DEUX formes dont le front a besoin :

   - `termsOf` → forme LISTE (valeurs propres étalées + dérivés), consommée par
     le SCORING de la palette globale (`core/GlobalSearch`, palier 30) ;
   - `textOf`  → forme TEXTE normalisée, consommée par la RECHERCHE DES LISTINGS
     (`core/RecordSearchIndex`). Elle est, LITTÉRALEMENT, le contenu de la
     colonne `search` du serveur (`SearchTerms.searchText`) : chercher un
     listing en mode fichier et le chercher en mode API répondent la même chose
     PAR CONSTRUCTION, pas par discipline (principe n°15, cf. docs/recherche.md).

   Historique : ces deux dérivations vivaient en double — `GlobalSearchSources`
   avait sa `termsOf` privée, les listings leurs `ListConfigs.searchFields` (des
   relevés ad hoc, plus pauvres et divergents des deux modes). Le lot 3 les fait
   converger ICI ; `GlobalSearchSources` DÉLÈGUE désormais à ce module.

   ⚠ PÉRIMÈTRE : les COLLECTIONS DU DOCUMENT (`Schema.COLLECTIONS`) seulement.
   Une source « custom » d'un listing (bibliothèque d'images de façade, servie
   par `ImageStore` hors modèle) n'a AUCUNE spec partagée, et ses enregistrements
   portent une data URL entière (`FaceImage.data`) qui n'a rien à faire dans un
   texte cherchable — ces listings gardent donc leurs `searchFields` explicites
   (cf. `ListView`/`ListConfigs.faceImages`).
   ============================================================================= */
import { SearchTerms } from "../../src-shared/SearchTerms";
import type { EntityFetcher, ChildFinder } from "../../src-shared/DataValidation";

export class RecordSearch {
  /** Forme DONNÉES canonique d'un enregistrement : `toJSON()` quand il existe (instances du Store) —
      c'est exactement ce que le SERVEUR voit et sérialise, donc la seule base d'une parité par
      construction. Un record brut (réponse REST non encore absorbée) est pris tel quel. */
  static jsonOf(record: any): Record<string, any> {
    return (record && typeof record.toJSON === "function") ? record.toJSON() : (record || {});
  }

  /** TERMES cherchables (forme LISTE) : valeurs PROPRES du record — tableaux ÉTALÉS, même effet que leur
      jointure par espaces côté serveur, à la recherche de PAIRES adjacentes près (assumé) — suivis des
      dérivés/catalogues/compositions du module partagé. Bruts, non normalisés : le scoring de la palette
      normalise lui-même et veut des valeurs lisibles. */
  static termsOf(collection: string, record: any, fetch: EntityFetcher, find: ChildFinder): unknown[] {
    const json = RecordSearch.jsonOf(record);
    const own = Object.values(json).flatMap((value) => (Array.isArray(value) ? value : [value]));
    return [...own, ...SearchTerms.termsOf(collection, json, fetch, find)];
  }

  /** TEXTE cherchable NORMALISÉ — le contenu EXACT de la colonne `search` du serveur pour cet
      enregistrement. C'est sur lui que la recherche d'un listing teste l'inclusion en mode fichier,
      quand le serveur teste `LIKE '%…%'` sur la colonne : même assiette, même normalisation, même
      réponse (docs/recherche.md § « Listings serveur-pilotés »). */
  static textOf(collection: string, record: any, fetch: EntityFetcher, find: ChildFinder): string {
    return SearchTerms.searchText(collection, RecordSearch.jsonOf(record), fetch, find);
  }
}
