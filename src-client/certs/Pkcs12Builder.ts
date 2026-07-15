/* =============================================================================
   FABRIQUE PKCS#12 CLIENT — assemble un fichier .p12 (PFX) MODERNE à partir d'une
   clé privée PKCS#8 et d'une chaîne de certificats, tous DÉJÀ déchiffrés par
   l'appelant (page déverrouillée). Module PUR : structures ASN.1 via l'écosystème
   @peculiar (asn1-pfx/cms/pkcs8/x509/schema) + asn1js pour les rares paramètres
   d'algorithme sans classe dédiée, crypto via WebCrypto (PBKDF2, AES-256-CBC, HMAC,
   SHA-256) — aucun DOM, aucun réseau, aucun Buffer Node → testable headless.

   POURQUOI @peculiar (principe n°11, choix de cadrage) : encoder soi-même l'ASN.1
   DER d'un PKCS#12 est un piège à bugs de sécurité ; les classes @peculiar sont
   éprouvées et déjà présentes en transitif de @peculiar/x509 (le paquet
   « @peculiar/asn1-pkcs12 » du cadrage n'existe pas sur npm : les types PKCS#12/PFX
   vivent dans @peculiar/asn1-pfx). Seuls les paramètres PBES2/PBKDF2 et le SEQUENCE
   CMS EncryptedData (absents des classes @peculiar) sont bâtis avec asn1js — la
   MÊME librairie ASN.1 sous-jacente, donc pas de DER « à la main ».

   CHIFFREMENT MODERNE (cadrage) : PBES2 = PBKDF2-SHA-256 (≥ 100 000 itérations) +
   AES-256-CBC, pour le keyBag ET les certBags ; intégrité MAC HMAC-SHA-256. Les
   consommateurs 3DES/RC2 très anciens ne sont PAS visés.

   COMPATIBILITÉ (vérifiée par fixture croisée openssl, cf. test-certs.js) :
   importable par OpenSSL ≥ 1.1 / 3.x, Windows 10+, navigateurs et outils modernes.

   ⚠ DEUX ENCODAGES DE MOT DE PASSE pour la MÊME passphrase (piège d'interop) :
   - PBES2/PBKDF2 (chiffrement) : octets UTF-8 bruts ;
   - MAC (KDF PKCS#12, cf. Pkcs12Kdf) : BMPString (UTF-16BE + terminateur).
   Les deux ont été confirmés empiriquement contre openssl.

   ⚠ La passphrase n'est JAMAIS journalisée ni incluse dans un message d'erreur.
   ============================================================================= */
import * as asn1js from "asn1js";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import { AlgorithmIdentifier } from "@peculiar/asn1-x509";
import { ContentInfo, EncryptedContentInfo, EncryptedContent } from "@peculiar/asn1-cms";
import { DigestInfo } from "@peculiar/asn1-rsa";
import { EncryptedPrivateKeyInfo } from "@peculiar/asn1-pkcs8";
import {
  PFX, MacData, AuthenticatedSafe, SafeBag, SafeContents, CertBag, PKCS12Attribute,
  id_certBag, id_pkcs8ShroudedKeyBag, id_x509Certificate,
} from "@peculiar/asn1-pfx";
import { Pkcs12Kdf } from "./Pkcs12Kdf";

/** Entrée de construction d'un .p12 : matériau DÉJÀ déchiffré + passphrase d'export. */
export interface Pkcs12BuildOptions {
  /** Passphrase de protection du .p12, saisie à l'export (jamais stockée ni journalisée). */
  passphrase: string;
  /** Clé privée de la feuille au format PKCS#8 PEM (déchiffrée par l'appelant). */
  privateKeyPkcs8Pem: string;
  /** Chaîne de certificats en PEM : [feuille, émetteur(s)…]. La feuille (index 0) porte la clé. */
  certChainPem: string[];
  /** Nom convivial (friendlyName) affiché par les magasins de certificats — le label du cert. */
  friendlyName?: string;
  /** Itérations PBKDF2 du chiffrement (plancher 100 000 — décision de cadrage). */
  pbkdf2Iterations?: number;
  /** Itérations du KDF PKCS#12 du MAC (2048 par défaut, comme openssl). */
  macIterations?: number;
}

