/* ============================================================================
   APPLINK — LE ROUTEUR DE FRAGMENTS de l'application : la grammaire UNIQUE des
   liens directs (`#…`), et la seule à savoir les lire comme les écrire.
   Code PARTAGÉ front ⇄ back (TS pur).

   POURQUOI CE MODULE (chantier « liens directs », cadrage 2026-09-01).
   Le fragment d'URL portait DEUX langages reconnus l'un après l'autre — un nom
   de vue (`#equipements`, `app/ShellNav`) et un lien d'entité (`#doc/…/fiche/…`,
   `src-shared/EntityLink`). Le chantier en ajoute deux (recherche, familles
   serveur hors document) et en promet d'autres. Écrire chaque cas comme un `if`
   de plus dans `main.ts` reproduirait exactement la dette que `NavModel` et
   `ViewRestoration` ont résorbée ailleurs : une décision ÉCRITE PLUSIEURS FOIS,
   avec des critères qui divergent.

   LA GRAMMAIRE, en entier :

       doc/<docId>/fiche/<collection>/<id>[?vue=1]   ← fiche d'un objet du document
       doc/<docId>/intervention/<id>                 ← intervention (base serveur séparée)
       doc/<docId>/cert/<id>                         ← certificat   (base serveur séparée)
       doc/<docId>/recherche/<texte>                 ← palette de recherche pré-remplie

   Toutes commencent par `doc/<docId>/` — y compris les deux familles « hors
   document » : leurs tables serveur sont bien indexées par `doc_id`
   (`InterventionsDb`, `CertsDb`), donc la bascule de document leur vaut aussi.
   Toutes contiennent des `/`, aucun nom de vue n'en contient : les fragments de
   VUE historiques restent hors d'atteinte de ce module (cf. `ShellNav.resolveHash`).

   🚨 `EntityLink` RESTE LA SOURCE DE VÉRITÉ DE LA FORME « FICHE ». Ce format est
   GRAVÉ dans des étiquettes QR déjà imprimées : il est INTANGIBLE, et toute
   évolution lui est ADDITIVE. `AppLink` DÉLÈGUE à `EntityLink.parse`/`.fragment`,
   il ne recopie jamais leur logique.

   🚨 LE PARAMÈTRE `?vue=1` — ET LE PIÈGE QU'IL TEND.
   La synchronisation d'onglet (« ce lien active AUSSI la vue de l'objet ») est
   portée par un paramètre placé DANS LE FRAGMENT, jamais dans une query string :
   le fragment n'est transmis à aucun serveur, ne traverse aucun reverse-proxy et
   ne se mêle pas aux paramètres d'auth/OIDC des retours de login.
   Conséquence VOULUE, et c'est tout l'intérêt du choix : **les QR déjà imprimés
   ne le portent pas**, donc ils continuent d'ouvrir la fiche PAR-DESSUS l'onglet
   courant, exactement comme avant le chantier. Aucune régression.
   ⚠ `EntityLink.parse` découpe sur `/` et exige EXACTEMENT 5 segments, l'`id`
   étant le 5ᵉ. Un `?vue=1` laissé collé à l'id serait AVALÉ DANS L'ID (« objet
   introuvable » sur un objet qui existe). Ce module DOIT donc séparer le suffixe
   `?…` du chemin AVANT toute délégation — jamais l'inverse. C'est la raison
   d'être de `splitFragment()`.

   SÉCURITÉ. `parse` est nourri de texte NON SÛR (un QR scanné, un lien collé) :
   la collection reste validée contre la liste blanche du schéma (via
   `EntityLink`), les identifiants ne sont que des CLÉS DE RECHERCHE, et AUCUNE
   navigation n'est décidée ici — le module rend une cible, l'appelant décide.
   ============================================================================ */

import { EntityLink, type EntityLinkTarget } from "./EntityLink.js";

/** Fiche d'un objet du document — la forme historique (`EntityLink`), plus le drapeau de
    synchronisation d'onglet lu dans le fragment. */
