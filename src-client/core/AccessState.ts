/* ============================================================================
   ACCESS STATE — ce que l'UTILISATEUR COURANT a le droit de faire, côté client.

   POURQUOI CE MODULE. Le serveur DÉCIDE (gardes de route, cf. docs/auth.md) ; le
   client, lui, ANTICIPE : il ne doit pas proposer un geste que le serveur
   refusera. Anticiper suppose de connaître la politique — et c'est exactement là
   que le piège se referme : la version précédente du client DUPLIQUAIT la règle
   d'accès (`me.adminRight === "SUPER_ADMIN"`), donc une politique serveur enrichie
   laissait l'interface mentir. Ici, AUCUNE règle de droit n'est écrite : tout est
   délégué au modèle PARTAGÉ `src-shared/Permissions` (matching des jokers dans
   `PermissionSet.has`, carte collection → domaine dans `Permissions`). Cette
   classe n'apporte que le VOCABULAIRE du client (« puis-je créer un câble ? »)
   au-dessus du vocabulaire du modèle (« ai-je `dc.cabling:create` ? »).

   ── Injection NULLE (mode fichier / visualiseur) ──────────────────────────
   En mode FICHIER, l'utilisateur est propriétaire de son fichier : il n'y a ni
   identité, ni frontière de confiance, ni serveur pour la tenir (principe n°15,
   docs/auth.md § « Mode local »). Le client y instancie `AccessState.ALL`, et
   CHAQUE garde d'interface devient inerte D'ELLE-MÊME — c'est le patron exact de
   `HydrationState` : un état neutre plutôt qu'un `if (mode === …)` disséminé dans
   les vues. Conséquence recherchée : le mode fichier ne change pas d'un pixel, et
   aucun test de mode n'apparaît dans les modules gatés.

   ── Les trois états ───────────────────────────────────────────────────────
     · `ALL`               — mode fichier / visualiseur (tout permis, par construction) ;
     · `NONE`              — mode API AVANT la réponse de `GET /me`, et utilisateur
                             authentifié à qui la politique n'accorde RIEN (l'écran
                             « aucun accès » s'appuie sur `isEmpty()`) ;
     · `fromGrants(list)`  — mode API : les grants EFFECTIFS renvoyés par `/me`
                             (jokers compris — le client reçoit des permissions,
                             JAMAIS des noms de rôles).

   Objet-valeur IMMUABLE : un changement de droits (403 en vol → re-fetch de
   `/me`) REMPLACE l'instance, il ne la mute pas. Module PUR (aucun DOM, aucun
   réseau) → testé en isolation dans `Tests/modules/test-client-access.js`.
   ============================================================================ */
import { PermissionSet, Permissions } from "../../src-shared/Permissions";
import type { PermissionAction } from "../../src-shared/Permissions";

export class AccessState {
  /** TOUT PERMIS — mode fichier / visualiseur (injection nulle) et administrateur en mode API. */
  static readonly ALL: AccessState = new AccessState(PermissionSet.ALL);
  /** AUCUN DROIT — avant le bootstrap (mode API) et utilisateur sans aucune permission. */
  static readonly NONE: AccessState = new AccessState(PermissionSet.EMPTY);

  private readonly permissions: PermissionSet;

  /** Construction par les fabriques uniquement : les trois provenances légitimes sont nommées
      (`ALL`, `NONE`, `fromGrants`), ce qui rend tout autre point d'entrée visible en relecture. */
  private constructor(permissions: PermissionSet) { this.permissions = permissions; }

  /** Reconstruit l'état depuis la liste PLATE de grants de `GET /me` (jokers compris). Une valeur
      absente ou mal formée donne l'ensemble VIDE : fail-closed, jamais « au mieux ». */
  static fromGrants(grants: readonly string[] | null | undefined): AccessState {
    return new AccessState(PermissionSet.of(Array.isArray(grants) ? grants : []));
  }

  /** L'utilisateur détient-il cette permission ATOMIQUE (`dc.ip:update`) ? Délègue intégralement au
      matching partagé — les jokers ne sont interprétés QUE dans `PermissionSet.has`. */
  has(permission: string): boolean { return this.permissions.has(permission); }

  /** Aucun droit exploitable → l'écran « aucun accès » (le serveur répondrait 403 partout). */
  isEmpty(): boolean { return this.permissions.isEmpty(); }

  /** Les grants source (diagnostic / journal de bootstrap). Ordre stable, dédoublonné. */
  grants(): readonly string[] { return this.permissions.grants(); }

