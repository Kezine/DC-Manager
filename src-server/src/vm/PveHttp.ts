import https from "node:https";
import type { PeerCertificate } from "node:tls";

/* =============================================================================
   CLIENT HTTPS PROXMOX — brique d'accès réseau du module `vm/` (amovible).
   Auth par JETON d'API (en-tête `Authorization: PVEAPIToken=…`, aucune session/
   cookie) et gestion des certificats AUTO-SIGNÉS fréquents sur les clusters
   Proxmox — pas de désactivation aveugle de la validation TLS.

   HIÉRARCHIE DE CONFIANCE, décidée PAR ENDPOINT (cf. PveHttp.trustOptions,
   statique et pure) — du plus spécifique au plus général :
   1. fingerprint de l'endpoint FOURNI → ÉPINGLAGE : la validation CA est
      remplacée par la comparaison STRICTE de l'empreinte SHA-256 présentée
      (mismatch = échec du handshake). Modèle de confiance de Proxmox lui-même
      (l'UI affiche l'empreinte à épingler) — le plus spécifique, prioritaire.
   2. sinon ca_pem du provider FOURNI → validation TLS par CETTE CA de cluster
      (`rejectUnauthorized: true` + option `ca`). La CA du cluster
      (`pve-root-ca.pem`) émet le certificat de chaque nœud : UNE valeur pour
      tout le pool, qui survit aux régénérations (`pvecm updatecerts`).
      ⚠ Le nom d'hôte de l'URL doit alors correspondre au CN/SAN du certificat
      du nœud (sinon ERR_TLS_CERT_ALTNAME_INVALID — expliqué par explainNetworkError).
   3. sinon → validation TLS STANDARD par les CA système. Jamais de « accepter tout ».

   SÉCURITÉ (invariants de ce fichier) :
   - jamais de désactivation aveugle de la validation (« accepter tout ») ;
   - le jeton n'apparaît JAMAIS dans les messages d'erreur ni les logs
     (un certificat CA, lui, est PUBLIC — pas un secret).
   ============================================================================= */

/** Erreur d'accès à l'API Proxmox, TYPÉE pour la bascule de nœud (PveHttpPool) :
    - `retryable: true`  → défaillance de JOIGNABILITÉ de CE nœud (réseau, délai,
      TLS/épinglage) : un autre nœud du pool peut réussir → bascule pertinente ;
    - `retryable: false` → le nœud a RÉPONDU (authentification refusée, statut HTTP,
      corps non-JSON) : l'erreur est applicative/cluster-wide, un autre nœud
      échouerait à l'identique → basculer ne ferait que masquer le vrai problème. */
export class PveHttpError extends Error {
  constructor(message: string, readonly retryable: boolean, cause?: unknown) {
    super(message);
    this.name = "PveHttpError";
    // Cause CONSERVÉE (pile d'origine comprise) : indispensable au diagnostic des erreurs
    // internes de Node (ERR_INTERNAL_ASSERTION…) dont le `message` seul ne dit rien.
    // Posée à la main plutôt que via `new Error(msg, { cause })` — indépendant du lib target TS.
    if (cause !== undefined) (this as any).cause = cause;
  }

  /** Pile COMPLÈTE pour les logs : la nôtre + celle de la cause d'origine si présente. */
  fullStack(): string {
    const own = this.stack || this.message;
    const cause = (this as any).cause;
    return cause instanceof Error && cause.stack ? own + "\n  cause : " + cause.stack : own;
  }
}

export class PveHttp {
  constructor(
    private readonly baseUrl: string,          // ex. "https://pve.example.lan:8006"
    private readonly token: string,            // "USER@REALM!TOKENID=UUID"
    private readonly fingerprint: string | null,
    private readonly timeoutMs = 15_000,
    // CA du cluster (PEM), NIVEAU 2 de la hiérarchie de confiance — optionnel EN DERNIER pour ne
    // pas casser les appels existants. Ignoré si l'endpoint a une empreinte (l'épinglage prime).
    private readonly caPem: string | null = null,
  ) {}

  /** Empreinte normalisée pour comparaison : hex minuscule sans séparateurs
      (Proxmox affiche « AA:BB:… », Node fournit `fingerprint256` au même format). */
  private static normFp(fp: string): string { return fp.replace(/[^0-9a-fA-F]/g, "").toLowerCase(); }

