import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import { RolesConfig, type ParsedRolesConfig } from "./RolesConfig.js";
import type { AccessIdentity, RoleProvider } from "./RoleProvider.js";

/* =============================================================================
   POLITIQUE DE RÔLES SUR FICHIER (`roles.json`) — implémentation v1 du
   `RoleProvider`.

   Un fichier JSON à côté des documents, relu À CHAUD. C'est délibérément le
   support le plus simple qui soit : la politique d'un déploiement auto-hébergé
   tient en quelques lignes, et un fichier se sauvegarde, se versionne et se
   corrige sans base ni écran d'administration.

       {
         "users":  { "jdupont": ["dc-editor"], "42": ["cert-manager"] },
         "groups": { "grp-infra": ["dc-editor"] },     // GROUPES de l'IdP (mode forward, OIDC)
         "roles":  { "cabliste-nuit": ["dc.cabling:*", "dc.rack:read"] }
       }

   La table `groups` est ce qui rend forward-auth (et demain OIDC) PAYANT : la
   gestion des personnes retourne dans l'IdP, et ce fichier ne décrit plus que
   la traduction « groupe d'entreprise → rôle applicatif ». Un nouvel arrivant
   du bon groupe a ses droits sans qu'on touche à `roles.json`.

   ── FAIL-CLOSED, sans exception ───────────────────────────────────────────
   Fichier absent, illisible, JSON invalide : PERSONNE n'a de rôle. Jamais de
   repli ouvert « le temps de réparer » — c'est précisément au moment où la
   configuration est cassée qu'un repli permissif serait exploité. La seule
   porte laissée ouverte est EXPLICITE et vient de l'environnement
   (`BOOTSTRAP_ADMIN_IDS`), car un déploiement neuf doit pouvoir se configurer :
   sans elle, le premier administrateur serait verrouillé dehors par la règle
   même qu'il doit écrire.

   ── Nuance : ABSENT n'est pas ILLISIBLE ───────────────────────────────────
   Deux échecs qui se ressemblent, deux traitements :
   - fichier ABSENT (ou supprimé à chaud) → état parfaitement défini
     (« aucune politique »), on l'ADOPTE : politique vide, génération
     incrémentée, avertissement. C'est aussi l'état d'un déploiement neuf.
   - fichier PRÉSENT mais ILLISIBLE (JSON tronqué en cours d'édition, droits
     retirés) → on ne sait PAS ce que l'exploitant voulait : on CONSERVE la
     dernière politique valide et on crie en ERROR. Écraser la politique en
     cours par du vide sur une faute de frappe déconnecterait toute l'équipe.
     Au TOUT PREMIER chargement, il n'y a pas de « dernière valide » : c'est
     alors la politique vide qui s'applique (fail-closed).

   ── Rechargement à chaud : pourquoi un SONDAGE ────────────────────────────
   `fs.watchFile` (sondage) plutôt que `fs.watch` (événements) : le fichier vit
   dans `DOCS_DIR`, dossier très bruyant (les `-wal`/`-shm` SQLite y changent en
   permanence) et il est souvent remplacé par RENOMMAGE — deux cas où
   `fs.watch` sur un descripteur soit noie le signal, soit le perd
   définitivement. Le sondage voit indifféremment création, modification et
   suppression, ne jette pas quand la cible n'existe pas, et se comporte
   pareil sous Windows, Linux et dans un conteneur. Le coût est un `stat`
   toutes les 2 s. `persistent: false` : la veille ne retient jamais l'arrêt du
   process (même discipline que les `unref` des timers des modules).

   Chaque rechargement RÉUSSI incrémente la GÉNÉRATION, seul signal
   d'invalidation du cache de permissions d'`AccessControl` (sans quoi une
   session déjà vue garderait ses droits d'avant l'édition).

   ── Rétrocompatibilité (elle vit ICI, et c'est voulu) ─────────────────────
   Elle est une POLITIQUE, pas une propriété de l'authentification : ces deux
   règles rendent un déploiement existant strictement identique à lui-même.
   - modes `dev` / `basic` (`SsoResult.dev`) → `admin`. Ces modes n'ont jamais
     authentifié personne : tout appelant y était déjà SUPER_ADMIN, le WARN de
     démarrage le crie depuis toujours (`auth.ts`).
   - SSO maison `adminRight === "SUPER_ADMIN"` → `admin`. C'était l'UNIQUE
     droit d'accès de l'application ; le retirer aurait fermé la porte à tous
     les utilisateurs actuels au premier déploiement de l'ACL.
   Les AUTRES valeurs d'`adminRight` ne donnent rien : opt-in strict. Un
   utilisateur SSO valide mais non déclaré voit `/me` et rien d'autre.
   ============================================================================= */

