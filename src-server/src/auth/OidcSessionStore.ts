import { randomBytes } from "node:crypto";

/* =============================================================================
   MODE OIDC — SESSIONS EN MÉMOIRE (responsabilité 1/3 du mode).

   Après le flux d'autorisation, l'application n'a plus besoin de l'OP à chaque
   requête : elle a une identité VALIDÉE, et lui associe une session locale dont
   l'identifiant vit dans un cookie. Ce fichier tient cette table, et rien
   d'autre — ni HTTP, ni cookie, ni protocole : il ne connaît que des
   revendications, une échéance, et une horloge.

   ── 🚨 LIMITE ASSUMÉE v1 : un REDÉMARRAGE DÉCONNECTE TOUT LE MONDE ────────
   La table est en mémoire du processus. C'est une décision, pas un oubli.
   Persister exigerait d'écrire sur disque des `id_token` — des porteurs
   d'identité — ce qui demanderait un chiffrement au repos, donc une clé
   (`DCMANAGER_SECRETS_KEY`), donc une base dédiée, sa migration et son cycle de
   vie : un chantier entier pour une gêne dont le coût réel est un aller-retour
   vers l'IdP, généralement INVISIBLE (la session de l'OP, elle, survit, et le
   navigateur revient authentifié sans rien retaper). On préfère simple et juste
   à complet et fragile. Documenté dans docs/auth.md § OIDC.

   Corollaire à connaître avant de déployer PLUSIEURS instances : sans session
   partagée, deux répliques derrière un répartiteur ne se reconnaissent pas
   l'une l'autre — il faut des sessions collantes, ou le mode `forward` (dont le
   proxy porte la session). Dit dans la doc, parce que ça ne se devine pas.

   ── Trois protections, et pourquoi CHACUNE ────────────────────────────────
   1. IDENTIFIANT ALÉATOIRE FORT (32 octets de `randomBytes`, en base64url) :
      c'est un porteur d'identité, il doit être impossible à deviner. Pas de
      compteur, pas d'UUID v4 (122 bits d'un générateur non garanti
      cryptographique selon les implémentations) — 256 bits d'aléa CSPRNG.
   2. TTL : une session ne vit pas plus longtemps que ce que l'OP a annoncé, et
      jamais plus que `DEFAULT_TTL_MS` — un OP qui délivrerait un `id_token`
      valable un an ne doit pas nous faire tenir une session un an.
   3. PLAFOND : une table de sessions est alimentée par des ANONYMES (n'importe
      qui peut lancer un flux de connexion). Sans plafond, c'est une fuite
      mémoire offerte. Au-delà, on purge l'expiré puis, s'il le faut, on évince
      les PLUS PROCHES DE L'ÉCHÉANCE — la victime est celle qui allait partir.

   `nowMs` est INJECTABLE : sans horloge injectée, « la session expire-t-elle
   vraiment ? » ne se teste qu'en attendant réellement — donc ne se teste pas.
   Même patron que les veilleurs du dépôt (cf. `certs/CertExpiryWatcher`).
   ============================================================================= */

/** Ce qu'une session RETIENT. Volontairement pauvre : les revendications validées, l'échéance, et
    de quoi se déconnecter proprement chez l'OP. */
export interface OidcSessionRecord<Claims = unknown> {
  /** Revendications de l'`id_token`, telles que la librairie les a validées. */
  claims: Claims;
  /** Échéance ABSOLUE, en millisecondes epoch (unité de `Date.now()`). */
  expiresAt: number;
  /** `id_token` brut — conservé pour le SEUL `id_token_hint` de la déconnexion RP-initiated.
      Sans lui, un OP comme Keycloak affiche une page de confirmation au lieu de déconnecter. */
  idToken?: string;
  /** Jeton de rafraîchissement. 🚨 NON ALIMENTÉ en v1 : le rafraîchissement au fil de l'eau n'est
      pas livré (arbitrage documenté — cf. docs/auth.md § OIDC « Ce que la v1 ne fait pas »), et
      conserver un secret dont personne ne se sert n'ajouterait qu'une surface d'exposition. Le
      champ EXISTE parce qu'il est la couture prévue : le jour où le rafraîchissement s'écrit, il
      vit ici, et le contrat du store n'aura pas à bouger. */
  refreshToken?: string;
}

