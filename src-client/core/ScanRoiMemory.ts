/* =============================================================================
   ScanRoiMemory — la ZONE DE DÉCODAGE (ROI) du viseur : géométrie de
   déplacement/redimensionnement + MÉMOIRE PAR CHAMP.
   Documentation : docs/qr-scan.md § « L'UI de scan ».

   POURQUOI UNE MÉMOIRE PAR CHAMP (maquette, contrat § « Zone de décodage ») :
   les étiquettes d'un même type d'objet ont un placement RÉCURRENT — la zone
   réglée au 1er scan d'un n° de série d'équipement doit se retrouver au 2e.
   D'où une carte `clé de champ → rectangle` persistée (localStorage côté
   appelant), la clé étant l'identifiant STABLE du champ (ex. « equipments.serial »).

   UNITÉS : FRACTIONS du plateau ([0..1] sur chaque axe) — indépendantes de la
   taille affichée, donc valables d'un téléphone à un desktop. La conversion en
   pixels (pour `BarcodeDetection.detect(video, roi)`) est le travail du viseur ;
   le mapping écran → pixels vidéo sous `object-fit: cover`, celui du MOTEUR
   (`BarcodeRoiGeometry.coverMap`) — RIEN de tout ça ici.

   MODULE PUR (testé : Tests/modules/test-scan-ui.js) : la persistance passe par
   des LECTURE/ÉCRITURE INJECTÉES (`read`/`write`) — jamais localStorage en dur,
   et le contenu stocké est traité en ENTRÉE NON SÛRE (JSON corrompu, rect
   invalide d'une autre version → repli sur le défaut, sans exception).

   ⚠ ÉCART assumé vs la maquette : son resize laissait la boîte GLISSER quand la
   taille butait sur le minimum (x continuait d'avancer alors que w était clampé).
   Ici le coin OPPOSÉ à la poignée reste ANCRÉ — le geste est prévisible. */

/** Rectangle de zone de décodage, en FRACTIONS du plateau (0..1). */
export interface ScanRoiRect { x: number; y: number; w: number; h: number; }

/** Coin saisi pendant un redimensionnement (poignées de la maquette). */
export type ScanRoiCorner = "tl" | "tr" | "bl" | "br";

export class ScanRoiMemory {
  /** Clé localStorage de la CARTE `champ → rect` (une seule entrée pour toute l'app). */
  static readonly STORAGE_KEY = "dcmanager.scanRoi";
  /** Tailles MINIMALES (fractions) — reprises de la maquette : en dessous, les
      poignées de 28px se chevauchent et la zone devient insaisissable. */
  static readonly MIN_W = 0.16;
  static readonly MIN_H = 0.14;
  /** Défaut : ~62% × 46%, CENTRÉ (spec maquette « défaut centré »). */
  static readonly DEFAULT: ScanRoiRect = { x: 0.19, y: 0.27, w: 0.62, h: 0.46 };

  /** Ramène un rect dans le cadre : tailles ∈ [MIN..1], position ∈ [0, 1-taille].
      Arrondi à 4 décimales — gomme le bruit flottant des drags cumulés et garde
      la valeur stockée compacte. */
  static clamp(rect: ScanRoiRect): ScanRoiRect {
    const round = (v: number) => Math.round(v * 10000) / 10000;
    const w = Math.min(Math.max(rect.w, ScanRoiMemory.MIN_W), 1);
    const h = Math.min(Math.max(rect.h, ScanRoiMemory.MIN_H), 1);
    const x = Math.min(Math.max(rect.x, 0), 1 - w);
    const y = Math.min(Math.max(rect.y, 0), 1 - h);
    return { x: round(x), y: round(y), w: round(w), h: round(h) };
  }

  /** DÉPLACEMENT (drag du corps de la zone) : translation clampée aux bords. */
  static move(base: ScanRoiRect, dx: number, dy: number): ScanRoiRect {
    return ScanRoiMemory.clamp({ x: base.x + dx, y: base.y + dy, w: base.w, h: base.h });
  }

  /** REDIMENSIONNEMENT par un coin : le coin OPPOSÉ reste ancré (cf. en-tête).
      Chaque axe se calcule depuis le bord FIXE : taille clampée d'abord, puis la
      position se déduit du bord ancré — la boîte ne glisse jamais. */
  static resize(base: ScanRoiRect, corner: ScanRoiCorner, dx: number, dy: number): ScanRoiRect {
    const left = corner === "tl" || corner === "bl";
    const top = corner === "tl" || corner === "tr";
    const right = base.x + base.w;    // bord ancré quand on tire un coin gauche
    const bottom = base.y + base.h;   // bord ancré quand on tire un coin haut
    const w = Math.max(ScanRoiMemory.MIN_W, left ? base.w - dx : base.w + dx);
    const h = Math.max(ScanRoiMemory.MIN_H, top ? base.h - dy : base.h + dy);
    return ScanRoiMemory.clamp({ x: left ? right - w : base.x, y: top ? bottom - h : base.y, w, h });
  }

  /** Validation d'une valeur STOCKÉE (entrée non sûre) : objet à 4 nombres finis,
      tailles strictement positives — sinon `null`. Un rect valide mais hors cadre
      est RAMENÉ (clamp) plutôt que jeté : la mémoire survit à un léger dérèglement. */
  static normalize(raw: unknown): ScanRoiRect | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const x = num(r.x), y = num(r.y), w = num(r.w), h = num(r.h);
    if (x === null || y === null || w === null || h === null) return null;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x > 1 || y > 1 || w > 1 || h > 1) return null;
    return ScanRoiMemory.clamp({ x, y, w, h });
  }

  /** ROI mémorisée du champ `fieldKey` — ou le DÉFAUT (copie) si absente/invalide. */
  static load(read: (key: string) => string | null, fieldKey: string): ScanRoiRect {
    const rect = ScanRoiMemory.readMap(read)[fieldKey];
    return ScanRoiMemory.normalize(rect) || { ...ScanRoiMemory.DEFAULT };
  }

  /** Écrit la ROI du champ `fieldKey` (read-modify-write : les AUTRES champs de la
      carte survivent — c'est ce qui fait de la mémoire une mémoire PAR champ). */
  static save(read: (key: string) => string | null, write: (key: string, value: string) => void, fieldKey: string, rect: ScanRoiRect): void {
    const map = ScanRoiMemory.readMap(read);
    map[fieldKey] = ScanRoiMemory.clamp(rect);
    write(ScanRoiMemory.STORAGE_KEY, JSON.stringify(map));
  }

  /** Carte stockée, tolérante : JSON corrompu ou forme inattendue → carte vide. */
  private static readMap(read: (key: string) => string | null): Record<string, unknown> {
    try {
      const parsed = JSON.parse(read(ScanRoiMemory.STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
}
