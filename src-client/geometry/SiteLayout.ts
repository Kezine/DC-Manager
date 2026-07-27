/* =============================================================================
   SITE (bâtiment) — POSITION du niveau RACINE de la hiérarchie de placement.
   Doctrine : `docs/placement.md` §6.8 et §6.9. Module PUR : aucun store, aucun DOM,
   aucune dépendance — il ne reçoit que des données et rend des positions.

   POURQUOI CE MODULE EXISTE. Le site était le SEUL niveau de la hiérarchie sans
   géométrie : la spec `sites` ne portait que `name` et `address`. Faute de position
   déclarée, `FloorLayout.multiLayout` en improvisait une par RANGEMENT (bâtiments
   posés côte à côte par largeur cumulée) — un layout qui dépendait de l'ensemble
   AFFICHÉ, exactement ce que §6.8 interdit. Donner une position au site referme
   cette coupure : la portée décide de ce qu'on VOIT, jamais de OÙ SONT les choses.

   DEUX ÉTAPES SÉPARÉES, et c'est essentiel :
   1. `realPositions` — position RÉELLE, en MÈTRES, dérivée du seul MODÈLE (GPS
      déclarés, sinon repli déterministe). Aucun réglage de vue n'y entre.
   2. `compress`     — position d'AFFICHAGE, en MILLIMÈTRES monde, après application
      de l'échelle. L'échelle est un réglage de VUE (curseur + bascule linéaire /
      logarithmique) : les coordonnées monde restent donc NON persistables (§6.3).

   REPÈRE. `x` croît vers l'EST, `y` vers le SUD. Le second point mérite d'être dit :
   les plans d'étage de l'application ont un `y` qui croît vers le BAS de la vue en
   plan ; aligner le nord sur `-y` fait donc coïncider « haut de l'écran » et « nord »,
   comme sur une carte. L'inverse aurait produit des sites en miroir nord-sud.
   ============================================================================= */

/** Enregistrement `sites` tel que lu ici : seuls l'identité et les coordonnées comptent. */
export interface SiteGps { id: string; lat?: number | null; lon?: number | null; }
/** Position RÉELLE d'un site, en MÈTRES (est = +x, sud = +y), dans un plan local. */
export interface SiteRealPos { location: string; x: number; y: number; fromGps: boolean; }
/** Position d'AFFICHAGE d'un site, en MILLIMÈTRES monde, échelle appliquée. */
export interface SiteWorldPos { location: string; x: number; y: number; }
/** Réglage d'AFFICHAGE de l'échelle inter-sites — état de VUE, jamais du document. */
export interface SiteScale { metresPerKm: number; log: boolean; }

/** Rayon moyen de la Terre (m, WGS84) — projection équirectangulaire locale. */
export const EARTH_RADIUS_M = 6371008.8;
/** Repli quand les coordonnées manquent : le site est posé à 5 km du PRÉCÉDENT (doctrine §6.9). */
export const SITE_FALLBACK_STEP_M = 5000;
/** Échelle par défaut : 1 km réel = 10 m dans le monde 3D (facteur 1/100). */
export const SITE_SCALE_DEFAULT_M_PER_KM = 10;
/** Bornes du curseur d'échelle (m de monde 3D pour 1 km réel). */
export const SITE_SCALE_MIN_M_PER_KM = 1;
export const SITE_SCALE_MAX_M_PER_KM = 200;

const DEG_TO_RAD = Math.PI / 180;

export class SiteLayout {
  /** Échelle NORMALISÉE (bornée, défauts appliqués) — un réglage absent ou aberrant ne doit jamais
      produire un monde dégénéré (échelle nulle = tous les sites confondus à l'origine). */
  static normalizeScale(scale?: SiteScale | null): SiteScale {
    const raw = scale && typeof scale.metresPerKm === "number" && isFinite(scale.metresPerKm) ? scale.metresPerKm : SITE_SCALE_DEFAULT_M_PER_KM;
    return { metresPerKm: Math.max(SITE_SCALE_MIN_M_PER_KM, Math.min(SITE_SCALE_MAX_M_PER_KM, raw)), log: !!(scale && scale.log) };
  }

