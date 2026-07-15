/* =============================================================================
   ENCODEUR OpenSSH MAISON — produit les trois formats OpenSSH nécessaires à la
   PKI SSH zéro-connaissance : ligne publique authorized_keys, clé privée
   openssh-key-v1 et certificat SSH signé. Module PUR : uniquement des octets
   via SshWire (Uint8Array + btoa) et crypto.subtle.sign pour la signature du
   certificat — aucun DOM, aucun réseau, aucun Buffer Node → testable headless.

   POURQUOI un encodeur maison (exception au principe n°11, décision Q3 du cadrage
   certs 2026-07-14) : il n'existe pas de librairie NAVIGATEUR éprouvée pour ces
   formats propres à OpenSSH (distincts de X.509). Les formats sont stables et
   spécifiés ; la SÉCURITÉ de l'implémentation est garantie par des FIXTURES
   CROISÉES ssh-keygen (Tests/modules/test-certs.js) : ed25519 étant DÉTERMINISTE,
   mêmes entrées + même graine ⇒ sortie BYTE-IDENTIQUE à ssh-keygen.

   TESTABILITÉ DÉTERMINISTE : les champs ALÉATOIRES du format (nonce du certificat,
   checkint du fichier privé) sont INJECTABLES en paramètres — par défaut tirés de
   crypto.getRandomValues. C'est ce qui autorise la validation croisée byte-à-byte.

   LIMITE v1 ASSUMÉE : la CA de SIGNATURE des certificats SSH est ed25519
   UNIQUEMENT (signature déterministe). Les paires RSA restent supportées comme
   clés simples (authorized_keys) et comme sujets de certificat ; la signature
   rsa-sha2 d'une CA RSA viendra si le besoin apparaît.
   ============================================================================= */
import { SshWire } from "./SshWire";

/** Type d'un certificat SSH : utilisateur (accès à un compte) ou hôte
    (authentification d'un serveur). Détermine le code numérique et les extensions. */
export type SshCertType = "user" | "host";

/** Paramètres d'émission d'un certificat SSH ed25519 signé. */
export interface SshCertificateParams {
  /** Clé publique ed25519 du SUJET (32 octets bruts). */
  subjectPublicKey: Uint8Array;
  /** Numéro de série (uint64 — number ou bigint pour les grandes valeurs). */
  serial: number | bigint;
  /** user = accès à un compte (5 extensions permit-*) ; host = authentification serveur (aucune). */
  type: SshCertType;
  /** Identifiant lisible du certificat (journalisé côté serveur SSH). */
  keyId: string;
  /** Principaux autorisés : logins (user) ou noms d'hôte (host). */
  principals: string[];
  /** Début de validité, epoch secondes (uint64). */
  validAfter: number | bigint;
  /** Fin de validité, epoch secondes (uint64). */
  validBefore: number | bigint;
  /** Clé publique ed25519 de la CA (32 octets) — embarquée comme « clé de signature ». */
  caPublicKey: Uint8Array;
  /** Clé privée ed25519 de la CA (CryptoKey « sign ») — signe le certificat. */
  caPrivateKey: CryptoKey;
  /** Commentaire de la ligne produite (optionnel). */
  comment?: string;
  /** Nonce de 32 octets — INJECTABLE pour les tests déterministes ; par défaut aléatoire. */
  nonce?: Uint8Array;
}

/** Résultat d'un encodage de certificat : blob wire brut + base64 + ligne complète. */
export interface EncodedCertificate {
  blob: Uint8Array;
  base64: string;
  line: string;
}

export class OpenSshEncoder {
  /** Nom d'algorithme wire d'une clé ed25519. */
  static readonly SSH_ED25519 = "ssh-ed25519";
  /** Nom d'algorithme wire d'une clé RSA. */
  static readonly SSH_RSA = "ssh-rsa";
  /** Type d'un certificat ed25519 (première « string » du blob de certificat). */
  static readonly ED25519_CERT_TYPE = "ssh-ed25519-cert-v01@openssh.com";