export class OidcSessionStore<Claims = unknown> {
  /** Durée de vie MAXIMALE d'une session, et durée par défaut quand l'OP n'annonce rien.
      12 h : une journée de travail sans re-login, en deçà des durées où un jeton oublié sur un
      poste partagé devient un vrai risque. Constante de CODE, délibérément : le lot n'ouvre pas
      une septième variable d'environnement pour un réglage que personne n'a demandé. */
  static readonly DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

  /** Plafond d'entrées (cf. l'en-tête, protection 3). 10 000 sessions = un parc largement au-delà
      de la cible de l'application, pour quelques mégaoctets. */
  static readonly DEFAULT_MAX_ENTRIES = 10_000;

  /** Octets d'aléa de l'identifiant de session (256 bits). */
  static readonly ID_BYTES = 32;

  private readonly sessions = new Map<string, OidcSessionRecord<Claims>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowMs: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; nowMs?: () => number } = {}) {
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : OidcSessionStore.DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : OidcSessionStore.DEFAULT_MAX_ENTRIES;
    this.nowMs = opts.nowMs || Date.now;
  }

  /** Crée une session et rend son IDENTIFIANT (la valeur qui ira dans le cookie).

      L'échéance demandée est BORNÉE des deux côtés : jamais dans le passé (une session déjà morte
      à la naissance ferait boucler le client entre login et 401), jamais au-delà de `ttlMs`. Une
      échéance absente ou absurde retombe sur le TTL — on ne fait pas confiance à un OP pour ne
      jamais annoncer n'importe quoi. */
  create(record: { claims: Claims; expiresAt?: number; idToken?: string; refreshToken?: string }): string {
    const now = this.nowMs();
    const id = randomBytes(OidcSessionStore.ID_BYTES).toString("base64url");
    this.sessions.set(id, {
      claims: record.claims,
      expiresAt: this.boundedExpiry(record.expiresAt, now),
      idToken: record.idToken,
      refreshToken: record.refreshToken,
    });
    this.enforceCapacity(now);
    return id;
  }

  /** Session VIVANTE portant cet identifiant, ou `null`.

      Une entrée EXPIRÉE est supprimée au passage plutôt que simplement ignorée : c'est la purge la
      moins chère qui soit (elle suit l'usage réel), et elle garantit qu'un identifiant révoqué par
      le temps ne réapparaît jamais. `null` couvre les trois cas — absent, inconnu, expiré — que
      l'appelant traite de façon identique (appelant anonyme). */
  get(id: string | null | undefined): OidcSessionRecord<Claims> | null {
    if (!id) return null;
    const found = this.sessions.get(id);
    if (!found) return null;
    if (this.nowMs() >= found.expiresAt) { this.sessions.delete(id); return null; }
    return found;
  }

  /** Détruit une session (déconnexion). Rend l'enregistrement supprimé — la route de déconnexion en
      a besoin pour l'`id_token_hint` — ou `null` s'il n'y avait rien. */
  destroy(id: string | null | undefined): OidcSessionRecord<Claims> | null {
    if (!id) return null;
    const found = this.sessions.get(id) || null;
    this.sessions.delete(id);
    return found;
  }

  /** Nombre de sessions RETENUES (expirées comprises tant qu'elles n'ont pas été balayées) —
      sert la supervision et les tests. */
  get size(): number { return this.sessions.size; }

  /** Balaie les sessions expirées. Rend le nombre de suppressions.
      Appelée à chaque création (via le plafond) : il n'y a pas de minuteur, donc rien à arrêter à
      l'extinction — une table qui ne vit que le temps du processus n'a pas besoin de cycle de vie. */
  purgeExpired(now: number = this.nowMs()): number {
    let removed = 0;
    for (const [id, record] of this.sessions) if (now >= record.expiresAt) { this.sessions.delete(id); removed++; }
    return removed;
  }

  /** Fait respecter le plafond : purge de l'expiré d'abord (gratuit et juste), éviction des plus
      proches de l'échéance ensuite (choix le moins nuisible : on retire ce qui allait partir). */
  private enforceCapacity(now: number): void {
    if (this.sessions.size <= this.maxEntries) return;
    this.purgeExpired(now);
    if (this.sessions.size <= this.maxEntries) return;
    const byExpiry = [...this.sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [id] of byExpiry.slice(0, this.sessions.size - this.maxEntries)) this.sessions.delete(id);
  }

  /** Échéance retenue : celle de l'OP si elle est future et dans la fenêtre, le TTL sinon. */
  private boundedExpiry(asked: number | undefined, now: number): number {
    const ceiling = now + this.ttlMs;
    if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= now) return ceiling;
    return Math.min(asked, ceiling);
  }
}
