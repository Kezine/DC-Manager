import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/* =============================================================================
   COFFRE À SECRETS SERVEUR PARTAGÉ — chiffrement AU REPOS des secrets stockés
   dans les bases des modules (jetons d'API des providers VM dans
   vm-providers.db, jetons d'appel des webhooks de notification dans notify.db,
   …). Généralisation de l'ex-`vm/VmSecretBox` (décision utilisateur
   2026-07-14, Q3 du cadrage notifications) : UNE clé d'environnement unique
   `DCMANAGER_SECRETS_KEY` pour tous les modules. (Le repli historique vers l'ancienne
   `VM_PROVIDERS_KEY` a été RETIRÉ le 2026-07-20 : un déploiement encore sur l'ancien
   nom doit RENOMMER la variable en `DCMANAGER_SECRETS_KEY` — même valeur, dérivation
   identique, donc les secrets déjà stockés restent déchiffrables sans réécriture.)

   Schéma cryptographique (délibérément simple et standard) :
   - AES-256-GCM (chiffrement AUTHENTIFIÉ : toute altération du stocké est
     détectée au déchiffrement — pas de secret silencieusement corrompu) ;
   - clé = SHA-256 de la passphrase d'environnement (dérivation qui normalise
     une passphrase LIBRE en 32 octets ; un KDF lent type scrypt serait du
     théâtre ici : la passphrase n'est pas un mot de passe humain à force-brute
     mais un secret d'infrastructure long) ;
   - IV de 12 octets ALÉATOIRE par chiffrement (jamais réutilisé — exigence GCM) ;
   - format stocké : `v1:<iv>:<tag>:<ct>` en base64 — le préfixe versionne le
     format (rotation d'algorithme possible sans deviner).

   Limites ASSUMÉES (documentées dans docs/vm-proxmox.md) : la clé vit dans
   l'environnement du serveur — le chiffrement protège les COPIES des DB
   (backups, exfiltration du fichier), pas un attaquant qui contrôle l'hôte.
   Clé perdue = secrets à ressaisir (aucune récupération possible, c'est le but).

   INVARIANT : ni la passphrase, ni la clé, ni un secret (clair ou chiffré)
   n'apparaissent JAMAIS dans un message d'erreur ou un log.
   ============================================================================= */
export class SecretBox {
  /** Nom de la variable d'environnement portant la passphrase (clé UNIQUE, tous modules).
      SEULE variable lue : le repli historique vers `VM_PROVIDERS_KEY` a été retiré (2026-07-20). */
  static readonly ENV_VAR = "DCMANAGER_SECRETS_KEY";

  private readonly key: Buffer;

  /** @param passphrase  Passphrase d'infrastructure (l'appelant la tire de l'environnement).
      @param envVarName  Nom de la variable d'où elle provient — UNIQUEMENT pour produire des
                         messages d'erreur actionnables (« clé X différente… ») ; jamais la valeur. */
  constructor(passphrase: string, private readonly envVarName: string = SecretBox.ENV_VAR) {
    if (typeof passphrase !== "string" || passphrase.trim() === "") {
      throw new Error("SecretBox : passphrase vide — définir " + SecretBox.ENV_VAR);
    }
    this.key = createHash("sha256").update(passphrase, "utf8").digest();
  }

  /** Construit le coffre depuis l'environnement : `DCMANAGER_SECRETS_KEY` UNIQUEMENT (aucun repli —
      retiré le 2026-07-20). null si elle est absente ou blanche (→ les features à secrets chiffrés se
      désactivent et le signalent explicitement, cf. VmModule/NotifyModule). Un déploiement encore sur
      l'ancien `VM_PROVIDERS_KEY` doit RENOMMER la variable (même valeur, même dérivation). */
  static fromEnv(env: { [k: string]: string | undefined } = process.env): SecretBox | null {
    const key = env[SecretBox.ENV_VAR];
    if (key && key.trim() !== "") return new SecretBox(key);
    return null;
  }

  /** Chiffre un secret → chaîne stockable `v1:<iv>:<tag>:<ct>` (base64). Deux appels
      sur le même clair produisent des sorties DIFFÉRENTES (IV aléatoire). */
  encrypt(plain: string): string {
    const iv = randomBytes(12); // 96 bits : taille nominale GCM, unique par chiffrement
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return "v1:" + iv.toString("base64") + ":" + cipher.getAuthTag().toString("base64") + ":" + ciphertext.toString("base64");
  }

  /** Déchiffre une chaîne produite par encrypt(). Jette une erreur EXPLICITE (et sans
      aucune donnée sensible) si le format est inconnu, la clé différente ou le contenu
      altéré — l'appelant transforme ça en « secret à ressaisir » pour l'utilisateur. */
  decrypt(stored: string): string {
    const parts = typeof stored === "string" ? stored.split(":") : [];
    if (parts.length !== 4 || parts[0] !== "v1") {
      throw new Error("SecretBox : format de secret stocké inconnu — donnée corrompue ou format d'une version future");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parts[1], "base64"));
      decipher.setAuthTag(Buffer.from(parts[2], "base64"));
      return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
    } catch {
      // GCM refuse l'authentification : clé différente (passphrase changée) ou donnée altérée.
      // Message SANS détail cryptographique ni contenu — il n'y a rien à divulguer.
      throw new Error("SecretBox : déchiffrement refusé (clé " + this.envVarName + " différente ou donnée altérée) — le secret doit être ressaisi");
    }
  }
}
