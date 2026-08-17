/* =============================================================================
   AUTHENTIFICATION — CONTRAT (service CORE, PAS un module amovible).

   L'AUTHENTIFICATION dit QUI est l'appelant ; l'AUTORISATION dit CE QU'IL PEUT.
   Ce fichier tient la PREMIÈRE moitié de la frontière (la seconde est
   `access/RoleProvider`) : un `AuthProvider` sait établir une identité à partir
   d'une requête, et ignore tout de ce que cette identité aura le droit de faire.

   INTERFACE-DRIVEN (principe n°2), sur le patron canonique de `UserResolver` et
   de `RoleProvider` : le consommateur — l'orchestrateur `Auth` (`../auth.ts`) —
   ne dépend QUE de ce contrat ; l'implémentation est SÉLECTIONNÉE au boot.
   - `DevAuthProvider` : aucun contrôle, tout appelant est SUPER_ADMIN (défaut).
   - `BasicAuthProvider` : challenge HTTP Basic (déploiement de dépannage).
   - `LegacySsoAuthProvider` : le contrat SSO maison (cookie proxifié).
   - `ForwardHeaderAuthProvider` : en-têtes d'un reverse-proxy *identity-aware*
     (Authelia, Authentik, oauth2-proxy, Cloudflare Access, Tailscale…).
   - à venir : provider OIDC. Le contrat ne bouge pas — c'est tout l'intérêt de
     l'avoir posé (le provider d'en-têtes n'a demandé qu'UN élargissement
     délibéré de `AuthRequestView`, cf. plus bas).

   ── Pourquoi ce fichier n'importe PAS Express ─────────────────────────────
   Il déclare sa propre vue MINIMALE de la requête (`AuthRequestView`), dont le
   `Request` d'Express est un sur-ensemble STRUCTUREL : un provider reste donc
   utilisable tel quel dans le serveur, sans qu'Express entre ici. Même doctrine
   qu'`AccessRequest` (cf. `access/AccessControl`), et mêmes bénéfices : les
   providers deviennent TESTABLES sans monter de serveur, et ils ne dépendent pas
   d'une VERSION d'Express (le programme de test du dépôt n'en résout pas la même
   que le serveur).

   Ce fichier n'a AUCUN import → il reste compilable en isolation et n'entraîne
   aucune dépendance chez ses consommateurs.
   ============================================================================= */

/** Utilisateur tel que rendu par l'authentification. Les noms de champs suivent la convention
    du SSO maison (`nom`/`prenom`/`eMail`) — c'est la forme HISTORIQUE, conservée parce que le
    client et l'annuaire la consomment déjà (cf. `users/UserResolver.RawUserProfile`, qui en est
    un sous-ensemble structurel). L'index de signature autorise le PASSTHROUGH : un SSO qui
    renvoie des champs que nous ne connaissons pas les voit traverser jusqu'à `/me`. */
export interface SsoUser { id?: number; login?: string; nom?: string; prenom?: string; eMail?: string; domain?: string; [k: string]: any }

/** SESSION authentifiée — le « principal » de l'application, et le SEUL modèle d'identité.

    On n'entretient PAS un second type parallèle : `/me` en fait un passthrough additif, le client
    le consomme tel quel, et le contrôle d'accès en voit un sous-ensemble structurel qu'il déclare
    chez lui (`AccessControl.AccessSession`). Un doublon « normalisé » n'apporterait qu'une
    conversion de plus à tenir à jour des deux côtés.

    ⚠ Ce contrat répond à l'origine à un BESOIN PERSONNEL (endpoint SSO renvoyant
    `{ logged, adminRight, expireDate }`) : `adminRight` reste donc le vocabulaire du SSO maison,
    et l'autorisation ne s'en sert plus que comme d'une RÈGLE DE RÉTROCOMPATIBILITÉ
    (`SUPER_ADMIN` → rôle `admin`, cf. `access/FileRoleProvider` et docs/auth.md). */
export interface SsoResult {
  user?: SsoUser;
  logged: boolean;
  adminRight?: string;
  expireDate?: number;
  /** Session issue d'un mode SANS authentification réelle (dev / basic). */
  dev?: boolean;
  /** GROUPES bruts de l'annuaire d'entreprise, tels que l'IdP les fournit — jamais calculés par
      l'application. RENSEIGNÉ par `ForwardHeaderAuthProvider` (en-tête de groupes du proxy) et par
      le passthrough du SSO maison quand celui-ci en renvoie ; absent des modes dev et basic, qui
      n'ont pas d'annuaire. La politique de rôles les mappe vers des rôles (table `groups` de
      `roles.json`, cf. `access/RolesConfig` et docs/auth.md § 5) — sans que le type de session ni
      le contrat aient eu à bouger, ce qui était précisément l'intention de sa déclaration. */
  groups?: string[];
  [k: string]: any;
}

