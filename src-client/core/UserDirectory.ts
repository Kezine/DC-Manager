/* =============================================================================
   ANNUAIRE UTILISATEURS — service CLIENT (CORE, mode API uniquement).

   Transforme un IDENTIFIANT d'utilisateur (clé canonique posée en audit
   `created_by`/`updated_by` par le serveur) en un LIBELLÉ affichable. Cache mémoire
   `Map<id, ResolvedUser>` alimenté par des résolutions BATCH contre l'endpoint
   `GET /users/resolve` (cf. docs/user-resolver.md, lots 1 & 2).

   Deux propriétés fondatrices :
   - `display(id)` est SYNCHRONE (lecture du cache) : les rendus (fiches, colonnes)
     restent synchrones et la règle d'affichage est PURE et testée.
   - `ensure(ids)` COALESCE les demandes : plusieurs appels rapprochés (une fiche, une
     page de listing…) fusionnent en UNE requête réseau (micro-tâche), jamais une
     requête par id. La promesse renvoyée résout quand le lot est traité → le
     consommateur re-rend (callback local, sans reconstruire toute la vue).

   DÉCOUPLAGE (principe n°2) : l'accès réseau passe par le contrat minimal
   `UserResolverClient` (que `RestAdapter` satisfait) — la classe reste testable avec
   un stub, sans DOM ni réseau. Instanciée UNIQUEMENT en mode REST (null sinon : le
   mode fichier n'a aucune identité serveur).
   ============================================================================= */

/** Profil utilisateur RÉSOLU, prêt à afficher — MIROIR de `ResolvedUser` (serveur, users/UserResolver.ts).
    Tous les champs sont des chaînes ; un renseignement inconnu vaut la chaîne VIDE (jamais null). Duplication
    ASSUMÉE (principe n°3) : c'est la FORME d'une réponse réseau, pas une règle métier partageable. */
export interface ResolvedUser {
  id: string;
  login: string;
  domain: string;
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
}

/** Contrat MINIMAL d'accès réseau (résolution batch) — `RestAdapter` l'expose (`resolveUsers`). Interface
    (et non import de la classe) : découplage + testabilité par stub. */
export interface UserResolverClient {
  resolveUsers(ids: string[]): Promise<ResolvedUser[]>;
}

/** Plafond d'ids par requête (parité avec le plafond serveur de `GET /users/resolve`) — au-delà, on découpe. */
const RESOLVE_BATCH_CAP = 200;

export class UserDirectory {
  /** Cache mémoire = source de vérité des résolutions (id canonique → profil). */
  private readonly cache = new Map<string, ResolvedUser>();
  /** Ids EN ATTENTE de résolution, accumulés jusqu'au prochain flush (coalescence). */
  private readonly pending = new Set<string>();
  /** Promesse du flush courant (null quand aucun n'est planifié) — partagée par tous les `ensure` du même tick. */
  private flushPromise: Promise<void> | null = null;

  constructor(private readonly client: UserResolverClient) {}

  /** Règle d'affichage PURE (testée) : « Prénom Nom » sinon login sinon **id brut**. L'id brut couvre le
      LEGACY (valeurs « noms en clair » écrites avant l'estampillage par id : elles ne sont pas en cache donc
      s'affichent telles quelles) et l'inconnu. `id` sert de repli quand `user` est absent OU dégénéré. */
  static displayOf(user: ResolvedUser | undefined, id: string): string {
    if (user) {
      const full = [user.firstname, user.lastname].map((s) => (s || "").trim()).filter((s) => s !== "").join(" ");
      if (full !== "") return full;
      if (user.login && user.login.trim() !== "") return user.login.trim();
    }
    return id;
  }

  /** Libellé affichable d'un id, SYNCHRONE depuis le cache (id brut en repli). "" si id vide. */
  display(id: string): string {
    if (!id) return "";
    return UserDirectory.displayOf(this.cache.get(id), id);
  }

  /** Le profil de cet id est-il déjà résolu (en cache) ? */
  has(id: string): boolean { return this.cache.has(id); }

  /** Résout les ids MANQUANTS seulement (ceux déjà en cache sont ignorés), en COALESCANT les demandes
      rapprochées en UNE requête batch (micro-tâche). La promesse résout quand le lot courant est traité —
      le consommateur y chaîne son re-rendu. Un échec réseau ne rejette PAS (badge/fiche non critiques :
      l'affichage garde l'id brut, une prochaine demande réessaiera). */
  ensure(ids: Iterable<string>): Promise<void> {
    for (const id of ids) if (id && id.trim() !== "" && !this.cache.has(id)) this.pending.add(id);
    if (!this.pending.size) return Promise.resolve();
    // Un SEUL flush par micro-tâche : le premier ensure le planifie, les suivants du même tick s'y raccrochent.
    if (!this.flushPromise) this.flushPromise = Promise.resolve().then(() => this.flush());
    return this.flushPromise;
  }

  /** Vide le lot en attente en une (ou plusieurs, si > plafond) requête(s) batch, puis met le cache à jour. */
  private async flush(): Promise<void> {
    const ids = [...this.pending];
    this.pending.clear();
    this.flushPromise = null;   // libéré AVANT l'await : un ensure arrivé pendant la requête ouvre un nouveau lot.
    if (!ids.length) return;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += RESOLVE_BATCH_CAP) chunks.push(ids.slice(i, i + RESOLVE_BATCH_CAP));
    try {
      const results = await Promise.all(chunks.map((c) => this.client.resolveUsers(c)));
      for (const users of results) for (const u of users) if (u && u.id) this.cache.set(u.id, u);
    } catch (_) {
      /* échec réseau : rien mis en cache → display() reste sur l'id brut ; un ensure ultérieur réessaiera. */
    }
  }
}
