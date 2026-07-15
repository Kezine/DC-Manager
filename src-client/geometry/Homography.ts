/* =============================================================================
   Homography — géométrie PURE du redressement de perspective (images de façade).
   Algorithmes validés par le POC `poc/perspective.html` :
   - `solve`  : homographie par DLT (Direct Linear Transform) ; le vecteur solution
     est le vecteur propre de plus petite valeur propre de AᵀA, obtenu par
     itérations de Jacobi (9×9, symétrique) — aucune dépendance externe.
     ≥ 4 correspondances ; au-delà (points de bord additionnels), moindres carrés.
   - `estimateAspect` : ratio largeur/hauteur RÉEL d'un rectangle photographié en
     perspective (points de fuite + focale auto-estimée, cf. Zhang) ; repli sur la
     moyenne des côtés opposés quand la configuration est dégénérée (vue frontale).
   - `warpBilinear` : rééchantillonnage bilinéaire de l'image source à travers H
     (H orientée SORTIE → SOURCE) ; hors-source → alpha 0 (transparent).
   AUCUN accès DOM : opère sur des tableaux bruts (`RawImage`) → testable en Node
   (Tests/modules). L'éditeur interactif vit dans `ui/PerspectiveEditor` ; le
   branchement au flux d'images de façade est décrit dans
   `docs/redressement-perspective.md`.
   ============================================================================= */

/** Image en mémoire, indépendante du DOM (compatible ImageData : RGBA entrelacé). */
export interface RawImage { data: Uint8ClampedArray; width: number; height: number; }

