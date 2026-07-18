import { Logger } from "../logger.js";
import type { ProfileSink, RawUserProfile, ResolvedUser, UserResolver } from "./UserResolver.js";
import type { UsersDb } from "./UsersDb.js";
import { UserProfiles } from "./UserProfiles.js";

/* =============================================================================
   AuthCacheUserResolver — implémentation v1 de l'annuaire (SANS connexion sortante).

   ÉTAT = un cache mémoire `Map<idCanonique, ResolvedUser>` qui EST la source de
   vérité des résolutions, RÉHYDRATÉ au boot depuis le snapshot `users.db`. Il est
   alimenté par CAPTURE : Auth pousse chaque profil authentifié via `remember`
   (ProfileSink injecté — Auth ignore cette classe, principe n°2).

   PERSISTANCE THROTTLÉE : on ne réécrit le snapshot que si le profil a CHANGÉ ou si
   le dernier écrit remonte à plus de `SNAPSHOT_REFRESH_MS` — sinon un mode dev/basic
   (qui rappelle `remember` à CHAQUE requête, faute de cache par jeton côté Auth)
   martèlerait la base. En SSO, Auth ne capture que sur défaut de cache jeton, donc la
   fréquence est déjà basse.

   RÉSOLUTION : id connu → son profil ; id inconnu → dummy (id conservé, champs vides).
   `resolve` est asynchrone PAR CONTRAT (l'impl SSO future fera un appel réseau) même
   si cette impl répond en mémoire.
   ============================================================================= */

export class AuthCacheUserResolver implements UserResolver, ProfileSink {
  /** Délai minimal entre deux réécritures du snapshot d'un MÊME profil INCHANGÉ (6 h) : borne la
      fréquence d'écriture en mode dev/basic sans jamais perdre un changement (un profil MODIFIÉ est
      écrit immédiatement). Rafraîchir `updated_date` périodiquement garde le snapshot « vivant ». */
  static readonly SNAPSHOT_REFRESH_MS = 6 * 3600 * 1000;

  /** Cache mémoire = état autoritatif des résolutions (réhydraté du snapshot au boot). */
  private readonly cache = new Map<string, ResolvedUser>();
  /** Dernier instant d'écriture snapshot par id (throttle), en epoch ms. */
  private readonly lastSnapshotAt = new Map<string, number>();

  /** @param db  Snapshot persistant, ou `null` (annuaire en mémoire seule — users.db indisponible). */
  constructor(private readonly db: UsersDb | null, private readonly log: Logger = new Logger("error")) {
    if (this.db) {
      const seen = this.db.loadAll();
      for (const profile of seen) this.cache.set(profile.id, profile);
      this.log.info("users: annuaire réhydraté depuis le snapshot", seen.length + " profil(s)");
    }
  }

  /** Capture (ProfileSink) : normalise le profil authentifié et le mémorise comme « dernier vu ».
      Ne mémorise RIEN si la clé canonique est vide (ni id ni login). Écriture snapshot throttlée. */
  remember(user: RawUserProfile): void {
    const profile = UserProfiles.fromSsoUser(user);
    if (profile.id === "") return;                       // aucune clé stable → rien à mémoriser
    const previous = this.cache.get(profile.id);
    this.cache.set(profile.id, profile);
    if (!this.db) return;                                // mémoire seule (pas de snapshot)
    const changed = !previous || !AuthCacheUserResolver.sameProfile(previous, profile);
    const sinceLast = Date.now() - (this.lastSnapshotAt.get(profile.id) || 0);
    if (!changed && sinceLast < AuthCacheUserResolver.SNAPSHOT_REFRESH_MS) return;   // throttle : rien de neuf, écrit récemment
    try {
      this.db.upsert(profile);
      this.lastSnapshotAt.set(profile.id, Date.now());
    } catch (e) {
      // Le snapshot est un CONFORT (réhydratation) : son échec ne doit pas casser une authentification.
      // Le cache mémoire reste correct ; on journalise et on continue.
      this.log.warn("users: échec d'écriture du snapshot", profile.id, e instanceof Error ? e.message : String(e));
    }
  }

  /** Résolution BATCH : correspondance positionnelle (ordre préservé). Id inconnu → dummy. */
  async resolve(ids: string[]): Promise<ResolvedUser[]> {
    return ids.map((id) => this.cache.get(id) || UserProfiles.dummy(id));
  }

  /** Deux profils portent-ils les mêmes champs affichables ? (l'id est la clé, comparé en amont.) */
  private static sameProfile(a: ResolvedUser, b: ResolvedUser): boolean {
    return a.login === b.login && a.domain === b.domain && a.firstname === b.firstname
      && a.lastname === b.lastname && a.email === b.email && a.phone === b.phone;
  }
}