export class FileRoleProvider implements RoleProvider {
  /** Chemin du fichier de politique. Défaut : `<DOCS_DIR>/roles.json`. */
  static readonly ENV_FILE = "ROLES_FILE";
  /** Ids canoniques ou logins (séparés par des virgules) promus `admin` — amorçage d'un déploiement. */
  static readonly ENV_BOOTSTRAP = "BOOTSTRAP_ADMIN_IDS";
  /** Nom par défaut du fichier, dans le dossier des documents. */
  static readonly DEFAULT_FILE = "roles.json";
  /** Période du sondage de rechargement (cf. l'en-tête : sondage assumé, 2 s suffit largement). */
  static readonly POLL_INTERVAL_MS = 2000;
  /** Anti-rebond : une écriture en deux temps (troncature puis contenu) ne doit pas faire lire un
      fichier à moitié écrit. Court — le sondage a déjà lissé l'essentiel. */
  static readonly RELOAD_DEBOUNCE_MS = 150;

  private config: ParsedRolesConfig = RolesConfig.empty();
  /** Incrémentée à chaque ADOPTION d'une politique (chargement initial compris). */
  private gen = 0;
  /** Une politique valide a-t-elle DÉJÀ été adoptée ? Décide du sort d'un fichier illisible. */
  private everLoaded = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private watching = false;

  constructor(
    /** Chemin ABSOLU (ou relatif au cwd) du fichier de politique. */
    private readonly filePath: string,
    /** Ids/logins d'amorçage, déjà découpés et nettoyés. */
    private readonly bootstrapAdmins: readonly string[],
    private readonly log: Logger = new Logger("error", "access"),
  ) {
    this.load();
  }

  /** Fabrique depuis l'environnement — `ROLES_FILE`, sinon `<docsDir>/roles.json`. */
  static fromEnv(env: NodeJS.ProcessEnv, docsDir: string, log?: Logger): FileRoleProvider {
    const configured = String(env[FileRoleProvider.ENV_FILE] || "").trim();
    const filePath = configured !== "" ? configured : path.join(docsDir, FileRoleProvider.DEFAULT_FILE);
    return new FileRoleProvider(filePath, FileRoleProvider.parseBootstrap(env[FileRoleProvider.ENV_BOOTSTRAP]), log);
  }

  /** Découpe de `BOOTSTRAP_ADMIN_IDS` : virgules, espaces rognés, vides écartés, doublons fondus. */
  static parseBootstrap(raw: unknown): string[] {
    return [...new Set(String(raw == null ? "" : raw).split(",").map((v) => v.trim()).filter((v) => v !== ""))];
  }

  /** Cette identité est-elle amorcée administrateur ? Comparaison EXACTE sur l'id canonique OU le
      login (cf. `RolesConfig.rolesFor` : aucune normalisation implicite). */
  private isBootstrapAdmin(identity: AccessIdentity): boolean {
    return this.bootstrapAdmins.some((key) => key === identity.id || key === identity.login);
  }

  /** Rôles de cette identité : politique du fichier + amorçage + rétrocompatibilité (cf. l'en-tête).
      Asynchrone par CONTRAT seulement — la réponse est un accès mémoire, aucune E/S sur le chemin
      chaud d'une requête (le fichier n'est relu que sur signal du sondage). */
  async rolesOf(identity: AccessIdentity): Promise<string[]> {
    // Les GROUPES de l'identité (mode forward, OIDC demain) traversent jusqu'à la table `groups` du
    // fichier : c'est la seule ligne qui a changé au lot 4 côté provider — la v2 de la politique est
    // entièrement dans l'analyse (`RolesConfig`), pas ici.
    const roles = new Set<string>(RolesConfig.rolesFor(this.config, identity.id, identity.login, identity.groups));
    if (this.isBootstrapAdmin(identity)) roles.add("admin");
    if (identity.dev) roles.add("admin");                          // modes dev/basic : comportement historique
    if (identity.adminRight === "SUPER_ADMIN") roles.add("admin"); // SSO maison : l'unique droit d'avant l'ACL
    return [...roles];
  }

  /** Définition LOCALE d'un rôle (section `roles`). null = non défini ici → preset partagé. */
  grantsOfRole(role: string): readonly string[] | null {
    return this.config.roles.get(role) || null;
  }

  /** Génération courante — change à chaque politique adoptée (invalide le cache d'`AccessControl`). */
  generation(): number { return this.gen; }