export class Pkcs12Builder {
  /** Plancher d'itérations PBKDF2 pour le chiffrement (défense contre la force brute). */
  static readonly MIN_PBKDF2_ITERATIONS = 100000;
  /** Itérations par défaut du KDF PKCS#12 pour le MAC (valeur usuelle d'openssl). */
  static readonly DEFAULT_MAC_ITERATIONS = 2048;

  /** OID employés (RFC 7292 / 5652 / 8018 / NIST). Regroupés pour lisibilité. */
  private static readonly OID = {
    data: "1.2.840.113549.1.7.1",              // pkcs7-data
    encryptedData: "1.2.840.113549.1.7.6",     // pkcs7-encryptedData
    pbes2: "1.2.840.113549.1.5.13",
    pbkdf2: "1.2.840.113549.1.5.12",
    hmacSha256: "1.2.840.113549.2.9",
    aes256Cbc: "2.16.840.1.101.3.4.1.42",
    sha256: "2.16.840.1.101.3.4.2.1",
    friendlyName: "1.2.840.113549.1.9.20",     // valeur BMPString
    localKeyId: "1.2.840.113549.1.9.21",       // valeur OCTET STRING (lie clé ⇄ certificat)
  };

  /** Assemble le .p12 et renvoie ses octets DER (le déclenchement du téléchargement
      est SÉPARÉ — cf. CertExports/Download). Toutes les étapes crypto passent par
      WebCrypto ; l'ASN.1 par @peculiar/asn1js. */
  static async build(opts: Pkcs12BuildOptions): Promise<Uint8Array> {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      throw new Error("Pkcs12Builder : WebCrypto indisponible (subtle) — génération PKCS#12 impossible");
    }
    if (typeof opts.passphrase !== "string" || opts.passphrase === "") {
      throw new Error("Pkcs12Builder : passphrase d'export requise"); // ne JAMAIS révéler la valeur
    }
    const chainPem = Array.isArray(opts.certChainPem) ? opts.certChainPem.filter((p) => typeof p === "string" && p.trim() !== "") : [];
    if (chainPem.length === 0) throw new Error("Pkcs12Builder : au moins un certificat (chaîne) est requis");
    if (typeof opts.privateKeyPkcs8Pem !== "string" || opts.privateKeyPkcs8Pem.trim() === "") {
      throw new Error("Pkcs12Builder : clé privée PKCS#8 (PEM) requise");
    }
    const pbkdf2Iterations = Math.max(Pkcs12Builder.MIN_PBKDF2_ITERATIONS, Math.floor(opts.pbkdf2Iterations ?? Pkcs12Builder.MIN_PBKDF2_ITERATIONS));
    const macIterations = Math.max(1, Math.floor(opts.macIterations ?? Pkcs12Builder.DEFAULT_MAC_ITERATIONS));
    const friendly = opts.friendlyName && opts.friendlyName.trim() !== "" ? opts.friendlyName.trim() : "certificat";

    const passUtf8 = new TextEncoder().encode(opts.passphrase); // encodage PBES2 (UTF-8)
    const keyDer = Pkcs12Builder.pemToDer(opts.privateKeyPkcs8Pem);
    const certDers = chainPem.map((pem) => Pkcs12Builder.pemToDer(pem));
    // localKeyId ALÉATOIRE : attribut qui lie la clé à SON certificat dans le magasin.
    const localKeyId = crypto.getRandomValues(new Uint8Array(20));