  /** Fragment d'options TLS de `https.request` traduisant la HIÉRARCHIE DE CONFIANCE (par endpoint) :
      1. `pinnedFp` fourni → ÉPINGLAGE : `rejectUnauthorized: false` (le certificat auto-signé n'a pas
         de chaîne CA valide) MAIS `checkServerIdentity` impose l'empreinte exacte — plus strict qu'une CA ;
      2. sinon `caPem` fourni → validation par CETTE CA de cluster (`rejectUnauthorized: true` + `ca`) ;
      3. sinon → validation par les CA système (`rejectUnauthorized: true`).
      Statique et PURE → testable sans réseau.

      ⚠ Les clés `checkServerIdentity`/`ca` ne sont posées QUE dans leur branche : un `undefined`
      EXPLICITE de `checkServerIdentity` écraserait le défaut de Node dans son spread d'options
      (`{ checkServerIdentity: tls.checkServerIdentity, ...options }`) et ferait échouer la validation
      interne de tls.connect — ERR_INTERNAL_ASSERTION opaque en Node 20, ERR_INVALID_ARG_TYPE en 24
      (bug constaté en prod le 2026-07-13, reproduit hors ligne sur les deux versions). D'où un
      fragment dont la clé est ABSENTE hors épinglage, plutôt que posée à `undefined`. */
  static trustOptions(pinnedFp: string | null, caPem: string | null): {
    rejectUnauthorized: boolean;
    ca?: string;
    checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined;
  } {
    // 1. ÉPINGLAGE (le plus spécifique) : l'empreinte prime sur tout — y compris une CA fournie.
    const pinned = pinnedFp ? PveHttp.normFp(pinnedFp) : null;
    if (pinned) {
      return {
        rejectUnauthorized: false,
        checkServerIdentity: (_host: string, cert: PeerCertificate) => {
          const got = PveHttp.normFp(cert.fingerprint256 || "");
          return got === pinned ? undefined
            : new Error("Empreinte TLS inattendue (" + (cert.fingerprint256 || "?") + ") — épinglage refusé");
        },
      };
    }
    // 2. CA du cluster : valide la chaîne CONTRE cette CA (le nom d'hôte doit couvrir le nœud).
    if (caPem) return { rejectUnauthorized: true, ca: caPem };
    // 3. CA système (comportement historique).
    return { rejectUnauthorized: true };
  }

  /** Explications ACTIONNABLES des codes d'erreur réseau/TLS les plus fréquents en pratique :
      le `message` brut de Node (« unable to verify the first certificate »…) est technique et
      anglophone — l'UTILISATEUR du statut de synchro doit comprendre QUOI FAIRE. Le message
      technique d'origine est conservé à la suite (diagnostic), la cible est toujours citée. */
  private static readonly ERROR_EXPLANATIONS: { [code: string]: string } = {
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "certificat TLS non reconnu (certificat auto-signé Proxmox ?) — épinglez l'empreinte SHA-256 de CE nœud dans vm-providers.json (champ « fingerprint », visible dans l'UI Proxmox : nœud → Système → Certificats)",
    DEPTH_ZERO_SELF_SIGNED_CERT: "certificat TLS auto-signé — épinglez l'empreinte SHA-256 de CE nœud (champ « fingerprint » de vm-providers.json)",
    SELF_SIGNED_CERT_IN_CHAIN: "chaîne TLS auto-signée — épinglez l'empreinte SHA-256 de CE nœud (champ « fingerprint » de vm-providers.json)",
    CERT_HAS_EXPIRED: "certificat TLS EXPIRÉ sur le nœud — renouvelez-le côté Proxmox, ou épinglez la nouvelle empreinte",
    ERR_TLS_CERT_ALTNAME_INVALID: "le certificat du nœud ne couvre pas ce nom d'hôte — utilisez le nom porté par le certificat, ou épinglez l'empreinte",
    ECONNREFUSED: "connexion refusée par l'hôte (pveproxy arrêté ? port 8006 fermé ?)",
    EHOSTUNREACH: "hôte injoignable (routage / pare-feu)",
    ENETUNREACH: "réseau injoignable depuis le serveur DC Manager",
    ENOTFOUND: "nom d'hôte introuvable (résolution DNS)",
    EAI_AGAIN: "résolution DNS en échec temporaire",
    ETIMEDOUT: "délai de connexion dépassé (pare-feu silencieux ?)",
    ECONNRESET: "connexion coupée par l'hôte distant",
  };