  /** Démarre la veille de rechargement. Séparée du constructeur : un test (ou un outil en ligne de
      commande) veut la politique sans laisser un sondage derrière lui. */
  start(): void {
    if (this.watching) return;
    this.watching = true;
    try {
      fs.watchFile(this.filePath, { persistent: false, interval: FileRoleProvider.POLL_INTERVAL_MS }, (curr, prev) => {
        // ⚠ `watchFile` émet un premier événement au démarrage de la veille, même quand RIEN n'a
        // changé — et sur un fichier ABSENT (le cas normal d'un déploiement neuf), cela relancerait
        // un chargement inutile et consommerait une génération à chaque boot. On écarte le SEUL cas
        // strictement inerte, « inexistant hier, inexistant aujourd'hui » (`mtimeMs` nul des deux
        // côtés) : une création, une modification ou une suppression conservent, elles, un mtime non
        // nul d'un côté au moins — aucune ne peut être avalée par cette garde.
        if (curr.mtimeMs === 0 && prev.mtimeMs === 0) return;
        this.scheduleReload();
      });
      this.log.info("veille de la politique de rôles active (sondage " + (FileRoleProvider.POLL_INTERVAL_MS / 1000) + " s)", this.filePath);
    } catch (e) {
      // Une veille impossible n'est PAS fatale : la politique chargée au boot reste en vigueur,
      // simplement le rechargement à chaud est perdu (redémarrage nécessaire). On le dit fort.
      this.watching = false;
      this.log.error("veille de " + this.filePath + " impossible — rechargement à chaud INDISPONIBLE", e instanceof Error ? e.message : String(e));
    }
  }

  /** Arrête la veille (arrêt propre du serveur, ou fin de test). */
  stop(): void {
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    if (!this.watching) return;
    this.watching = false;
    try { fs.unwatchFile(this.filePath); } catch { /* rien à défaire */ }
  }

  /** Rechargement anti-rebondi (cf. `RELOAD_DEBOUNCE_MS`). */
  private scheduleReload(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; this.load(); }, FileRoleProvider.RELOAD_DEBOUNCE_MS);
    (this.debounce as any).unref?.();   // ne retient pas l'arrêt du process (parité `persistent: false`)
  }

  /** Lit, analyse et ADOPTE (ou non) la politique. Ne jette jamais — cf. l'en-tête pour le
      traitement DIFFÉRENCIÉ « absent » / « illisible ». Public pour les tests et un éventuel
      rechargement déclenché à la main. */
  load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException) && (e as NodeJS.ErrnoException).code === "ENOENT";
      if (missing) {
        // État DÉFINI : aucune politique. On l'adopte (opt-in strict) — c'est aussi l'état d'un
        // déploiement neuf, où seul BOOTSTRAP_ADMIN_IDS ouvre la porte.
        this.adopt(RolesConfig.empty(), "aucun fichier de politique (" + this.filePath + ") — personne n'a de rôle" + this.bootstrapHint());
        return;
      }
      this.keepPrevious("lecture impossible de " + this.filePath, e);
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch (e) {
      this.keepPrevious("JSON invalide dans " + this.filePath, e);
      return;
    }
    const parsed = RolesConfig.parse(document);
    for (const warning of parsed.warnings) this.log.warn("roles.json —", warning);
    this.adopt(parsed, "politique de rôles chargée (" + parsed.users.size + " utilisateur(s), " + parsed.groups.size + " groupe(s), " + parsed.roles.size + " rôle(s) custom)");
  }

  /** Adopte une politique : elle devient la courante et la GÉNÉRATION change (invalidation du cache). */
  private adopt(config: ParsedRolesConfig, message: string): void {
    this.config = config;
    this.everLoaded = true;
    this.gen++;
    this.log.info(message);
  }

  /** Échec AMBIGU : on garde la dernière politique valide (ou la politique vide au tout premier
      chargement). Aucune génération consommée — rien n'a changé du point de vue des permissions. */
  private keepPrevious(what: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    if (!this.everLoaded) {
      this.config = RolesConfig.empty();
      this.everLoaded = true;
      this.gen++;
      this.log.error(what + " — politique VIDE appliquée (fail-closed)" + this.bootstrapHint(), detail);
      return;
    }
    this.log.error(what + " — la DERNIÈRE politique valide reste en vigueur", detail);
  }

  /** Rappel actionnable quand plus personne ne peut entrer par le fichier. */
  private bootstrapHint(): string {
    return this.bootstrapAdmins.length
      ? " ; " + this.bootstrapAdmins.length + " administrateur(s) d'amorçage (" + FileRoleProvider.ENV_BOOTSTRAP + ")"
      : " ; définir " + FileRoleProvider.ENV_BOOTSTRAP + " pour amorcer un administrateur";
  }
}