    // 1) SAC « clé » (SafeContents non chiffré) contenant UN pkcs8ShroudedKeyBag :
    //    la clé PKCS#8 est chiffrée par PBES2 (EncryptedPrivateKeyInfo).
    const keyEnc = await Pkcs12Builder.pbes2Encrypt(passUtf8, keyDer, pbkdf2Iterations);
    const shroudedKey = new EncryptedPrivateKeyInfo({ encryptionAlgorithm: keyEnc.algorithm, encryptedData: new OctetString(keyEnc.ciphertext) });
    const keyBag = new SafeBag({ bagId: id_pkcs8ShroudedKeyBag, bagValue: AsnConvert.serialize(shroudedKey) });
    keyBag.bagAttributes = [Pkcs12Builder.localKeyIdAttr(localKeyId), Pkcs12Builder.friendlyNameAttr(friendly)];
    const keySafe = new SafeContents([keyBag]);
    // ContentInfo (pkcs7-data) : le contenu est l'OCTET STRING du DER de la SafeContents.
    const keyContentInfo = new ContentInfo({ contentType: Pkcs12Builder.OID.data, content: AsnConvert.serialize(new OctetString(AsnConvert.serialize(keySafe))) });

    // 2) SAC « certificats » (SafeContents) CHIFFRÉE par PBES2 (pkcs7-encryptedData) :
    //    un certBag par certificat ; la feuille porte localKeyId + friendlyName.
    const certBags = certDers.map((der, index) => {
      const certBag = new CertBag({ certId: id_x509Certificate, certValue: AsnConvert.serialize(new OctetString(Pkcs12Builder.ab(der))) });
      const bag = new SafeBag({ bagId: id_certBag, bagValue: AsnConvert.serialize(certBag) });
      if (index === 0) bag.bagAttributes = [Pkcs12Builder.localKeyIdAttr(localKeyId), Pkcs12Builder.friendlyNameAttr(friendly)];
      return bag;
    });
    const certSafe = new SafeContents(certBags);
    const certEnc = await Pkcs12Builder.pbes2Encrypt(passUtf8, new Uint8Array(AsnConvert.serialize(certSafe)), pbkdf2Iterations);
    const encryptedContentInfo = new EncryptedContentInfo({
      contentType: Pkcs12Builder.OID.data,
      contentEncryptionAlgorithm: certEnc.algorithm,
      encryptedContent: new EncryptedContent({ value: new OctetString(certEnc.ciphertext) }),
    });
    // EncryptedData ::= SEQUENCE { version 0, encryptedContentInfo } — pas de classe @peculiar,
    // on emballe le DER de l'EncryptedContentInfo dans un SEQUENCE asn1js avec la version.
    const encryptedData = new asn1js.Sequence({ value: [
      new asn1js.Integer({ value: 0 }),
      asn1js.fromBER(AsnConvert.serialize(encryptedContentInfo)).result,
    ] }).toBER();
    const certContentInfo = new ContentInfo({ contentType: Pkcs12Builder.OID.encryptedData, content: encryptedData });

    // 3) AuthenticatedSafe = [ certificats chiffrés, clé ] → son DER est ce que le MAC protège.
    const authSafe = new AuthenticatedSafe([certContentInfo, keyContentInfo]);
    const authSafeDer = new Uint8Array(AsnConvert.serialize(authSafe));
    const authSafeContentInfo = new ContentInfo({ contentType: Pkcs12Builder.OID.data, content: AsnConvert.serialize(new OctetString(Pkcs12Builder.ab(authSafeDer))) });

    // 4) MAC d'intégrité : clé dérivée par le KDF PKCS#12 (BMPString, id=3), HMAC-SHA-256
    //    sur le DER de l'AuthenticatedSafe.
    const macSalt = crypto.getRandomValues(new Uint8Array(8));
    const macKey = await Pkcs12Kdf.derive(Pkcs12Kdf.ID_MAC, Pkcs12Kdf.bmpString(opts.passphrase), macSalt, macIterations, 32);
    const macValue = await Pkcs12Builder.hmacSha256(macKey, authSafeDer);
    const digestInfo = new DigestInfo({
      digestAlgorithm: new AlgorithmIdentifier({ algorithm: Pkcs12Builder.OID.sha256, parameters: new asn1js.Null().toBER() }),
      digest: new OctetString(Pkcs12Builder.ab(macValue)),
    });
    const macData = new MacData({ mac: digestInfo, macSalt: new OctetString(Pkcs12Builder.ab(macSalt)), iterations: macIterations });