  /** Couple (lat, lon) exploitable d'un site, ou null. Les DEUX doivent être présents et finis :
      une latitude seule ne désigne aucun point (l'invariant de spec l'interdit déjà à l'écriture,
      on reste néanmoins tolérant en LECTURE — un document importé peut être partiel). */
  static gpsOf(site: SiteGps | null | undefined): { lat: number; lon: number } | null {
    if (!site) return null;
    const lat = Number(site.lat), lon = Number(site.lon);
    if (site.lat == null || site.lon == null || !isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  /** Positions RÉELLES (mètres) de TOUS les sites du modèle, dans l'ORDRE DE PARCOURS.

      `sites` est parcouru dans l'ordre de la COLLECTION (c'est lui que la doctrine désigne pour le
      repli) ; `extraLocations` reçoit les `location` référencées par le modèle sans enregistrement
      `sites` correspondant (ids historiques), triées pour rester déterministes, et vient APRÈS.

      Le repère de projection est ancré sur le PREMIER site géolocalisé rencontré : il n'existe pas
      de « bonne » origine absolue et un barycentre se déplacerait à chaque ajout de site. Un site
      sans coordonnées est posé à `SITE_FALLBACK_STEP_M` à l'EST de la position attribuée au site
      précédent — quelle que soit l'origine de celle-ci (GPS ou repli). */
  static realPositions(sites: ReadonlyArray<SiteGps>, extraLocations: ReadonlyArray<string> = []): SiteRealPos[] {
    const seen = new Set<string>();
    const order: Array<{ location: string; gps: { lat: number; lon: number } | null }> = [];
    (sites || []).forEach((s) => {
      const id = String(s && s.id != null ? s.id : "");
      if (seen.has(id)) return;
      seen.add(id); order.push({ location: id, gps: SiteLayout.gpsOf(s) });
    });
    (extraLocations || []).slice().sort().forEach((l) => {
      const id = String(l == null ? "" : l);
      if (seen.has(id)) return;
      seen.add(id); order.push({ location: id, gps: null });
    });

    const ref = order.find((o) => o.gps)?.gps || null;
    const out: SiteRealPos[] = [];
    let prev: { x: number; y: number } | null = null;
    order.forEach((o) => {
      let p: SiteRealPos;
      if (o.gps && ref) {
        // Δlongitude ramenée dans [-180, 180] : deux sites de part et d'autre du 180ᵉ méridien sont
        // voisins, pas aux antipodes. (Cas rare, mais l'écart serait de 40 000 km — pas subtil.)
        let dLon = o.gps.lon - ref.lon;
        while (dLon > 180) dLon -= 360;
        while (dLon < -180) dLon += 360;
        const x = EARTH_RADIUS_M * dLon * DEG_TO_RAD * Math.cos(ref.lat * DEG_TO_RAD);
        const y = -EARTH_RADIUS_M * (o.gps.lat - ref.lat) * DEG_TO_RAD;   // nord = -y (cf. en-tête)
        p = { location: o.location, x, y, fromGps: true };
      } else {
        p = { location: o.location, x: prev ? prev.x + SITE_FALLBACK_STEP_M : 0, y: prev ? prev.y : 0, fromGps: false };
      }
      out.push(p); prev = { x: p.x, y: p.y };
    });
    return out;
  }

  /** Positions RÉELLES (m) → positions d'AFFICHAGE (mm monde), échelle appliquée.

      CONVERSION : `metresPerKm` se lit « 1 km réel = N m dans le monde 3D ». 1 km = 1000 m réels
      → N m monde → N × 1000 mm. D'où, en simplifiant, `mm_monde = m_réels × metresPerKm` (défaut
      10 : 5 km de repli = 50 000 mm = 50 m).

      MODE LOGARITHMIQUE : la distance au BARYCENTRE des sites est remplacée par
      `D₀·ln(1 + d/D₀)`, direction conservée, avec D₀ = le pas de repli (5 km). Sous D₀ la
      déformation reste modérée, au-delà elle écrase fortement — c'est précisément l'usage visé,
      rapprocher des sites géographiquement lointains sans les confondre. Le barycentre est choisi
      comme centre parce qu'il est indépendant de l'ORDRE des sites, contrairement au premier d'entre
      eux (un mode d'affichage ne doit pas dépendre de l'ordre d'insertion).

      NORMALISATION finale : le monde est translaté pour que le plus petit x et le plus petit y
      valent 0. Deux raisons — les plans d'étage de l'application vivent en coordonnées positives, et
      le cas MONO-SITE retombe ainsi exactement sur l'origine, donc à la PARITÉ STRICTE avec le
      rangement historique. La translation se calcule sur TOUS les sites du modèle : un site masqué
      conserve donc sa place (§6.8). */
  static compress(real: ReadonlyArray<SiteRealPos>, scale?: SiteScale | null): SiteWorldPos[] {
    if (!real || !real.length) return [];
    const { metresPerKm, log } = SiteLayout.normalizeScale(scale);
    let pts = real.map((r) => ({ location: r.location, x: r.x, y: r.y }));
    if (log && pts.length > 1) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      pts = pts.map((p) => {
        const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
        if (d < 1e-9) return { location: p.location, x: cx, y: cy };   // site AU barycentre : direction indéfinie
        const k = (SITE_FALLBACK_STEP_M * Math.log(1 + d / SITE_FALLBACK_STEP_M)) / d;
        return { location: p.location, x: cx + dx * k, y: cy + dy * k };
      });
    }
    const world = pts.map((p) => ({ location: p.location, x: p.x * metresPerKm, y: p.y * metresPerKm }));
    let minX = Infinity, minY = Infinity;
    world.forEach((w) => { minX = Math.min(minX, w.x); minY = Math.min(minY, w.y); });
    return world.map((w) => ({ location: w.location, x: w.x - minX, y: w.y - minY }));
  }

  /** Raccourci de consommation : `location` → position monde (mm). Une `location` absente de la carte
      (donc inconnue du modèle) est à la charge de l'appelant — il n'y a pas de position par défaut
      qui soit juste, seulement une qui soit arbitraire. */
  static worldPositions(sites: ReadonlyArray<SiteGps>, extraLocations: ReadonlyArray<string> = [], scale?: SiteScale | null): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    SiteLayout.compress(SiteLayout.realPositions(sites, extraLocations), scale).forEach((w) => out.set(w.location, { x: w.x, y: w.y }));
    return out;
  }
}
