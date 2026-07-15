/** Garde « glissé vs clic » — cœur PUR des 14 gardes inline factorisés (v162).
    `dn` = position [x,y] du mousedown (ou null). Renvoie true si le clic doit être
    ANNULÉ (= glissé au-delà du seuil, ou pan réservé non armé). */
export class ClickGuard {
  /** @param reservePan true sur les faces de scène (sol, baie) : un clic SANS
      mousedown armé (dn=null) est alors BLOQUÉ (réservé au pan). */
  static blocks(dn: [number, number] | null, x: number, y: number, thresh: number, reservePan: boolean): boolean {
    if (reservePan) return !dn || Math.hypot(x - dn[0], y - dn[1]) > thresh;
    return !!dn && Math.hypot(x - dn[0], y - dn[1]) > thresh;
  }
}