    // 5) PFX (version 3) → DER final.
    const pfx = new PFX({ version: 3, authSafe: authSafeContentInfo, macData });
    return new Uint8Array(AsnConvert.serialize(pfx));
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Chiffre `plaintext` en PBES2 (PBKDF2-SHA-256 + AES-256-CBC, sel/IV aléatoires) et
      renvoie l'AlgorithmIdentifier PBES2 correspondant + le ciphertext. WebCrypto applique
      le bourrage PKCS#7 d'AES-CBC (exactement ce qu'attend PBES2). */
  private static async pbes2Encrypt(passUtf8: Uint8Array, plaintext: Uint8Array, iterations: number): Promise<{ algorithm: AlgorithmIdentifier; ciphertext: ArrayBuffer }> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const material = await crypto.subtle.importKey("raw", passUtf8 as BufferSource, "PBKDF2", false, ["deriveKey"]);
    const aesKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
      material, { name: "AES-CBC", length: 256 }, false, ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, aesKey, plaintext as BufferSource);
    return { algorithm: new AlgorithmIdentifier({ algorithm: Pkcs12Builder.OID.pbes2, parameters: Pkcs12Builder.pbes2Params(salt, iterations, iv) }), ciphertext };
  }

  /** Paramètres PBES2 en DER (asn1js) : SEQUENCE { PBKDF2(sel, itér, prf=hmacSHA256), aes-256-cbc(IV) }. */
  private static pbes2Params(salt: Uint8Array, iterations: number, iv: Uint8Array): ArrayBuffer {
    const pbkdf2Params = new asn1js.Sequence({ value: [
      new asn1js.OctetString({ valueHex: Pkcs12Builder.ab(salt) }),
      new asn1js.Integer({ value: iterations }),
      new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: Pkcs12Builder.OID.hmacSha256 }), new asn1js.Null()] }),
    ] });
    const keyDerivationFunc = new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: Pkcs12Builder.OID.pbkdf2 }), pbkdf2Params] });
    const encryptionScheme = new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: Pkcs12Builder.OID.aes256Cbc }), new asn1js.OctetString({ valueHex: Pkcs12Builder.ab(iv) })] });
    return new asn1js.Sequence({ value: [keyDerivationFunc, encryptionScheme] }).toBER();
  }

  /** HMAC-SHA-256 (WebCrypto) de `data` avec `key` — la clé de MAC vient du KDF PKCS#12. */
  private static async hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const hmacKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, data as BufferSource));
  }

  /** Attribut PKCS#12 friendlyName (valeur BMPString). NB : le constructeur de
      PKCS12Attribute d'@peculiar n'affecte pas ses champs — on les pose à la main. */
  private static friendlyNameAttr(name: string): PKCS12Attribute {
    const attr = new PKCS12Attribute();
    attr.attrId = Pkcs12Builder.OID.friendlyName;
    attr.attrValues = [new asn1js.BmpString({ value: name }).toBER()];
    return attr;
  }

  /** Attribut PKCS#12 localKeyId (valeur OCTET STRING) qui apparie la clé et son certificat. */
  private static localKeyIdAttr(id: Uint8Array): PKCS12Attribute {
    const attr = new PKCS12Attribute();
    attr.attrId = Pkcs12Builder.OID.localKeyId;
    attr.attrValues = [new asn1js.OctetString({ valueHex: Pkcs12Builder.ab(id) }).toBER()];
    return attr;
  }

  /** PEM → DER (base64 entre les lignes -----BEGIN/END-----). Sans Buffer Node (atob). */
  private static pemToDer(pem: string): Uint8Array {
    const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/[\s\r\n]+/g, "");
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /** Uint8Array → ArrayBuffer isolé (asn1js/@peculiar veulent un BufferSource propre ;
      copie explicite pour garantir le type ArrayBuffer et ne pas exposer le tampon source). */
  private static ab(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  }
}