export class Homography {
  /** Résout h (9 coefficients, ordre ligne) tel que dst ~ H·src en coordonnées homogènes.
      `src`/`dst` : listes appariées de points [x,y] (≥ 4 ; sur-détermination → moindres carrés). */
  static solve(src: Array<[number, number]>, dst: Array<[number, number]>): number[] {
    const n = src.length, A: number[][] = [];
    for (let i = 0; i < n; i++) {
      const X = src[i][0], Y = src[i][1], x = dst[i][0], y = dst[i][1];
      A.push([-X, -Y, -1, 0, 0, 0, x * X, x * Y, x]);
      A.push([0, 0, 0, -X, -Y, -1, y * X, y * Y, y]);
    }
    // M = AᵀA (9×9 symétrique) ; la solution DLT = vecteur propre du plus petit λ.
    const M = Array.from({ length: 9 }, () => new Array(9).fill(0));
    for (const row of A) for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) M[i][j] += row[i] * row[j];
    const { vectors, values } = Homography.jacobi(M);
    let idx = 0; for (let i = 1; i < 9; i++) if (values[i] < values[idx]) idx = i;
    return vectors.map((r) => r[idx]);
  }

  /** Applique h à (x,y) — division homogène. */
  static apply(h: number[], x: number, y: number): [number, number] {
    const X = h[0] * x + h[1] * y + h[2], Y = h[3] * x + h[4] * y + h[5], W = h[6] * x + h[7] * y + h[8];
    return [X / W, Y / W];
  }

  /** Inverse de h — ADJUGÉE 3×3 (une homographie est définie à un facteur près : inutile de diviser
      par le déterminant). Sert à projeter l'image SOURCE dans l'espace REDRESSÉ (emprise du
      recadrage séparé). null si dégénérée (déterminant ≈ 0). */
  static invert(h: number[]): number[] | null {
    const [a, b, c, d, e, f, g, k, i] = h;
    const A = e * i - f * k, B = c * k - b * i, C = b * f - c * e;
    const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
    const G = d * k - e * g, K = b * g - a * k, I = a * e - b * d;
    const det = a * A + b * D + c * G;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    return [A, B, C, D, E, F, G, K, I];
  }

  /** Ratio largeur/hauteur RÉEL d'un rectangle vu en perspective, à partir de ses 4 coins image
      en ordre PÉRIMÉTRIQUE [TL, TR, BR, BL] et des dimensions de l'image (centre optique supposé au
      centre, pixels carrés). Méthode de Zhang (« Whiteboard scanning ») : points de fuite + focale
      auto-estimée — EXACTE en perspective à deux points de fuite (testé sur caméra synthétique).
      NB : la formule veut (m1,m2,m3,m4) = (TL,TR,BL,BR), m4 DIAGONAL de m1 (M4 = M2+M3−M1) — le POC
      passait l'ordre périmétrique tel quel, ce qui faussait l'estimation ; corrigé ici.
      Cas dégénérés : vue FRONTALE (deux bords fronto-parallèles) → ratio exact sans focale ;
      UN SEUL point de fuite (un bord fronto-parallèle) → focale non estimable → repli sur la
      moyenne des longueurs de côtés opposés (approximation raisonnable). */
  static estimateAspect(corners: Array<[number, number]>, imgW: number, imgH: number): number {
    const cx = imgW / 2, cy = imgH / 2;
    const m = corners.map((c) => [c[0] - cx, c[1] - cy, 1]);
    const [m1, m2, m4, m3] = m;   // périmètre [TL,TR,BR,BL] → Zhang (m1,m2,m3,m4) = (TL,TR,BL,BR)
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const fallback = (): number => {   // moyenne des côtés opposés (largeur/hauteur en pixels image)
      const d = (a: number, b: number) => Math.hypot(corners[a][0] - corners[b][0], corners[a][1] - corners[b][1]);
      const wAvg = (d(0, 1) + d(3, 2)) / 2, hAvg = (d(1, 2) + d(0, 3)) / 2;
      return hAvg > 0 ? wAvg / hAvg : 1;
    };
    const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);   // profondeurs relatives z2/z1, z3/z1
    const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    if (!isFinite(k2) || !isFinite(k3)) return fallback();   // quadrilatère dégénéré
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];   // ∝ bord LARGEUR (M2−M1)
    const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];   // ∝ bord HAUTEUR (M3−M1)
    // bord fronto-parallèle ⇔ composante z ≈ 0 (k ≈ 1 : pas de fuite sur cet axe) — seuil RELATIF à l'échelle pixel.
    const flat2 = Math.abs(n2[2]) <= 1e-7 * Math.hypot(n2[0], n2[1]);
    const flat3 = Math.abs(n3[2]) <= 1e-7 * Math.hypot(n3[0], n3[1]);
    if (flat2 && flat3) {   // vue FRONTALE : ratio exact sans focale (les deux bords sont dans le plan image)
      const r = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
      return isFinite(r) && r > 0 ? r : fallback();
    }
    if (flat2 || flat3) return fallback();   // un seul point de fuite → focale non estimable
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);   // focale² (orthogonalité largeur ⊥ hauteur)
    if (!(f2 > 0)) return fallback();
    const num = n2[0] * n2[0] + n2[1] * n2[1] + f2 * n2[2] * n2[2];
    const den = n3[0] * n3[0] + n3[1] * n3[1] + f2 * n3[2] * n3[2];
    const r = Math.sqrt(num / den);
    return isFinite(r) && r > 0 ? r : fallback();
  }

  /** Rééchantillonne `src` vers une image outW×outH à travers `hOutToSrc` (H orientée SORTIE → SOURCE),
      en bilinéaire. Un pixel de sortie dont l'antécédent tombe hors de la source est TRANSPARENT (alpha 0)
      — d'où l'intérêt d'un format de sortie à couche alpha (WebP/PNG). */
  static warpBilinear(src: RawImage, hOutToSrc: number[], outW: number, outH: number): RawImage {
    const sd = src.data, sw = src.width, sh = src.height, H = hOutToSrc;
    const o = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const X = H[0] * x + H[1] * y + H[2], Y = H[3] * x + H[4] * y + H[5], W = H[6] * x + H[7] * y + H[8];
        const ux = X / W, uy = Y / W;
        const oi = (y * outW + x) * 4;
        if (!(ux >= 0 && uy >= 0 && ux < sw - 1 && uy < sh - 1)) continue;   // hors source → alpha 0 (NaN inclus)
        const x0 = ux | 0, y0 = uy | 0, fx = ux - x0, fy = uy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        o[oi] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        o[oi + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        o[oi + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        o[oi + 3] = 255;
      }
    }
    return { data: o, width: outW, height: outH };
  }

  /** Diagonalisation de Jacobi d'une matrice SYMÉTRIQUE (rotations de Givens jusqu'à convergence).
      Suffisant et robuste pour le 9×9 du DLT (pas besoin d'une SVD générale). */
  private static jacobi(Ain: number[][]): { vectors: number[][]; values: number[] } {
    const n = Ain.length, A = Ain.map((r) => r.slice());
    const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_2, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-20) continue;
        const phi = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
        const c = Math.cos(phi), s = Math.sin(phi);
        for (let k = 0; k < n; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
        for (let k = 0; k < n; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
        for (let k = 0; k < n; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
      }
    }
    return { vectors: V, values: A.map((r, i) => r[i]) };
  }
}