/** SESSION ANONYME — la valeur que l'orchestrateur substitue au `null` du contrat.

    Elle est déclarée ICI, avec le type qu'elle habite, parce que DEUX endroits en ont besoin et
    qu'une seconde définition serait une duplication silencieuse (principe n°3) : l'orchestrateur
    (`Auth`, pour tout provider qui rend `null`) et le provider SSO (dont le repli d'un SSO
    injoignable est précisément « anonyme »). C'est une DONNÉE — un simple export, comme le veut
    le principe n°2 — et elle ne casse pas la compilation en isolation de ce fichier.

    ⚠ Objet PARTAGÉ, jamais muté : `/me` en fait une COPIE (`{ ...session }`) avant d'y ajouter
    les permissions, et rien d'autre n'écrit dans une session. */
export const ANONYMOUS_SESSION: SsoResult = { user: { login: "anonymous", domain: "anonymous" }, logged: false, adminRight: "NONE" };

/** Vue MINIMALE d'une requête HTTP pour l'authentification : les en-têtes qui PORTENT une
    session, et rien d'autre. Le `Request` d'Express en est un sur-ensemble structurel.

    Volontairement pauvre : un provider qui aurait besoin d'autre chose (chemin, corps, IP)
    signalerait qu'il fait plus que « lire l'identité présentée » — on préfère que l'ajout soit
    un geste DÉLIBÉRÉ sur ce contrat plutôt qu'une dérive invisible.

    ── ÉLARGISSEMENT DÉLIBÉRÉ (mode forward) ──────────────────────────────────────────────────
    L'index de signature a été ajouté pour `ForwardHeaderAuthProvider`, dont l'identité vit dans
    des en-têtes **dont les noms sont configurables** (`Remote-User` par défaut, mais l'exploitant
    les renomme pour oauth2-proxy ou Tailscale) : ils ne peuvent donc pas être énumérés ici. C'est
    exactement le geste que le paragraphe ci-dessus réclamait — explicite, motivé, et borné aux
    en-têtes (le contrat ne voit toujours ni chemin, ni corps, ni IP). `IncomingHttpHeaders` de Node
    (donc le `Request` d'Express) reste un sur-ensemble structurel de cette forme.

    ⚠ `string[]` n'est pas une coquetterie de typage : un en-tête RÉPÉTÉ arrive en tableau côté
    Node. Un provider doit donc normaliser (première valeur) — en UN point, cf.
    `ForwardHeaderAuthProvider.headerValue`. */
export interface AuthRequestView {
  headers: {
    /** En-tête `Cookie` COMPLET, tel que reçu (le découpage par nom de cookie appartient au provider). */
    cookie?: string;
    /** En-tête `Authorization` (`Basic …`, `Bearer …`). */
    authorization?: string;
    /** Tout autre en-tête, lu par NOM CONFIGURÉ (mode forward). Clés en minuscules côté Node. */
    [name: string]: string | string[] | undefined;
  };
}

/** Un mode d'authentification, vu par l'orchestrateur. */
export interface AuthProvider {
  /** Identifie l'appelant. `null` = anonyme (aucune session présentée, ou session refusée) —
      l'orchestrateur y substitue `ANONYMOUS_SESSION`. Une session RENDUE peut elle-même être
      non authentifiée (`logged: false`) : c'est le cas d'un annuaire distant injoignable, où le
      provider a une réponse à donner mais pas d'identité. */
  authenticate(req: AuthRequestView): Promise<SsoResult | null>;

  /** Clé de CACHE de la session présentée — typiquement le JETON brut (l'orchestrateur le hache
      avant d'en faire une clé de table : un secret ne devient pas un identifiant en clair).
      `null` = rien de présenté, donc rien à mémoriser.

      OPTIONNEL, et c'est le point : un provider qui n'implémente PAS cette méthode n'est jamais
      mis en cache — ce qui est exactement ce qu'on veut des modes `dev` et `basic`, qui répondent
      de mémoire, sans le moindre appel sortant. Le cache n'existe que pour ÉVITER UN APPEL RÉSEAU
      par requête HTTP ; le proposer là où il n'y a pas d'appel n'ajouterait qu'une fenêtre pendant
      laquelle une identité révoquée resterait valide. Même forme optionnelle que
      `RoleProvider.generation`/`grantsOfRole`. */
  sessionKey?(req: AuthRequestView): string | null;
}
