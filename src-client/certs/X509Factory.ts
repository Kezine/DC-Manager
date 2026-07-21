/* =============================================================================
   FABRIQUE X.509 CLIENT — génération de CA racines auto-signées et émission de
   certificats FEUILLES signés par la CA. Module PUR : WebCrypto (clés) +
   @peculiar/x509 (encodage/signature ASN.1) — aucun DOM, aucun réseau, donc
   testable headless sous Node ≥ 18 comme PkiCrypto/PkiSession.

   ZÉRO-CONNAISSANCE (cadrage certs 2026-07-14 §2) : TOUTE la crypto vit dans le
   NAVIGATEUR. Cette fabrique produit la clé privée EN CLAIR le temps de la
   génération ; l'appelant (page déverrouillée) la chiffre AUSSITÔT via
   PkiCrypto.encryptSecret avec la clé maître de l'utilisateur avant de
   l'envoyer au serveur — qui ne stocke qu'un blob opaque.

   Pourquoi @peculiar/x509 (principe n°11, choix utilisateur acté) : encoder
   soi-même de l'ASN.1 DER / des extensions X.509 est un piège à bugs de
   sécurité ; la lib est éprouvée, s'appuie sur WebCrypto natif (pas de wasm) et
   fonctionne à l'identique navigateur ⇄ Node — idéal pour un module pur testé.
   ============================================================================= */

import * as x509 from "@peculiar/x509";

/** Algorithmes de clé émis en X.509 v1 (compatibilité TLS maximale). L'ed25519
    du schéma serveur est RÉSERVÉ au chantier SSH (C4), hors X.509 ici. */
export type X509KeyAlgo = "ec-p256" | "rsa-2048" | "rsa-4096";

/** Usage de la feuille → ExtendedKeyUsage (serverAuth et/ou clientAuth). */
export type LeafUsage = "server" | "client" | "both";

/** Entrée SubjectAltName acceptée par la feuille (sous-ensemble X.509 des SAN
    du schéma serveur — le « principal » SSH n'a pas de sens en X.509). */
export interface X509San {
  san_type: "dns" | "ip" | "email";
  value: string;
}

/** Résultat d'une génération : le certificat PUBLIC + la clé privée EN CLAIR
    (à chiffrer immédiatement par l'appelant) + les métadonnées lisibles par le
    serveur (serial, empreinte, validité). */
export interface GeneratedCert {
  certPem: string;            // certificat X.509 au format PEM
  privateKeyPkcs8Pem: string; // clé privée PKCS#8 PEM — le CLIENT la chiffre via PkiCrypto avant envoi
  serial: string;             // numéro de série hexadécimal
  fingerprintSha256: string;  // empreinte SHA-256 du DER, « AA:BB:… » en majuscules
  notBefore: string;          // début de validité (ISO 8601)
  notAfter: string;           // fin de validité (ISO 8601)
}

export class X509Factory {
  /** Tolérance d'horloge : on antidate le début de validité de 5 min pour qu'un
      certificat émis à l'instant reste accepté par une machine dont l'horloge
      retarde légèrement (piège classique des PKI internes). */
  private static readonly CLOCK_SKEW_MS = 5 * 60 * 1000;

  /** @peculiar/x509 n'auto-enregistre AUCUN moteur crypto : il faut lui désigner
      WebCrypto une fois. `crypto` global = WebCrypto du navigateur (et de Node ≥ 20
      pour les tests) ; on ne touche donc ni au DOM ni à `node:crypto`. */
  private static providerReady = false;

