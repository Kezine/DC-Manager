/* Conversions Blob ⇄ RawImage (côté DOM : canvas). Mutualisées entre l'éditeur de perspective et
   l'assemblage de photos — l'intermédiaire entre outils reste en RawImage SANS PERTE (pas de
   ré-encodage WebP entre les étapes) ; un seul encodage final. */
import type { RawImage } from "../geometry/Homography";

export class ImageBlob {
  /** Décode un Blob image en RawImage (RGBA). null si le décodage échoue. */
  static toRaw(source: Blob): Promise<RawImage | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(source);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          const ctx = cv.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, cv.width, cv.height);
          resolve({ data: d.data, width: d.width, height: d.height });
        } catch (_) { resolve(null); }   // pixels inaccessibles (CORS…)
      };
      img.src = url;
    });
  }

  /** Encode un RawImage en Blob — WebP q0.92 (compact + couche alpha) ; navigateur sans encodeur
      WebP → repli PNG. null si l'encodage échoue. */
  static fromRaw(raw: RawImage): Promise<Blob | null> {
    return new Promise((resolve) => {
      try {
        const cv = document.createElement("canvas"); cv.width = raw.width; cv.height = raw.height;
        const ctx = cv.getContext("2d")!;
        const idata = ctx.createImageData(raw.width, raw.height); idata.data.set(raw.data);
        ctx.putImageData(idata, 0, 0);
        cv.toBlob((b) => {
          if (b && b.type === "image/webp") resolve(b);
          else cv.toBlob((p) => resolve(p), "image/png");
        }, "image/webp", 0.92);
      } catch (_) { resolve(null); }
    });
  }

  /** Canvas hors-écran prêt à dessiner (affichage interactif d'un RawImage). */
  static toCanvas(raw: RawImage): HTMLCanvasElement {
    const cv = document.createElement("canvas"); cv.width = raw.width; cv.height = raw.height;
    const ctx = cv.getContext("2d")!;
    const idata = ctx.createImageData(raw.width, raw.height); idata.data.set(raw.data);
    ctx.putImageData(idata, 0, 0);
    return cv;
  }
}