  /** Codes numériques du champ `type` d'un certificat (spec OpenSSH PROTOCOL.certkeys). */
  private static readonly CERT_TYPE_USER = 1;
  private static readonly CERT_TYPE_HOST = 2;

  /** Extensions standard d'un certificat UTILISATEUR, en ordre CANONIQUE (trié par
      nom, octet à octet — ce que fait ssh-keygen). Chaque extension a une valeur VIDE. */
  private static readonly USER_CERT_EXTENSIONS = [
    "permit-X11-forwarding",
    "permit-agent-forwarding",
    "permit-port-forwarding",
    "permit-pty",
    "permit-user-rc",
  ];

  /** Taille de bloc de padding du fichier privé openssh-key-v1 pour le chiffrement
      « none » : 8 octets (la spec impose un alignement sur la taille de bloc du cipher). */
  private static readonly PRIVATE_BLOCK_SIZE = 8;

  /* --------------------------------------------------------------------------
     1. Clé PUBLIQUE — ligne authorized_keys
     -------------------------------------------------------------------------- */

  /** Ligne authorized_keys d'une clé ed25519 : « ssh-ed25519 AAAA… commentaire ». */
  static ed25519PublicKeyLine(publicKey: Uint8Array, comment?: string): string {
    return OpenSshEncoder.formatPublicLine(OpenSshEncoder.SSH_ED25519, OpenSshEncoder.ed25519PublicKeyBlob(publicKey), comment);
  }

  /** Ligne authorized_keys d'une clé RSA : « ssh-rsa AAAA… commentaire ». */
  static rsaPublicKeyLine(modulus: Uint8Array, exponent: Uint8Array, comment?: string): string {
    return OpenSshEncoder.formatPublicLine(OpenSshEncoder.SSH_RSA, OpenSshEncoder.rsaPublicKeyBlob(modulus, exponent), comment);
  }

  /** Blob wire d'une clé publique ed25519 : string("ssh-ed25519") + string(pub 32 o).
      Réutilisé par le fichier privé et par le certificat (clé sujet / clé de signature). */
  static ed25519PublicKeyBlob(publicKey: Uint8Array): Uint8Array {
    OpenSshEncoder.requireLength(publicKey, 32, "la clé publique ed25519");
    return new SshWire().cstring(OpenSshEncoder.SSH_ED25519).string(publicKey).build();
  }

  /** Blob wire d'une clé publique RSA : string("ssh-rsa") + mpint(e) + mpint(n).
      Ordre EXPOSANT PUIS MODULE (spec ssh-rsa) ; le mpint applique la règle du zéro de tête. */
  static rsaPublicKeyBlob(modulus: Uint8Array, exponent: Uint8Array): Uint8Array {
    return new SshWire().cstring(OpenSshEncoder.SSH_RSA).mpint(exponent).mpint(modulus).build();
  }

  /* --------------------------------------------------------------------------
     2. Clé PRIVÉE — fichier openssh-key-v1 (NON chiffré)
     -------------------------------------------------------------------------- */

  /** Fichier de clé privée ed25519 au format openssh-key-v1, NON chiffré.
      NON chiffré = ciphername/kdfname « none » : la protection AU REPOS est NOTRE
      chiffrement AES-GCM par la clé maître (PkiCrypto) ; produire ce fichier en
      clair est un GESTE EXPLICITE de l'utilisateur (export). checkint injectable
      pour les tests déterministes ; par défaut aléatoire. */
  static ed25519PrivateKey(opts: {
    seed: Uint8Array;
    publicKey: Uint8Array;
    comment?: string;
    checkint?: number;
  }): string {
    OpenSshEncoder.requireLength(opts.seed, 32, "la graine ed25519");
    OpenSshEncoder.requireLength(opts.publicKey, 32, "la clé publique ed25519");
    const publicBlob = OpenSshEncoder.ed25519PublicKeyBlob(opts.publicKey);
    // Section privée ed25519 : type + clé publique + clé privée (64 o = graine || publique).
    const privateContent = new SshWire()
      .cstring(OpenSshEncoder.SSH_ED25519)
      .string(opts.publicKey)
      .string(SshWire.concat(opts.seed, opts.publicKey))
      .build();
    return OpenSshEncoder.assemblePrivateKeyFile(publicBlob, privateContent, opts.comment || "", opts.checkint);
  }

