/* ============================================================================
   QRCODEPARAMS — validation PURE des paramètres de rendu d'une étiquette QR.

   Extrait de la route `GET …/qr/:collection/:id` (cf. api.ts) pour être TESTABLE
   en isolation (principe n°2) : aucune dépendance à Express, à `qrcode` ni au
   dépôt — seulement la lecture de `format` / `size` d'une query string.

   Deux paramètres, deux politiques distinctes et VOULUES :
     · `format` = png | svg | matrix (défaut png). Valeur INCONNUE → ERREUR
       (400) : on préfère refuser bruyamment qu'imprimer un format que
       l'appelant croyait obtenir. C'est une petite énumération fermée, pas une
       donnée continue. `matrix` n'est PAS une image : c'est la matrice de
       modules en JSON, consommée par l'export en images des étiquettes, qui
       rasterise le QR à un nombre ENTIER de pixels par module (cf. QrSvg et
       le diagnostic Q11.14) — `size` n'y a donc aucun effet.
     · `size` = largeur en pixels, BORNÉE à [MIN_SIZE, MAX_SIZE] (défaut 256).
       Hors bornes → on RAMÈNE dans l'intervalle (jamais une erreur : une
       étiquette un peu plus grande/petite que demandé reste utile, et le
       plafond n'est là que pour éviter qu'une requête ne réclame une image
       démesurée). Seule une valeur NON entière est refusée (400) : « 12abc »
       n'exprime aucune intention interprétable sans deviner.
   ============================================================================ */

/** Format servi pour une étiquette QR — énumération FERMÉE (cf. politique ci-dessus).
    `png`/`svg` sont des images ; `matrix` est la MATRICE de modules en JSON. */
export type QrFormat = "png" | "svg" | "matrix";

/** Résultat de validation : soit des paramètres normalisés, soit un message d'erreur (→ 400).
    La forme discriminée (`error` présent ou non) laisse l'appelant brancher sans ambiguïté. */
export type QrCodeParamsResult =
  | { format: QrFormat; size: number; error?: undefined }
  | { error: string };

export class QrCodeParams {
  /** Format par défaut quand `?format=` est absent. PNG : format universel pour l'impression. */
  static readonly DEFAULT_FORMAT: QrFormat = "png";
  /** Formats servis — liste blanche fermée (tout autre → 400). */
  static readonly FORMATS: readonly QrFormat[] = ["png", "svg", "matrix"];
  /** Largeur par défaut, et bornes du plafonnement. 64 px reste scannable ; 1024 px suffit à
      toute impression d'étiquette et borne le coût de génération d'une requête unique. */
  static readonly DEFAULT_SIZE = 256;
  static readonly MIN_SIZE = 64;
  static readonly MAX_SIZE = 1024;

  /** Valide et normalise les paramètres de rendu depuis la query string de la route.
      Ne lève jamais : toute anomalie exprimable est rendue comme `{ error }` (→ 400 côté HTTP). */
  static parse(query: { format?: unknown; size?: unknown } | null | undefined): QrCodeParamsResult {
    const q = query || {};
    const format = QrCodeParams.parseFormat(q.format);
    if (format === null) {
      return { error: "format invalide (" + QrCodeParams.FORMATS.join("|") + " attendu)" };
    }
    const size = QrCodeParams.parseSize(q.size);
    if (size === null) {
      return { error: "taille invalide (entier de pixels attendu, borné à " + QrCodeParams.MIN_SIZE + "–" + QrCodeParams.MAX_SIZE + ")" };
    }
    return { format, size };
  }

  /** `?format=` → format servi. Absent/vide → défaut ; inconnu → `null` (l'appelant répond 400). */
  static parseFormat(raw: unknown): QrFormat | null {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "") return QrCodeParams.DEFAULT_FORMAT;
    return (QrCodeParams.FORMATS as readonly string[]).includes(s) ? (s as QrFormat) : null;
  }

  /** `?size=` → largeur BORNÉE. Absent/vide → défaut ; entier → ramené dans [MIN, MAX] ;
      non entier (négatif, décimal, texte) → `null` (l'appelant répond 400). */
  static parseSize(raw: unknown): number | null {
    const s = String(raw ?? "").trim();
    if (s === "") return QrCodeParams.DEFAULT_SIZE;
    if (!/^\d+$/.test(s)) return null;   // uniquement des chiffres — pas de « -8 », « 3.5 » ni « 12abc »
    return QrCodeParams.clampSize(parseInt(s, 10));
  }

  /** Ramène une largeur dans l'intervalle servi (jamais d'erreur : borner, pas refuser). */
  static clampSize(n: number): number {
    return Math.max(QrCodeParams.MIN_SIZE, Math.min(QrCodeParams.MAX_SIZE, n));
  }
}