  /** `<domaine>:<action>` — forme générique dont dérivent les quatre raccourcis ci-dessous. */
  can(domain: string, action: PermissionAction): boolean { return this.has(domain + ":" + action); }

  canRead(domain: string): boolean { return this.can(domain, "read"); }
  canCreate(domain: string): boolean { return this.can(domain, "create"); }
  canUpdate(domain: string): boolean { return this.can(domain, "update"); }
  canDelete(domain: string): boolean { return this.can(domain, "delete"); }

  /** Action sur une COLLECTION du modèle : le domaine vient de la carte PARTAGÉE
      (`Permissions.COLLECTION_DOMAINS`), jamais d'une table locale — c'est ce qui garantit qu'un
      onglet ajouté demain hérite de la même politique que sa route serveur. Collection inconnue
      (hors carte) → refus : mieux vaut masquer un geste que d'en proposer un qui échouera. */
  canOnCollection(collection: string, action: PermissionAction): boolean {
    const permission = Permissions.forCollection(collection, action);
    return !!permission && this.has(permission);
  }

  canReadCollection(collection: string): boolean { return this.canOnCollection(collection, "read"); }
  canCreateCollection(collection: string): boolean { return this.canOnCollection(collection, "create"); }
  canUpdateCollection(collection: string): boolean { return this.canOnCollection(collection, "update"); }
  canDeleteCollection(collection: string): boolean { return this.canOnCollection(collection, "delete"); }

  /** AU MOINS un verbe d'ÉCRITURE sur cette collection. Sert aux affordances qui n'ont pas encore
      choisi leur verbe (une barre d'outils d'édition, un bloc de gestion) : les masquer demande de
      savoir s'il reste QUOI QUE CE SOIT à y faire. */
  canWriteCollection(collection: string): boolean {
    return this.canCreateCollection(collection) || this.canUpdateCollection(collection) || this.canDeleteCollection(collection);
  }

  /** Au moins UNE lecture de donnée documentaire — la même règle que la garde serveur du flux SSE et
      de la recherche transverse (`Permissions.hasAnyDocumentRead`). Assiette de la recherche Ctrl+K. */
  hasAnyDocumentRead(): boolean { return Permissions.hasAnyDocumentRead(this.permissions); }

  /** TOUTE la donnée documentaire est-elle lisible ? Prédicat des opérations qui portent le document
      ENTIER — les EXPORTS (cf. `docs/auth.md` § 10.6). Sous droits partiels, l'assiette de chargement
      est intersectée avec le lisible : le cache ne contient alors PAS tout le document, et un export
      en serait la copie AMPUTÉE — sans que rien ne le dise. On masque donc le geste plutôt que de le
      proposer. Règle déléguée au modèle partagé, comme tout le reste de cette classe. */
  hasFullDocumentRead(): boolean { return Permissions.hasFullDocumentRead(this.permissions); }

  /** Les COLLECTIONS du modèle que cet utilisateur peut LIRE — l'ASSIETTE avec laquelle le plan de
      chargement du document est intersecté (cf. `Store.init`). Même dérivation que l'assiette de la
      recherche transverse côté serveur (`Permissions.readableCollections`), donc strictement la même
      vérité des deux côtés. Ordre stable (celui de la carte). */
  readableCollections(): readonly string[] { return Permissions.readableCollections(this.permissions); }

  /** Résumé LISIBLE des droits de LECTURE documentaire, destiné à l'AFFICHAGE (modale d'infos
      utilisateur de la topbar). Décision PURE et sobre — jamais un inventaire de collection :
      - `full` VRAI quand TOUTE la donnée est lisible (`hasFullDocumentRead`) → « accès complet »
        (le cas de l'admin, et du mode fichier où `ALL` rend tout permis par construction) ;
      - sinon `domains` liste les DOMAINES de donnée dont l'utilisateur a au moins la LECTURE, dans
        l'ordre stable de la carte partagée (`Permissions.DATA_DOMAINS`), pour un affichage court.
      On expose des DOMAINES (dix au plus), jamais des grants ni des rôles : le client applique la
      politique du serveur, il ne la nomme pas. */
  documentAccessSummary(): { full: boolean; domains: readonly string[] } {
    if (this.hasFullDocumentRead()) return { full: true, domains: [] };
    return { full: false, domains: Permissions.DATA_DOMAINS.filter((domain) => this.has(domain + ":read")) };
  }
}