export interface AppLinkFiche extends EntityLinkTarget {
  kind: "fiche";
  /** Le lien demande-t-il d'ACTIVER la vue de la collection avant d'ouvrir la fiche ? Faux pour tout
      lien qui ne porte pas `?vue=1` — donc pour toutes les étiquettes QR déjà imprimées. */
  syncView: boolean;
}

/** Familles vivant dans une base SERVEUR séparée (pas des collections du document) : leur fiche est
    peinte PAR LEUR VUE, donc l'ouverture implique l'activation de celle-ci. Il n'y a rien à
    paramétrer — `syncView` n'aurait aucun sens ici, et n'existe donc pas. */
export interface AppLinkExterne {
  kind: "intervention" | "cert";
  docId: string;
  id: string;
}

/** Palette de recherche pré-remplie. `query` est le texte CANONIQUE (préfixe de portée compris,
    ex. « eq: switch ») : la portée se relit du texte, elle n'est pas un second paramètre. */
export interface AppLinkRecherche {
  kind: "recherche";
  docId: string;
  query: string;
}

export type AppLinkTarget = AppLinkFiche | AppLinkExterne | AppLinkRecherche;

/** Une forme de `stackKey` reconnue par le registre (cf. `fromStackKey`). */
interface StackKeyForm {
  /** Préfixe de la clé de pile, `:` compris (ex. `"detail:"`). */
  prefix: string;
  /** Traduit ce qui SUIT le préfixe en cible, ou `null` si la clé est mal formée. */
  target(rest: string, docId: string): AppLinkTarget | null;
}

export class AppLink {
  /** Nom du paramètre de synchronisation d'onglet. Écrit `?vue=1` ; toute autre valeur vaut « non »
      (un lien tronqué ou bricolé ne doit pas activer une navigation par accident). */
  static readonly PARAM_VIEW = "vue";

  /* ==========================================================================
     LECTURE
     ========================================================================== */

  /** Sépare le chemin du fragment de son suffixe de paramètres. PREMIER `?` seulement : un `?` plus
      loin appartient au texte (une recherche peut en contenir un). */
  private static splitFragment(fragment: string): { path: string; params: string } {
    const at = fragment.indexOf("?");
    return at < 0 ? { path: fragment, params: "" } : { path: fragment.slice(0, at), params: fragment.slice(at + 1) };
  }

  /** Le paramètre `name` vaut-il `1` dans ce suffixe ? Lecture VOLONTAIREMENT stricte (pas de
      `URLSearchParams` : ce module est partagé et doit rester sans dépendance d'environnement). */
  private static flag(params: string, name: string): boolean {
    if (!params) return false;
    return params.split("&").some((pair) => pair === name + "=1");
  }

  /** Fragment NU d'un texte : ce qui suit le premier `#`, ou le texte entier quand il n'y en a pas
      (appelant ayant déjà déshabillé le hash). L'HÔTE est ignoré — invariant de survie d'`EntityLink` :
      une étiquette imprimée sous une ancienne URL reste lisible DANS l'app après un déménagement. */
  private static fragmentOf(text: unknown): string {
    const raw = String(text ?? "").trim();
    const at = raw.indexOf("#");
    return at >= 0 ? raw.slice(at + 1) : raw;
  }