  /** Crée une CA racine X.509 auto-signée (auto-émettrice) prête à signer des feuilles. */
  static async createRootCa(opts: {
    commonName: string;
    organization?: string;
    organizationalUnit?: string;
    keyAlgo: X509KeyAlgo;
    days: number;
  }): Promise<GeneratedCert> {
    X509Factory.ensureProvider();
    X509Factory.requireNonEmpty(opts.commonName, "le nom commun (CN) de la CA");
    const days = X509Factory.requirePositiveDays(opts.days);
    const algos = X509Factory.webCryptoAlgos(opts.keyAlgo);

    // Clés EXTRACTIBLES : contrairement à la clé MAÎTRE (non extractible, cf.
    // PkiCrypto), il FAUT pouvoir exporter la clé privée en PKCS#8 pour la
    // chiffrer ensuite. Elle n'existe en clair que le temps de cette méthode,
    // puis l'appelant la scelle avec la clé maître.
    const keys = await crypto.subtle.generateKey(algos.generate, true, ["sign", "verify"]);
    const { notBefore, notAfter } = X509Factory.validityWindow(days);

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: X509Factory.randomSerialHex(),
      name: X509Factory.buildDistinguishedName(opts.commonName, opts.organization, opts.organizationalUnit),
      notBefore, notAfter,
      signingAlgorithm: algos.sign,
      keys,
      extensions: [
        // CA=true CRITIQUE. pathLen LIBRE (non contraint) : PKI interne pilotée
        // par l'opérateur — ne pas figer la profondeur évite de devoir réémettre
        // la racine si un jour on insère une CA intermédiaire.
        new x509.BasicConstraintsExtension(true, undefined, true),
        // Une racine ne fait que signer des certificats et des CRL — CRITIQUE.
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        // SKI = empreinte de SA propre clé publique → référencée par l'AKI des feuilles.
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false, crypto),
      ],
    }, crypto);

    return X509Factory.assembleResult(cert, keys.privateKey);
  }

  /** RE-SIGNE une CA racine avec SA clé EXISTANTE et une nouvelle fenêtre de validité (renouvellement
      « prolonger » — cadrage §Phase 5) : même sujet, MÊME clé publique/privée → les certificats déjà émis
      par cette CA continuent de chaîner (l'AKI des enfants = empreinte de la clé, inchangée). L'appelant
      MET À JOUR la ligne de la CA en place (même id, key_enc conservé). Ne renvoie PAS la clé privée : elle
      est inchangée. */
  static async reSignRootCa(opts: {
    existingCertPem: string;
    existingPrivateKeyPkcs8Pem: string;
    commonName: string;
    organization?: string;
    organizationalUnit?: string;
    days: number;
  }): Promise<{ certPem: string; serial: string; fingerprintSha256: string; notBefore: string; notAfter: string }> {
    X509Factory.ensureProvider();
    X509Factory.requireNonEmpty(opts.commonName, "le nom commun (CN) de la CA");
    const days = X509Factory.requirePositiveDays(opts.days);
    // Réutilise le chargement de CA (public depuis le certificat, privé importé, algo de signature déduit).
    const { caCert, caPrivateKey, caSignAlgo } = await X509Factory.importCa(opts.existingCertPem, opts.existingPrivateKeyPkcs8Pem);
    const publicKey = await caCert.publicKey.export(crypto);
    const { notBefore, notAfter } = X509Factory.validityWindow(days);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: X509Factory.randomSerialHex(),
      name: X509Factory.buildDistinguishedName(opts.commonName, opts.organization, opts.organizationalUnit),
      notBefore, notAfter,
      signingAlgorithm: caSignAlgo,
      keys: { publicKey, privateKey: caPrivateKey } as CryptoKeyPair,   // MÊME paire — on ne fait que redater/re-signer
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(publicKey, false, crypto),   // SKI inchangé (même clé) → enfants toujours rattachés
      ],
    }, crypto);
    return {
      certPem: cert.toString("pem"),
      serial: cert.serialNumber,
      fingerprintSha256: await X509Factory.fingerprintSha256(cert.rawData),
      notBefore: cert.notBefore.toISOString(),
      notAfter: cert.notAfter.toISOString(),
    };
  }

  /** CROSS-SIGNE une CA : produit un certificat qui CERTIFIE la clé de la NOUVELLE CA (`subjectCaCertPem`)
      SOUS l'ANCIENNE CA (`issuerCaCertPem`, signature par sa clé). Sert le renouvellement par ROTATION DE CLÉ
      (cadrage §Phase 6) : pendant la transition, un client qui fait encore confiance à l'ancien root peut valider
      les nouvelles feuilles via ce maillon croisé (feuille → nouvelle CA [cross] → ancienne CA de confiance).
      Subject/clé publique = ceux de la NOUVELLE CA ; Issuer = l'ancienne. CA=true. La validité est ROGNÉE à
      l'échéance de l'ancienne CA (elle ne peut pas certifier au-delà de sa propre vie — même invariant que le guard). */
  static async crossSignCa(opts: {
    subjectCaCertPem: string;
    issuerCaCertPem: string;
    issuerCaPrivateKeyPkcs8Pem: string;
    days: number;
  }): Promise<{ certPem: string; serial: string; fingerprintSha256: string; notBefore: string; notAfter: string }> {
    X509Factory.ensureProvider();
    const days = X509Factory.requirePositiveDays(opts.days);
    let subjectCert: x509.X509Certificate;
    try { subjectCert = new x509.X509Certificate(opts.subjectCaCertPem); }
    catch { throw new Error("X509Factory : certificat de la nouvelle CA illisible (cross-signature impossible)"); }
    const { caCert: issuerCert, caPrivateKey: issuerKey, caSignAlgo } = await X509Factory.importCa(opts.issuerCaCertPem, opts.issuerCaPrivateKeyPkcs8Pem);
    const subjectPublicKey = await subjectCert.publicKey.export(crypto);
    const window = X509Factory.validityWindow(days);
    const notBefore = window.notBefore;
    // Le cross-cert est émis PAR l'ancienne CA → il ne peut vivre au-delà d'elle (recouvrement transitoire) → rognage.
    const notAfter = window.notAfter.getTime() > issuerCert.notAfter.getTime() ? issuerCert.notAfter : window.notAfter;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: X509Factory.randomSerialHex(),
      subject: subjectCert.subject,   // sujet DN de la NOUVELLE CA (chaîne)
      issuer: issuerCert.subject,     // émetteur = l'ANCIENNE CA
      notBefore, notAfter,
      signingAlgorithm: caSignAlgo,
      publicKey: subjectPublicKey,    // on certifie la CLÉ de la nouvelle CA (pas une clé neuve)
      signingKey: issuerKey,
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),   // c'est bien une CA
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(subjectPublicKey, false, crypto),   // SKI = clé de la nouvelle CA
        await x509.AuthorityKeyIdentifierExtension.create(issuerCert.publicKey, false, crypto),   // AKI → ancienne CA
      ],
    }, crypto);
    return {
      certPem: cert.toString("pem"),
      serial: cert.serialNumber,
      fingerprintSha256: await X509Factory.fingerprintSha256(cert.rawData),
      notBefore: cert.notBefore.toISOString(),
      notAfter: cert.notAfter.toISOString(),
    };
  }

  /** Émet une feuille signée par la CA. La clé privée de la CA est fournie
      DÉCHIFFRÉE par l'appelant (session déverrouillée) — cette fabrique ne
      connaît pas la clé maître et ne déchiffre rien elle-même. */
  static async issueLeaf(opts: {
    caCertPem: string;
    caPrivateKeyPkcs8Pem: string;
    commonName: string;
    organization?: string;
    organizationalUnit?: string;
    keyAlgo: X509KeyAlgo;
    days: number;
    sans: X509San[];
    usage?: LeafUsage;
  }): Promise<GeneratedCert> {
    X509Factory.ensureProvider();
    X509Factory.requireNonEmpty(opts.commonName, "le nom commun (CN) de la feuille");
    const days = X509Factory.requirePositiveDays(opts.days);
    const algos = X509Factory.webCryptoAlgos(opts.keyAlgo);
    const usage: LeafUsage = opts.usage || "server";

    // Import de la CA (certificat public + clé privée déchiffrée). Toute erreur
    // est reformulée en message NEUTRE : on ne réinjecte JAMAIS le matériau reçu.
    const { caCert, caPrivateKey, caSignAlgo } = await X509Factory.importCa(opts.caCertPem, opts.caPrivateKeyPkcs8Pem);

    // Clés de la feuille — extractibles pour le même motif que la racine.
    const keys = await crypto.subtle.generateKey(algos.generate, true, ["sign", "verify"]);
    const { notBefore, notAfter } = X509Factory.validityWindow(days);

    // GUARD (cadrage renouvellement) : une feuille ne peut PAS vivre au-delà de sa CA — un maillon dont la
    // validité déborde l'ancre est rejeté par les vérificateurs. On BLOQUE l'émission ici (source de vérité de
    // l'invariant ; le formulaire plafonne la durée en amont, ceci est le filet). La CA est déjà parsée
    // (`caCert`) → on lit son échéance sans paramètre supplémentaire.
    if (notAfter.getTime() > caCert.notAfter.getTime()) {
      throw new Error("X509Factory : la validité de la feuille dépasse celle de la CA (échéance CA : "
        + caCert.notAfter.toISOString().slice(0, 10) + ") — réduisez la durée");
    }

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: X509Factory.randomSerialHex(),
      subject: X509Factory.buildDistinguishedName(opts.commonName, opts.organization, opts.organizationalUnit),
      // Émetteur = sujet de la CA : c'est ce qui LIE la feuille à sa racine.
      issuer: caCert.subject,
      notBefore, notAfter,
      // La signature emploie l'algo de la CLÉ CA (indépendant de l'algo de la feuille).
      signingAlgorithm: caSignAlgo,
      publicKey: keys.publicKey,
      signingKey: caPrivateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),      // entité finale, CRITIQUE
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension(X509Factory.extendedKeyUsages(usage), false),
        new x509.SubjectAlternativeNameExtension(X509Factory.mapSans(opts.sans), false),
        // SKI de la feuille + AKI pointant vers la clé de la CA : l'AKI est
        // l'empreinte de la clé publique CA, donc ÉGALE à la SKI de la CA →
        // la chaîne se résout sans ambiguïté.
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false, crypto),
        await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey, false, crypto),
      ],
    }, crypto);

    return X509Factory.assembleResult(cert, keys.privateKey);
  }

  /** Lit l'USAGE (ExtendedKeyUsage) d'une feuille X.509 depuis son PEM — sert à PRÉ-REMPLIR fidèlement le
      renouvellement (l'usage n'est pas stocké en métadonnée serveur, il vit dans l'extension du certificat).
      Parsing PUR (aucune opération de clé) → pas besoin du provider WebCrypto. Repli « server » si l'extension
      manque ou si le PEM est illisible. */
  static readLeafUsage(certPem: string): LeafUsage {
    try {
      const cert = new x509.X509Certificate(certPem);
      const eku = cert.getExtension(x509.ExtendedKeyUsageExtension);
      if (!eku) return "server";
      const hasServer = eku.usages.includes(x509.ExtendedKeyUsage.serverAuth);
      const hasClient = eku.usages.includes(x509.ExtendedKeyUsage.clientAuth);
      if (hasServer && hasClient) return "both";
      if (hasClient) return "client";
      return "server";
    } catch {
      return "server";
    }
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Enregistre WebCrypto comme moteur par défaut de @peculiar (idempotent). */
  private static ensureProvider(): void {
    if (X509Factory.providerReady) return;
    if (typeof crypto === "undefined" || !crypto.subtle) {
      throw new Error("X509Factory : WebCrypto indisponible (subtle) — génération de certificat impossible");
    }
    x509.cryptoProvider.set(crypto);
    X509Factory.providerReady = true;
  }

  /** Traduit l'algo métier en paramètres WebCrypto : `generate` (génération de
      clé) et `sign` (algorithme de signature, toujours SHA-256 pour la compat TLS). */
  private static webCryptoAlgos(keyAlgo: X509KeyAlgo): { generate: EcKeyGenParams | RsaHashedKeyGenParams; sign: Algorithm } {
    switch (keyAlgo) {
      case "ec-p256":
        return { generate: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } as Algorithm };
      case "rsa-2048":
      case "rsa-4096": {
        const modulusLength = keyAlgo === "rsa-2048" ? 2048 : 4096;
        // RSASSA-PKCS1-v1_5 (et non PSS) : compatibilité TLS maximale, y compris
        // avec de vieux clients/serveurs. Exposant public standard 65537 (0x010001).
        return {
          generate: { name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
          sign: { name: "RSASSA-PKCS1-v1_5" },
        };
      }
      default:
        throw new Error("X509Factory : algorithme de clé non supporté « " + String(keyAlgo) + " » (attendu ec-p256 | rsa-2048 | rsa-4096)");
    }
  }

  /** Charge la CA : parse le certificat, importe la clé privée avec l'algo
      DÉDUIT du certificat, et calcule l'algo de signature associé. Les erreurs
      de parsing/import sont neutralisées (aucun matériau de clé divulgué). */
  private static async importCa(caCertPem: string, caPrivateKeyPkcs8Pem: string): Promise<{
    caCert: x509.X509Certificate; caPrivateKey: CryptoKey; caSignAlgo: Algorithm;
  }> {
    let caCert: x509.X509Certificate;
    try {
      caCert = new x509.X509Certificate(caCertPem);
    } catch {
      throw new Error("X509Factory : certificat de CA illisible (PEM X.509 attendu)");
    }
    try {
      // L'algo de la clé privée n'est pas dans le PKCS#8 seul de façon exploitable
      // par importKey : on le DÉDUIT de la clé publique de la CA (même algo).
      const caPublicKey = await caCert.publicKey.export(crypto);
      const caPrivateKey = await crypto.subtle.importKey(
        "pkcs8", x509.PemConverter.decodeFirst(caPrivateKeyPkcs8Pem), caPublicKey.algorithm, false, ["sign"],
      );
      const caSignAlgo: Algorithm = caPublicKey.algorithm.name === "ECDSA"
        ? { name: "ECDSA", hash: "SHA-256" } as Algorithm
        : { name: "RSASSA-PKCS1-v1_5" };
      return { caCert, caPrivateKey, caSignAlgo };
    } catch {
      throw new Error("X509Factory : clé privée de CA invalide ou incompatible avec son certificat");
    }
  }

  /** Construit le DN (JsonName @peculiar : CN obligatoire ; OU puis O optionnels — ordre X.500 du plus
      SPÉCIFIQUE au plus général, CN < OU < O). Le JsonName gère l'échappement des virgules/caractères spéciaux. */
  private static buildDistinguishedName(commonName: string, organization?: string, organizationalUnit?: string): x509.JsonName {
    const name: x509.JsonName = [{ CN: [commonName] }];
    if (organizationalUnit && organizationalUnit.trim() !== "") name.push({ OU: [organizationalUnit.trim()] });
    if (organization && organization.trim() !== "") name.push({ O: [organization.trim()] });
    return name;
  }

  /** SAN métier → GeneralName @peculiar. Les trois types partagent le même
      libellé (dns/ip/email) ; on valide quand même pour rejeter l'inconnu. */
  private static mapSans(sans: X509San[]): x509.JsonGeneralNames {
    const list = Array.isArray(sans) ? sans : [];
    return list.map((san) => {
      const value = typeof san.value === "string" ? san.value.trim() : "";
      if (value === "") throw new Error("X509Factory : valeur de SAN vide");
      if (san.san_type !== "dns" && san.san_type !== "ip" && san.san_type !== "email") {
        throw new Error("X509Factory : type de SAN non supporté « " + String(san.san_type) + " » (attendu dns | ip | email)");
      }
      return { type: san.san_type, value };
    });
  }

  /** Usage métier → OID ExtendedKeyUsage. */
  private static extendedKeyUsages(usage: LeafUsage): string[] {
    const server = x509.ExtendedKeyUsage.serverAuth;
    const client = x509.ExtendedKeyUsage.clientAuth;
    if (usage === "client") return [client];
    if (usage === "both") return [server, client];
    return [server]; // "server" (défaut)
  }

  /** Fenêtre de validité : début antidaté (tolérance d'horloge), fin à + N jours. */
  private static validityWindow(days: number): { notBefore: Date; notAfter: Date } {
    const now = Date.now();
    return {
      notBefore: new Date(now - X509Factory.CLOCK_SKEW_MS),
      notAfter: new Date(now + days * 24 * 60 * 60 * 1000),
    };
  }

  /** Numéro de série ALÉATOIRE 16 octets, garanti POSITIF (bit de poids fort du
      premier octet à 0 → jamais interprété comme un entier ASN.1 négatif) et de
      premier octet non nul (encodage minimal). L'aléa rend deux séries distinctes. */
  private static randomSerialHex(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[0] &= 0x7f;
    if (bytes[0] === 0) bytes[0] = 1;
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  /** Assemble le résultat commun : PEM du certificat, PKCS#8 PEM de la clé
      privée, série/empreinte/validité relues DANS le certificat (source de vérité). */
  private static async assembleResult(cert: x509.X509Certificate, privateKey: CryptoKey): Promise<GeneratedCert> {
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
    return {
      certPem: cert.toString("pem"),
      privateKeyPkcs8Pem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
      serial: cert.serialNumber,
      fingerprintSha256: await X509Factory.fingerprintSha256(cert.rawData),
      notBefore: cert.notBefore.toISOString(),
      notAfter: cert.notAfter.toISOString(),
    };
  }

  /** Empreinte SHA-256 du DER, formatée « AA:BB:CC:… » en hexadécimal majuscule. */
  private static async fingerprintSha256(der: ArrayBuffer): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
    const parts: string[] = [];
    for (const b of digest) parts.push(b.toString(16).padStart(2, "0").toUpperCase());
    return parts.join(":");
  }

  /** Refuse une chaîne vide avec un message français explicite (sans donnée sensible). */
  private static requireNonEmpty(value: string, label: string): void {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("X509Factory : " + label + " est requis");
    }
  }

  /** Valide/normalise la durée : entier de jours strictement positif. */
  private static requirePositiveDays(days: number): number {
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
      throw new Error("X509Factory : la durée de validité (jours) doit être un nombre strictement positif");
    }
    return Math.floor(days);
  }
}
