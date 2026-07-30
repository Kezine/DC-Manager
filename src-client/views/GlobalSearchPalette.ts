/* =============================================================================
   GlobalSearchPalette — la palette de RECHERCHE GLOBALE (loupe topbar / Ctrl+K).

   Une modale (principe n°11) contenant un `SearchPop` (principe n°14 — la
   primitive de recherche-popover de l'app, réutilisée telle quelle) : on tape,
   on choisit, la fiche s'ouvre via `Forms.detail` — le point d'entrée UNIQUE
   des fiches. La fiche REMPLACE le contenu de la modale (l'app n'a qu'un overlay
   de modale, sans empilement) : pas de retour-auto à la palette, c'est voulu —
   après avoir trouvé, on travaille sur la fiche, on ne re-cherche pas.

   CE QU'ELLE NE FAIT PAS, à dessein :
   - elle ne LOCALISE jamais : la recherche de la vue Datacenter garde ce verbe
     (elle ne propose que du localisable, prédicat `core/Locatable`) — deux
     verbes, deux recherches, pas de résultat cliquable qui répond par un toast ;
   - pas d'actions de commande (créer, naviguer) en v1 — la forme n'y ferme pas
     la porte.

   Le CORPUS est un SNAPSHOT pris à l'ouverture (GlobalSearchSources.build) :
   re-filtré à chaque frappe, jamais reconstruit — les volumes réels se comptent
   en centaines. Une écriture concurrente pendant que la palette est ouverte
   n'est donc pas reflétée : assumé (la palette vit quelques secondes).
   ============================================================================= */
import type { Store } from "../store";
import { SearchPop, type SearchPopResult } from "../ui/SearchPop";
import { GlobalSearch } from "../core/GlobalSearch";
import { GlobalSearchSources } from "./GlobalSearchSources";
import { Schema } from "../../src-shared/Schema";
import { Forms, type FormHost } from "./Forms";
import { I18n } from "../i18n/I18n";

export class GlobalSearchPalette {
  /** Résultats affichés PAR FAMILLE — au-delà, la troncature est ANNONCÉE (« + N autres »). */
  private static readonly PER_FAMILY_CAP = 5;

  static open(store: Store, host: FormHost): void {
    const corpus = GlobalSearchSources.build(store);   // snapshot — cf. en-tête
    const root = document.createElement("div");

    const pop = new SearchPop({
      placeholder: I18n.t("search.placeholder"),
      grow: true,      // barre pleine largeur, loupe intégrée — même vocabulaire que les listings
      minChars: 2,     // pas d'inondation au focus : une palette n'est pas un sélecteur à parcourir
      fetch: (query) => {
        const families = GlobalSearch.rank(corpus, query, {
          normalize: Schema.normSearch,
          familyOrder: GlobalSearchSources.FAMILY_ORDER,
          perFamilyCap: GlobalSearchPalette.PER_FAMILY_CAP,
        });
        const results: SearchPopResult[] = [];
        for (const family of families) {
          const tag = I18n.t("search.family." + family.kind);
          family.items.forEach((item) => results.push({
            id: family.kind + ":" + item.id,   // les ids ne sont uniques que PAR collection → clé composite
            label: item.label, tag,
            data: { collection: family.kind, id: item.id },
          }));
          // Troncature ANNONCÉE (rangée visible non sélectionnable) — jamais de plafond muet.
          if (family.hidden > 0) results.push({ id: family.kind + ":hidden", label: I18n.t("search.truncated", { n: family.hidden }), tag, disabled: true });
        }
        return Promise.resolve(results);
      },
      onPick: (result) => {
        const target = result.data as { collection: string; id: string };
        // `detail` rend false pour une collection sans fiche — IMPOSSIBLE ici par construction
        // (invariant SOURCES ⊆ DETAIL_COLLECTIONS, testé), donc pas de repli à écrire.
        Forms.detail(store, host, target.collection, target.id);
      },
    });
    root.appendChild(pop.element);

    const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginTop = "8px";
    hint.textContent = I18n.t("search.hint");
    root.appendChild(hint);

    host.openModal({ title: I18n.t("search.title"), body: root, hideFooter: true });
    setTimeout(() => pop.focus(), 30);   // même délai que les formulaires (le temps du montage de la modale)
  }
}