  /** Lit une cible dans `text` — URL complète (quel qu'en soit l'hôte), `location.hash` ou fragment nu.
      `null` quand le texte ne porte aucune forme connue : c'est la réponse NORMALE et fréquente (un
      hash de VUE, un QR étranger, un lien forgé), et le silence est alors le comportement voulu. */
  static parse(text: unknown): AppLinkTarget | null {
    const { path, params } = AppLink.splitFragment(AppLink.fragmentOf(text));
    const parts = path.split("/");
    if (parts.length < 4 || parts[0] !== "doc") return null;

    let docId: string;
    try { docId = decodeURIComponent(parts[1]); }
    catch { return null; }            // %-encodage invalide (URIError) : lien forgé, pas des nôtres
    if (!docId) return null;

    // -- FICHE : on DÉLÈGUE au format gravé sur les étiquettes, en lui passant le chemin SEUL.
    //    (C'est ici que se joue le piège du § d'en-tête : `path`, jamais `fragment`.)
    if (parts[2] === "fiche") {
      const entity = EntityLink.parse(path);
      return entity ? { kind: "fiche", ...entity, syncView: AppLink.flag(params, AppLink.PARAM_VIEW) } : null;
    }

    // -- Familles hors document : `doc/<docId>/<intervention|cert>/<id>`, exactement 4 segments.
    //    Le `kind` est repris de la constante COMPARÉE, pas du segment brut : c'est ce qui garantit au
    //    type (et au lecteur) que seules ces deux valeurs sortent d'ici.
    for (const kind of ["intervention", "cert"] as const) {
      if (parts.length !== 4 || parts[2] !== kind) continue;
      let id: string;
      try { id = decodeURIComponent(parts[3]); }
      catch { return null; }
      return id ? { kind, docId, id } : null;
    }

    // -- RECHERCHE : tout ce qui suit `recherche/` EST le texte. Contrairement aux identifiants, on
    //    recolle les segments restants au lieu d'exiger un compte exact — un `/` non encodé tapé à la
    //    main reste alors du texte de recherche, ce qu'il est. `fragment()`, lui, encode toujours.
    if (parts[2] === "recherche") {
      let query: string;
      try { query = decodeURIComponent(parts.slice(3).join("/")); }
      catch { return null; }
      // Une recherche VIDE n'a pas d'objet : le bouton n'en produit jamais, et l'accepter n'ouvrirait
      // qu'une palette vierge — ce qu'un simple Ctrl+K fait déjà.
      return query.trim() ? { kind: "recherche", docId, query } : null;
    }

    return null;
  }

  /* ==========================================================================
     ÉCRITURE
     ========================================================================== */

  /** Fragment canonique (SANS le `#`) désignant `target`. Chaque segment variable est encodé un à un :
      un identifiant contenant `/`, `#` ou un espace survit au round-trip `fragment` → `parse`. */
  static fragment(target: AppLinkTarget): string {
    if (target.kind === "fiche") {
      // La forme est celle d'`EntityLink` — jamais recomposée à la main — et le paramètre lui est
      // AJOUTÉ, donc un lien sans synchronisation est BIT POUR BIT celui des étiquettes imprimées.
      return EntityLink.fragment(target) + (target.syncView ? "?" + AppLink.PARAM_VIEW + "=1" : "");
    }
    const head = "doc/" + encodeURIComponent(target.docId) + "/";
    if (target.kind === "recherche") return head + "recherche/" + encodeURIComponent(target.query);
    return head + target.kind + "/" + encodeURIComponent(target.id);
  }