  /* --------------------------------------------------------------------------
     3. CERTIFICAT SSH signé (ssh-ed25519-cert-v01@openssh.com)
     -------------------------------------------------------------------------- */

  /** Émet un certificat SSH ed25519 signé par la CA. Asynchrone : la signature
      passe par crypto.subtle.sign (ed25519 déterministe). Le nonce est INJECTABLE
      (tests) ; par défaut 32 octets aléatoires. */
  static async certificate(params: SshCertificateParams): Promise<EncodedCertificate> {
    OpenSshEncoder.requireLength(params.subjectPublicKey, 32, "la clé publique du sujet (ed25519)");
    OpenSshEncoder.requireLength(params.caPublicKey, 32, "la clé publique de la CA (ed25519)");
    if (typeof params.keyId !== "string" || params.keyId.trim() === "") {
      throw new Error("OpenSshEncoder : l'identifiant du certificat (keyId) est requis");
    }
    const nonce = params.nonce ?? OpenSshEncoder.randomBytes(32);
    OpenSshEncoder.requireLength(nonce, 32, "le nonce du certificat");
    const typeCode = params.type === "host" ? OpenSshEncoder.CERT_TYPE_HOST : OpenSshEncoder.CERT_TYPE_USER;

    // Liste des principaux : une « string » contenant une SUITE de « string ».
    const principalsWriter = new SshWire();
    for (const principal of params.principals) principalsWriter.cstring(principal);

    // Extensions : les 5 permit-* (user) ou aucune (host). Valeur VIDE, ordre CANONIQUE trié.
    const extensionsBlob = OpenSshEncoder.extensionsBlob(params.type);

    // Clé de signature = blob wire de la clé publique CA (référencée dans le certificat).
    const caSignatureKey = OpenSshEncoder.ed25519PublicKeyBlob(params.caPublicKey);

    // « À signer » (TBS) : TOUS les champs SAUF la signature finale (spec PROTOCOL.certkeys).
    const tbs = new SshWire()
      .cstring(OpenSshEncoder.ED25519_CERT_TYPE)
      .string(nonce)
      .string(params.subjectPublicKey)         // clé sujet ed25519 : 32 o bruts (pas de sous-type)
      .uint64(params.serial)
      .uint32(typeCode)
      .cstring(params.keyId)
      .string(principalsWriter.build())
      .uint64(params.validAfter)
      .uint64(params.validBefore)
      .string(new Uint8Array(0))               // options critiques : VIDES (limite v1 assumée)
      .string(extensionsBlob)
      .string(new Uint8Array(0))               // reserved : toujours vide
      .string(caSignatureKey)
      .build();

    // Signature ed25519 de la CA (déterministe) sur le TBS, puis empaquetage wire.
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", params.caPrivateKey, tbs as BufferSource));
    const signatureBlob = new SshWire().cstring(OpenSshEncoder.SSH_ED25519).string(signature).build();
    const blob = new SshWire().raw(tbs).string(signatureBlob).build();

    const base64 = SshWire.toBase64(blob);
    return { blob, base64, line: OpenSshEncoder.formatLine(OpenSshEncoder.ED25519_CERT_TYPE, base64, params.comment) };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Assemble le fichier openssh-key-v1 : en-tête « none/none », clé publique,
      section privée (checkint doublé + contenu + commentaire) alignée par padding
      séquentiel 1..blockSize, puis emballage PEM. */
  private static assemblePrivateKeyFile(publicBlob: Uint8Array, privateContent: Uint8Array, comment: string, checkint?: number): string {
    const check = checkint === undefined ? OpenSshEncoder.randomUint32() : checkint;
    // checkint1 == checkint2 : après DÉCHIFFREMENT, l'égalité confirme que la clé/passe
    // était la bonne (ici le fichier est « none », mais le format l'exige toujours).
    const inner = new SshWire()
      .uint32(check)
      .uint32(check)
      .raw(privateContent)
      .cstring(comment)
      .build();
    // Padding SÉQUENTIEL 1, 2, 3… jusqu'à aligner la section privée sur la taille de bloc.
    const padLen = (OpenSshEncoder.PRIVATE_BLOCK_SIZE - (inner.length % OpenSshEncoder.PRIVATE_BLOCK_SIZE)) % OpenSshEncoder.PRIVATE_BLOCK_SIZE;
    const padded = new Uint8Array(inner.length + padLen);
    padded.set(inner, 0);
    for (let i = 0; i < padLen; i++) padded[inner.length + i] = i + 1;

    const file = new SshWire()
      .raw(OpenSshEncoder.magic())
      .cstring("none")               // ciphername : NON chiffré (cf. en-tête du module)
      .cstring("none")               // kdfname
      .string(new Uint8Array(0))     // kdfoptions : vide
      .uint32(1)                     // nkeys : une seule clé
      .string(publicBlob)
      .string(padded)
      .build();
    return OpenSshEncoder.toPem(file);
  }

  /** Le MAGIC du format = « openssh-key-v1 » suivi d'un OCTET NUL de terminaison.
      ⚠ Ce NUL est construit en OCTETS et n'apparaît JAMAIS BRUT dans un littéral
      (piège récurrent du dépôt : un NUL brut rend le fichier source binaire pour git). */
  private static magic(): Uint8Array {
    return SshWire.concat(SshWire.utf8("openssh-key-v1"), new Uint8Array([0]));
  }

  /** Blob wire des extensions du certificat (nom + valeur VIDE, triés). host → aucune. */
  private static extensionsBlob(type: SshCertType): Uint8Array {
    if (type === "host") return new Uint8Array(0); // un certificat d'HÔTE n'a pas d'extension
    const writer = new SshWire();
    // Tri par nom (octet à octet) pour garantir l'ordre CANONIQUE de ssh-keygen.
    for (const name of [...OpenSshEncoder.USER_CERT_EXTENSIONS].sort()) {
      writer.cstring(name).string(new Uint8Array(0)); // valeur d'extension : chaîne vide
    }
    return writer.build();
  }

  /** Formate une ligne publique « algo base64 [commentaire] ». */
  private static formatPublicLine(algo: string, blob: Uint8Array, comment?: string): string {
    return OpenSshEncoder.formatLine(algo, SshWire.toBase64(blob), comment);
  }

  /** Assemble « <étiquette> <base64> [commentaire] » (commentaire omis si vide). */
  private static formatLine(label: string, base64: string, comment?: string): string {
    const suffix = comment && comment.trim() !== "" ? " " + comment : "";
    return label + " " + base64 + suffix;
  }

  /** Emballage PEM d'un fichier openssh-key-v1 : base64 en lignes de 70 caractères
      (comme ssh-keygen), en-tête/pied OPENSSH PRIVATE KEY, saut de ligne final. */
  private static toPem(bytes: Uint8Array): string {
    const base64 = SshWire.toBase64(bytes);
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 70) lines.push(base64.slice(i, i + 70));
    return "-----BEGIN OPENSSH PRIVATE KEY-----\n" + lines.join("\n") + "\n-----END OPENSSH PRIVATE KEY-----\n";
  }

  /** Vérifie la longueur d'un tampon (message français SANS jamais divulguer le contenu). */
  private static requireLength(bytes: Uint8Array, expected: number, label: string): void {
    if (!(bytes instanceof Uint8Array) || bytes.length !== expected) {
      throw new Error("OpenSshEncoder : " + label + " doit faire " + expected + " octets (reçu " + (bytes ? bytes.length : "aucun") + ")");
    }
  }

  /** uint32 aléatoire (checkint par défaut du fichier privé). */
  private static randomUint32(): number {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0];
  }

  /** n octets aléatoires (nonce par défaut du certificat). */
  private static randomBytes(count: number): Uint8Array {
    const arr = new Uint8Array(count);
    crypto.getRandomValues(arr);
    return arr;
  }
}
