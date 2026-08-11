/* =============================================================================
   BUNDLE BINAIRE GÉNÉRIQUE — format conteneur COMMUN des fichiers compagnons.

   Extrait d'`ImageStore.buildBundle/parseBundle` (principe n°3) quand le
   compagnon de PIÈCES JOINTES `.nmfa` a rejoint le compagnon d'images `.nmfb` :
   même format, seule la SIGNATURE (et le manifeste transporté) change — le
   dupliquer aurait laissé deux copies diverger au premier ajustement.

   Format (INCHANGÉ octet pour octet vs l'historique `.nmfb` — les fichiers
   existants restent lisibles, les tests golden restent verts) :

     [0..3]  signature ASCII 4 octets (« NMFB » images · « NMFA » pièces jointes)
     [4]     version du CONTENEUR (1)
     [5..8]  longueur du manifeste JSON (uint32 little-endian)
     [9..]   manifeste JSON (UTF-8), puis les blobs CONCATÉNÉS dans l'ordre où
             le manifeste les décrit (chacun y annonce son `bytes`)

   Le CONTENU du manifeste appartient à l'appelant (ImageStore : images + clé
   d'appariement ; AttachmentStore : pièces + clé) — ce module ne connaît que
   l'enveloppe. La clé d'appariement document ⇄ compagnon vit DANS le manifeste,
   pas dans l'enveloppe : c'est déjà le contrat `.nmfb`, conservé tel quel.
   ============================================================================= */

export class BinaryBundle {
  /** Taille de l'entête fixe : signature (4) + version (1) + longueur du manifeste (4). */
  private static readonly HEAD_BYTES = 9;

  /** Construit le Blob conteneur : entête + manifeste JSON + blobs concaténés (pur ; testable).
      ⚠ L'appelant est responsable de la COHÉRENCE manifeste ⇄ blobs (ordre et `bytes` annoncés) —
      l'enveloppe ne relit pas le manifeste. `signature` : 4 caractères ASCII exactement. */
  static build(signature: string, manifest: unknown, blobs: readonly Blob[]): Blob {
    if (signature.length !== 4) throw new Error("signature de bundle invalide (4 caractères attendus)");
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const head = new Uint8Array(BinaryBundle.HEAD_BYTES);
    for (let i = 0; i < 4; i++) head[i] = signature.charCodeAt(i);
    head[4] = 1;
    new DataView(head.buffer).setUint32(5, manifestBytes.length, true);
    return new Blob([head, manifestBytes, ...blobs], { type: "application/octet-stream" });
  }

  /** Le tampon porte-t-il la signature attendue ? (assez long ET les 4 premiers octets) — sert aussi au
      SCAN d'un dossier (identifier un compagnon par son contenu, pas par son extension). */
  static hasSignature(buf: ArrayBuffer, signature: string): boolean {
    if (buf.byteLength < BinaryBundle.HEAD_BYTES) return false;
    const bytes = new Uint8Array(buf, 0, 4);
    for (let i = 0; i < 4; i++) if (bytes[i] !== signature.charCodeAt(i)) return false;
    return true;
  }

  /** Parse l'enveloppe : vérifie la signature (lève `invalidMessage` sinon — chaque appelant garde SON
      message historique), décode le manifeste JSON et rend l'OFFSET du premier blob. Le découpage des
      blobs reste à l'appelant (il sait, par SON manifeste, où chacun commence et finit). */
  static parse(buf: ArrayBuffer, signature: string, invalidMessage: string): { manifest: any; dataOffset: number } {
    if (!BinaryBundle.hasSignature(buf, signature)) throw new Error(invalidMessage);
    const manifestLength = new DataView(buf).getUint32(5, true);
    const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, BinaryBundle.HEAD_BYTES, manifestLength)));
    return { manifest, dataOffset: BinaryBundle.HEAD_BYTES + manifestLength };
  }
}