  /** Base d'URL PARTAGEABLE tirée d'une adresse courante (`location.href`) : hash ET query retirés.
      La query part avec le reste — elle peut porter un état d'authentification (retour OIDC) ou un
      paramètre de session qui n'a aucune raison d'être recopié dans un lien envoyé à un collègue.
      ⚠ Comportement DIFFÉRENT d'`EntityLink.build`, qui ne retire que le hash : lui reçoit une URL de
      configuration déjà propre (`PUBLIC_BASE_URL`), ici on reçoit une barre d'adresse. */
  static baseOf(href: unknown): string {
    return String(href ?? "").trim().replace(/#.*$/, "").replace(/\?.*$/, "");
  }

  /** URL ABSOLUE partageable : base nettoyée + `#` + fragment canonique. */
  static build(baseUrl: string, target: AppLinkTarget): string {
    return AppLink.baseOf(baseUrl) + "#" + AppLink.fragment(target);
  }

  /* ==========================================================================
     LE REGISTRE — « quelle modale a une adresse ? »
     ========================================================================== */

  /** Formes de `stackKey` qui désignent un objet ADRESSABLE.

      🚨 C'EST LE POINT D'EXTENSION DU CHANTIER (convention de `CLAUDE.md`). Brancher un nouvel élément
      doté d'une modale d'info = **UNE LIGNE ICI**, plus la `stackKey` que la modale passe déjà de toute
      façon à `Modal.open` pour la déduplication de pile. Rien à écrire dans la modale elle-même.

      POURQUOI DÉRIVER DE LA `stackKey` plutôt que faire déclarer un lien à chaque fiche : les 21 fiches
      du document portent DÉJÀ `detail:<collection>/<id>`, qui EST l'adresse de l'objet. Un champ
      explicite aurait été 21+ points d'écriture, donc 21 occasions d'oublier — et un oubli est
      SILENCIEUX (pas de bouton, personne ne le voit). Ici, l'exhaustivité est prouvée par un test qui
      échoue EN NOMMANT la fiche sans lien. Une modale qui voudrait tout de même décider elle-même
      passe un `shareKey` explicite à `Modal.open`, qui PRIME (cf. `ui/Modal`).

      Un registre DÉCLARATIF, et non un `switch` : même raison que `DetailForms.DETAIL_OPENERS` et
      `NavModel.NAV_DOMAINS` — un `case` oublié est un échec muet. */
  private static readonly STACK_KEY_FORMS: readonly StackKeyForm[] = [
    // Les 21 fiches du document. `rest` = « <collection>/<id> » — la collection est validée par la
    // liste blanche du schéma au moment du `parse` de contrôle ci-dessous.
    { prefix: "detail:", target: (rest, docId) => AppLink.ficheOf(rest, docId) },
    // VISUALISEUR de pièce jointe (`view:attachments/<id>`) : il n'a pas d'adresse propre — décision
    // A4 du cadrage, le lien REPLIE sur la FICHE de la pièce jointe, d'où l'aperçu s'ouvre. Même
    // forme « <collection>/<id> », donc même traduction.
    { prefix: "view:", target: (rest, docId) => AppLink.ficheOf(rest, docId) },
    // Familles hors document : la clé ne porte qu'un id.
    { prefix: "intervention:", target: (rest, docId) => (rest ? { kind: "intervention", docId, id: rest } : null) },
    { prefix: "cert:", target: (rest, docId) => (rest ? { kind: "cert", docId, id: rest } : null) },
  ];

  /** « <collection>/<id> » → cible de fiche, ou `null`. La validité de la collection est déléguée à
      `EntityLink.parse` (liste blanche du schéma) : on ne redéclare pas ici ce qu'il sait déjà. */
  private static ficheOf(rest: string, docId: string): AppLinkFiche | null {
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const entity = EntityLink.parse(EntityLink.fragment({ docId, collection: rest.slice(0, slash), id: rest.slice(slash + 1) }));
    return entity ? { kind: "fiche", ...entity, syncView: false } : null;
  }

  /** Cible désignée par une `stackKey` de modale, ou `null` quand cette modale n'est pas un OBJET
      (réglages, panier, viseur de scan, infos utilisateur, formulaires d'édition…). Un `null` n'est
      pas une anomalie : c'est ce qui fait qu'aucun bouton « copier le lien » n'apparaît là où il n'y a
      rien à partager — donc aucune promesse non tenue. */
  static fromStackKey(stackKey: unknown, docId: string): AppLinkTarget | null {
    const key = String(stackKey ?? "");
    if (!key || !docId) return null;
    const form = AppLink.STACK_KEY_FORMS.find((f) => key.startsWith(f.prefix));
    return form ? form.target(key.slice(form.prefix.length), docId) : null;
  }

  /** Préfixes de `stackKey` reconnus — exposés pour le VERROU de test (« toute fiche a un lien ») et
      pour la documentation. Dérivé du registre, jamais réécrit à la main. */
  static stackKeyPrefixes(): readonly string[] {
    return AppLink.STACK_KEY_FORMS.map((f) => f.prefix);
  }

  /** Cible de fiche portant la synchronisation d'onglet — ce que produit le bouton « copier le lien ».
      Séparé de `fromStackKey` parce que ce sont deux questions : « cette modale a-t-elle une adresse ? »
      et « le lien qu'on PARTAGE demande-t-il d'activer la vue ? » (oui par défaut, décision A1). */
  static withViewSync(target: AppLinkTarget, syncView = true): AppLinkTarget {
    return target.kind === "fiche" ? { ...target, syncView } : target;
  }
}