  /** Enveloppe une erreur réseau/TLS en PveHttpError EXPLICITE : explication en français si le
      code est connu, message technique d'origine conservé, cible citée, cause transportée.
      Statique et pur → testable sans réseau. */
  static explainNetworkError(e: unknown, target: string): PveHttpError {
    const code = (e as { code?: unknown } | null | undefined)?.code;
    const raw = e instanceof Error ? e.message : String(e);
    const friendly = typeof code === "string" && PveHttp.ERROR_EXPLANATIONS[code] ? PveHttp.ERROR_EXPLANATIONS[code] + " — " : "";
    return new PveHttpError("Proxmox : " + friendly + raw + " (sur " + target + ")", true, e);
  }

  /** GET JSON authentifié sur l'API (`path` commence par "/", ex. "/api2/json/version").
      Résout le corps JSON parsé ; rejette une `PveHttpError` (message SANS le jeton),
      typée retryable/non-retryable pour la bascule de nœud (cf. PveHttpError). */
  getJson(path: string): Promise<any> {
    const url = new URL(path, this.baseUrl);
    // CIBLE citée dans chaque message d'erreur (origin + chemin, jamais de secret) : permet de
    // vérifier dans les logs QUEL nœud on a réellement tenté de contacter (demande 2026-07-13).
    const target = url.origin + url.pathname;

    const requestOptions: https.RequestOptions = {
      method: "GET",
      headers: { Authorization: "PVEAPIToken=" + this.token, Accept: "application/json" },
      timeout: this.timeoutMs,
      // Socket DÉDIÉE par requête (pas de pool keep-alive partagé) : cycle de vie déterministe
      // — nos volumes (une synchro = quelques dizaines d'appels séquentiels) ne justifient pas
      // la réutilisation de connexions, et l'isolation évite tout état partagé entre providers.
      agent: false,
      // Modèle de confiance TLS extrait en statique pure (épinglage > CA cluster > CA système) : le
      // spread N'INTRODUIT `checkServerIdentity`/`ca` QUE dans leur branche (cf. trustOptions — un
      // `undefined` explicite de checkServerIdentity casserait la validation interne de tls.connect).
      ...PveHttp.trustOptions(this.fingerprint, this.caPem),
    };

    return new Promise((resolve, reject) => {
      let req: ReturnType<typeof https.request>;
      try {
        req = https.request(url, requestOptions, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode || 0;
            // Le nœud a RÉPONDU → l'erreur est applicative (jeton, droits, route), PAS une
            // panne de nœud : retryable=false, la bascule vers un autre nœud n'aiderait pas.
            if (status === 401 || status === 403) { reject(new PveHttpError("Proxmox : authentification refusée (" + status + ") sur " + url.origin + " — vérifiez le jeton et ses permissions", false)); return; }
            if (status < 200 || status >= 300) { reject(new PveHttpError("Proxmox : HTTP " + status + " sur " + target, false)); return; }
            try { resolve(JSON.parse(body)); }
            catch { reject(new PveHttpError("Proxmox : réponse non-JSON sur " + target, false)); }
          });
        });
      } catch (e) {
        // Throw SYNCHRONE de https.request (URL/options invalides pour CE nœud) : sans ce
        // catch, l'erreur brute (sans cible ni préfixe) fuiterait telle quelle hors du client.
        reject(new PveHttpError("Proxmox : création de la requête impossible sur " + target + " — " + (e instanceof Error ? e.message : String(e)), true, e));
        return;
      }
      // Délai et erreurs de connexion (réseau, DNS, TLS/épinglage) = le nœud est INJOIGNABLE
      // ou inutilisable → retryable=true, un autre nœud du pool peut répondre.
      req.on("timeout", () => { req.destroy(new PveHttpError("Proxmox : délai dépassé (" + this.timeoutMs + " ms) sur " + target, true)); });
      req.on("error", (e) => reject(e instanceof PveHttpError ? e : PveHttp.explainNetworkError(e, target)));
      req.end();
    });
  }
}
