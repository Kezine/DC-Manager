/* ============================================================================
   LABELHTML — rendu HTML PUR des étiquettes imprimables (lot E du chantier
   étiquettes QR). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».
   La maquette design-system/briefs/qr-etiquettes-imprimables-maquette.html FAIT
   FOI : structure (`.lab`, panneaux de drapeau, cellules de manchon, planche
   `.a4`) et registres typographiques portés d'elle.

   POURQUOI UN MODULE PUR (chaînes, pas de DOM) : le MÊME rendu sert DEUX
   surfaces — l'APERÇU de la modale (ui/LabelPrintDialog, mis à l'échelle) et le
   DOCUMENT D'IMPRESSION (iframe isolée, print-CSS embarquée). Écrire le label
   deux fois, c'est le voir diverger ; ici l'aperçu est fidèle PAR CONSTRUCTION.
   Corollaire : testable sous Node (Tests/modules/test-labels.js).

   NOIR SUR BLANC, TOUJOURS : l'imprimé ignore le thème de l'app — aucun token
   `var(--…)` du thème ici, uniquement des couleurs littérales. Le CSS est SCOPÉ
   sous `.label-render` pour cohabiter avec la feuille de l'app dans l'aperçu
   sans fuiter (l'imprimé, lui, n'a que ce CSS).

   Les QR arrivent DÉJÀ retravaillés (`core/LabelQrSvg.scaleToMm` — quiet zone
   garantie, cote en mm) : ce module les INLINE tels quels, il ne les touche pas.

   🚨 CHAMPS DÉCLARÉS PAR SUJET (retour terrain T10, 2026-09-02) : le sujet ne
   porte plus quatre champs FIGÉS (location/type/serial/owner) mais une LISTE de
   déclarations `LabelFieldDecl` — les spares/sous-équipements ne « reprenaient
   pas les bonnes infos » précisément parce que leurs caractéristiques (capacité,
   interface, achat…) n'avaient aucun nom dans le modèle figé. Ce module rend la
   liste GÉNÉRIQUEMENT (une ligne par déclaration cochée, registre typographique
   déclaré — les classes `.l-loc`/`.l-meta`/`.l-sn`/`.l-own` EXISTANTES, jamais
   de nouvelle typographie) ; seule l'anatomie STRUCTURELLE des câbles/faisceaux
   (extrémités A/B des drapeaux et manchons) reste hors liste.
   ============================================================================ */

import { Html } from "./Html";
import { LabelLayout } from "./LabelLayout";
import { LabelOrientation } from "./LabelOrientation";   // repère d'orientation des manchons « identifiant seul »
import { LabelPrintPolicy } from "./LabelPrintPolicy";   // règle contenu × champ (la MÊME que les cases du dialogue)
import type { LabelSpec } from "./LabelLayout";

/** Épaisseur du trait de coupe, en mm — LUE dans `LabelLayout` (source unique). Le CSS
    ci-dessous l'interpole : la valeur était écrite à cinq endroits, donc condamnée à
    diverger de la géométrie qui, elle, calcule la capacité de la planche avec. */
const CUT = LabelLayout.CUT_MM;

/** Registres typographiques d'une ligne d'étiquette — les classes `.l-*` du CSS ci-dessous,
    HÉRITÉES du modèle figé (l'imprimé équipement/baie/câble d'avant T10 doit rester identique) :
      · `loc`  = mono, une ligne (emplacement, caractéristiques techniques) ;
      · `meta` = sans-serif grise (type/famille, marque/modèle, achat) ;
      · `sn`   = mono grise (n° de série) ;
      · `own`  = capitales espacées (propriétaire — aussi la bande sous le carré en « QR seul »). */
export type LabelFieldStyle = "loc" | "meta" | "sn" | "own";

/** UN champ imprimable DÉCLARÉ par un sujet (décision Q10.B du retour terrain T10) :
    l'UI du dialogue se PEINT depuis ces déclarations, le rendu les consomme telles
    quelles. Un sujet ne déclare JAMAIS un champ à valeur vide — le « pas de case
    sans donnée » est STRUCTUREL (décision Q10.C), plus une règle d'interface. */
export interface LabelFieldDecl {
  /** Identité STABLE de la case — clé de la mémoire de session et de l'union de planche
      (deux sujets qui déclarent le même id partagent la même case du dialogue). */
  id: string;
  /** Libellé de la case (déjà localisé par `LabelSubjects`). */
  label: string;
  /** Valeur composée à imprimer — non vide par construction. */
  value: string;
  /** Cochée par défaut au premier tirage du contexte. */
  checked: boolean;
  /** Registre typographique de la ligne imprimée. */
  style: LabelFieldStyle;
  /** Ligne SUPPRIMÉE au registre S (héritage du modèle figé : type/série d'un équipement
      n'ont jamais tenu sur 50 × 20 — les déclarations du petit matériel ne le posent PAS,
      leur gabarit par défaut EST le S et leur contenu est la raison d'être de T10). */
  hideOnSmall?: boolean;
  /** Survit au contenu « QR seul » — rendue en bande sous le carré (historiquement le
      propriétaire, seul champ que ce contenu conservait). */
  qrOnly?: boolean;
}

/** Matière d'UNE étiquette — préparée par `core/LabelSubjects` depuis le store. */
export interface LabelSubject {
  collection: string;
  id: string;
  /** Identifiant imprimé (nom / désignation) — seul champ TOUJOURS rendu. */
  name: string;
  /** Champs imprimables DÉCLARÉS (T10) — jamais de valeur vide (cf. `LabelFieldDecl`). */
  fields: LabelFieldDecl[];
  /** Câble/faisceau SEULEMENT : extrémités A / B — STRUCTURELLES (drapeau, manchon
      « repère complet »), elles ne rejoignent pas la liste déclarée : leur rendu est
      une ANATOMIE (panneaux, `<b>A</b>`/`<b>B</b>`), pas une ligne générique. */
  endA?: string;
  endB?: string;
}

/** Une déclaration de fonte EMBARQUÉE pour le document d'impression (cf. `fontFaceCss`).
    `src` = un data: URI complet — l'iframe d'impression ne résout aucune URL relative. */
export interface LabelFontFace {
  family: string;
  weight: number;
  src: string;
  /** Subset couvert (latin / latin-ext…). Absent = la fonte vaut pour tout le texte. */
  unicodeRange?: string;
}

/** Choix de rendu d'un tirage — l'état des cases du dialogue, appliqué à CHAQUE sujet :
    `checked[id]` vaut pour la déclaration portant cet id (un sujet qui ne le déclare pas
    saute simplement la ligne — c'est ce qui rend la planche MULTI-SUJETS hétérogène sûre),
    `ends` est la bascule STRUCTURELLE « Extrémités A / B » des sujets à drapeau. */
export interface LabelFieldChoice {
  ends: boolean;
  checked: Readonly<Record<string, boolean>>;
}

export class LabelHtml {
  /** CSS des étiquettes — UNE source pour l'aperçu ET l'imprimé (cf. en-tête).
      Porté de la maquette, scopé `.label-render`, couleurs littérales seulement.
      ⚠ Les PADDINGS et GOUTTIÈRES des étiquettes ne vivent PLUS ici : ils sont
      calculés par `LabelLayout` (table des densités, clamp anti-débordement) et
      posés INLINE par `label()` — les tests vérifient les cotes AU MILLIMÈTRE
      dans le HTML généré, ce qu'une règle CSS de classe rendrait invisible.
      MÊME DOCTRINE pour les CASES DE MANCHON (`.cell2`), qui sont passées de
      `flex:1` à `flex:none` + largeur posée inline : `flex:1` répartissait un
      RESTE calculé par le moteur de flexbox — rien ne posait leur égalité, rien
      ne pouvait la vérifier. Le filet de séparation reste, lui, dans le CSS
      (c'est une décoration, pas une cote) : `border-right` sur TOUTES les cases
      sans exception — retirer celui de la dernière élargirait sa boîte de
      contenu de 0,2 mm et recréerait, en miniature, le défaut signalé. C'est la
      zone hachurée `.ov` qui a perdu son `border-left` (plus de double trait au
      raccord), la dernière case portant `fold` pour marquer le pli d'un filet
      plus sombre — même géométrie, autre couleur.
      La typographie COMPACTE se resserre en fin de feuille (`.lab.compact`).
      🚨 TYPOGRAPHIE STABLE À L'IMPRESSION (retour terrain 2026-08-25 : « l'espacement
      entre les chiffres n'est pas constant, contrairement à l'aperçu »). C'est bien le
      MÊME HTML et le MÊME CSS des deux côtés — mais le navigateur REFAIT la mise en page
      contre les métriques de l'imprimante, et deux choses dérivaient alors :
        · `system-ui`/`ui-monospace` sont des familles RÉSOLUES PAR LE SYSTÈME : rien ne
          garantit que le chemin d'impression tombe sur la même police que l'écran, et une
          autre police = d'autres chasses. Les piles nomment donc des familles CONCRÈTES,
          en tête desquelles **IBM Plex Sans, EMBARQUÉE** dans le document d'impression
          (`fontFaceCss` — data: URI, cf. sa doc) : la seule façon d'ÊTRE SÛR que les deux
          surfaces dessinent avec la même fonte, plutôt que d'espérer que le système
          choisisse la même des deux côtés. ⚠ Il n'existe pas de MONOSPACE vendorée dans le
          dépôt : `--lp-mono` retombe donc lui aussi sur Plex Sans, et c'est
          `tabular-nums` (ci-dessous) qui garantit l'alignement des CHIFFRES — l'identité
          visuelle « chasse fixe » des identifiants est, elle, perdue tant qu'une Plex Mono
          n'est pas ajoutée à `src-client/fonts/` ;
        · les avances de glyphes sont ARRONDIES aux points de l'imprimante, et
          `letter-spacing:-.02em` (fractionnaire, négatif) s'arrondissait différemment
          d'une paire à l'autre — d'où des chiffres inégalement espacés. Le crénage est
          désormais nul, `text-rendering:geometricPrecision` demande des avances EXACTES
          plutôt qu'ajustées à la grille, et `font-variant-numeric:tabular-nums` impose des
          chiffres de largeur ÉGALE même si une police proportionnelle finit par gagner.
      🚨 TRAITS DE COUPE — l'ÉPAISSEUR était la vraie cause. Quatre passes, et seule la
      dernière touche juste ; les trois premières sont conservées ci-dessous parce qu'elles
      décrivent des pièges réels, mais AUCUNE n'expliquait le symptôme :
        · pointillés → SOLIDES (un pointillé de 0,2 mm fait ~50 tirets par bord) : n'a pas
          suffi, le terrain a re-signalé des interruptions avec des traits pleins ;
        · `content-box` puis `::after` ABSOLU, sur l'idée que le trait était RECOUVERT (une
          bordure se peint sous le contenu du parent) : n'a pas suffi non plus. Les deux
          restent justes en soi — le `::after` met le trait hors de portée de tout fond
          opaque, et `content-box` fait que la cote posée est celle de l'étiquette ;
        · 🚨 LA cause, trouvée par l'utilisateur qui a su la REPRODUIRE : **le défaut
          apparaît et disparaît selon le ZOOM du navigateur.** C'est la signature d'un filet
          SOUS-PIXEL — 0,2 mm ≈ 0,76 px CSS, donc selon l'endroit où chaque ligne tombe, le
          rasteur en met 1 pixel… ou 0. Rien ne recouvrait quoi que ce soit : les lignes
          n'étaient tout simplement pas dessinées. `CUT_MM` passe donc à **0,5 mm** (≈ 1,9 px,
          survit à l'arrondi même à 50 % d'échelle) — et cette valeur est désormais une
          SOURCE UNIQUE, lue depuis `LabelLayout` et interpolée ici.
      Le trait vit dans la GOUTTIÈRE de la grille (`gap:${CUT}mm`) : il sépare réellement deux
      cellules au lieu de mordre sur l'étiquette voisine, et la capacité de la planche le
      compte (N cellules + N−1 gouttières). Les traits du POURTOUR, eux, sont tirés dans la
      marge de 8 mm — ils ne coûtent rien.
      ⚠ Corollaire : `.cell` n'a PLUS `overflow:hidden` (il rognerait ce débord). C'est sans
      risque — `.lab` clippe déjà son propre contenu et sa cote est CELLE de la cellule.
      🚨 `print-color-adjust:exact` sur `.label-render` (retour terrain 2026-08-25) :
      sans lui, le navigateur SUPPRIME à l'impression tout ce qui est une IMAGE DE
      FOND — et les zones de recouvrement des manchons/drapeaux sont hachurées par
      `repeating-linear-gradient`. Elles apparaissaient donc à l'aperçu et sortaient
      BLANCHES sur le papier, ce qui fait perdre au poseur le repère du pli. La
      propriété est héritée : la poser sur le conteneur couvre tout le rendu, et
      garantit du même coup que les gris (#333/#444/#666/#999) ne soient pas
      « optimisés » par le pilote. */
  static readonly CSS = `
.label-render{--lp-mono:"IBM Plex Sans","Consolas","DejaVu Sans Mono","Liberation Mono","Courier New",monospace;--lp-sans:"IBM Plex Sans","Segoe UI","DejaVu Sans","Liberation Sans",Arial,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact;text-rendering:geometricPrecision;font-variant-ligatures:none;font-kerning:none;font-variant-numeric:tabular-nums}
.label-render *{box-sizing:border-box}
.label-render .lab{background:#fff;color:#000;display:flex;align-items:center;overflow:hidden;font-family:var(--lp-sans)}
.label-render .lab *{color:#000}
.label-render .lab svg{flex:none;display:block}
.label-render .lab .txt{min-width:0;display:flex;flex-direction:column;gap:.6mm}
.label-render .lab .l-id{font-family:var(--lp-mono);font-weight:700;line-height:1.08;letter-spacing:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.label-render .lab .l-loc{font-family:var(--lp-mono);line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.label-render .lab .l-meta{line-height:1.15;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.label-render .lab .l-sn{font-family:var(--lp-mono);color:#444;line-height:1.1}
.label-render .lab .l-own{font-family:var(--lp-sans);text-transform:uppercase;letter-spacing:.07em;color:#222;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.label-render .lab .rule{height:.35mm;background:#000;width:100%;margin:.8mm 0}
.label-render .lab.s .l-id{font-size:8pt}.label-render .lab.s .l-loc{font-size:6.5pt}.label-render .lab.s .l-meta{font-size:5.5pt}.label-render .lab.s .l-sn{font-size:5pt}.label-render .lab.s .l-own{font-size:5pt}
.label-render .lab.m .l-id{font-size:8.5pt}.label-render .lab.m .l-loc{font-size:7pt}.label-render .lab.m .l-meta{font-size:6pt}.label-render .lab.m .l-sn{font-size:5.5pt}.label-render .lab.m .l-own{font-size:5.5pt}
.label-render .lab.l .l-id{font-size:12pt}.label-render .lab.l .l-loc{font-size:9pt}.label-render .lab.l .l-meta{font-size:7.5pt}.label-render .lab.l .l-sn{font-size:7pt}.label-render .lab.l .l-own{font-size:7pt}
.label-render .lab.rack{align-items:center}
.label-render .lab.rack .l-id{font-size:26pt;letter-spacing:0}
.label-render .lab.rack .l-loc{font-size:12pt;white-space:normal}
.label-render .lab.rack .l-meta{font-size:9pt}.label-render .lab.rack .l-sn{font-size:8pt}.label-render .lab.rack .l-own{font-size:9pt}
.label-render .lab.qronly{justify-content:center;flex-direction:column}
.label-render .lab.qronly .txt{align-items:center;width:100%}
.label-render .lab.qronly .l-own{text-align:center}
.label-render .lab.cable{padding:0;gap:0;align-items:stretch}
.label-render .lab.cable .pan{flex:none;display:flex;align-items:center;justify-content:center;gap:1.2mm;overflow:hidden}
.label-render .lab.cable .pan.b{justify-content:flex-start}
.label-render .lab.cable .wz{flex:none;border-left:.2mm dashed #999;border-right:.2mm dashed #999;background:repeating-linear-gradient(45deg,#fff 0 1mm,#e9e9e9 1mm 2mm)}
.label-render .lab.cable .txt{gap:.4mm}
.label-render .lab.cable .l-id{font-size:7pt;line-height:1.1}
.label-render .lab.cable .l-loc,.label-render .lab.cable .l-meta,.label-render .lab.cable .l-own{font-size:5pt;white-space:normal;overflow-wrap:anywhere;line-height:1.2}
.label-render .lab.cable .l-loc b{font-family:var(--lp-mono);font-weight:700;color:#000}
.label-render .lab.cable.strip{align-items:stretch;gap:0;padding:0}
.label-render .lab.cable.strip .cell2{flex:none;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1mm 0;overflow:hidden;border-right:.2mm dashed #ccc;writing-mode:vertical-rl}
.label-render .lab.cable.strip .cell2.fold{border-right-color:#999}
.label-render .lab.cable.strip .cell2 .l-id{font-size:8pt;letter-spacing:0;display:block;white-space:nowrap;text-overflow:ellipsis;max-width:100%}
.label-render .lab.cable.strip .cell2 .l-id.flip{text-decoration:underline;text-decoration-thickness:.4mm;text-underline-offset:.35mm;text-decoration-skip-ink:none}
.label-render .lab.cable.strip .cell2 .l-loc,.label-render .lab.cable.strip .cell2 .l-own{font-size:5pt;white-space:normal;overflow-wrap:anywhere;text-align:start;max-height:100%}
.label-render .lab.cable.strip .ov{flex:none;background:repeating-linear-gradient(45deg,#fff 0 1mm,#e9e9e9 1mm 2mm)}
.label-render .lab.compact .txt{gap:.2mm}
.label-render .lab.compact .rule{margin:.4mm 0}
.label-render .a4{width:${LabelLayout.A4_W}mm;height:${LabelLayout.A4_H}mm;background:#fff;padding:${LabelLayout.A4_MARGIN}mm;display:grid;gap:${CUT}mm;align-content:start;justify-content:start}
.label-render .a4 .cell{position:relative;box-sizing:content-box;display:flex;align-items:center;justify-content:center}
.label-render .a4 .cell::after{content:"";position:absolute;top:0;left:0;right:-${CUT}mm;bottom:-${CUT}mm;border:0 solid #999;border-right-width:${CUT}mm;border-bottom-width:${CUT}mm;pointer-events:none}
.label-render .a4 .cell.cut-t::after{top:-${CUT}mm;border-top-width:${CUT}mm}
.label-render .a4 .cell.cut-l::after{left:-${CUT}mm;border-left-width:${CUT}mm}
.label-render .a4 .cell.nocut::after{content:none}
.label-render .a4-head{display:flex;justify-content:space-between;font-family:var(--lp-mono);font-size:6pt;color:#666;grid-column:1/-1;padding-bottom:2mm}
.label-render .a4-head span{color:#666}
.label-render .unit{background:#fff;display:flex;align-items:flex-start;justify-content:flex-start}
`;

  /* -------------------------------- une étiquette -------------------------------- */

  /** Une étiquette — HTML autonome (styles inline pour les COTES, classes pour la
      typographie). `qrSvg` = SVG déjà mis à l'échelle (`LabelQrSvg.scaleToMm`,
      cote = `LabelLayout.qrSizeOf(spec)` mm) — vide pour les manchons.
      `dims` (optionnel) force les cotes : sur une PLANCHE, l'étiquette prend la
      taille de sa CELLULE (cf. LabelLayout, « cellule ≠ étiquette »).

      T10 : les lignes viennent des DÉCLARATIONS du sujet — cochées via `choice.checked`
      et filtrées par la MÊME règle contenu × champ que les cases du dialogue
      (`LabelPrintPolicy.fieldVisible` : une case masquée ne s'imprime jamais). Un sujet
      d'une planche hétérogène qui ne déclare pas un id coché saute la ligne. */
  static label(subject: LabelSubject, spec: LabelSpec, choice: LabelFieldChoice, qrSvg: string, dims?: [number, number]): string {
    const esc = Html.escape;
    const cp = spec.compact;
    const lineOf = (f: LabelFieldDecl): string => `<div class="l-${f.style}">${esc(f.value)}</div>`;
    const checked = (subject.fields || []).filter((f) => choice.checked[f.id] && LabelPrintPolicy.fieldVisible(f, spec.content));
    // Extrémités A / B — anatomie STRUCTURELLE des sujets à drapeau (hors liste déclarée, T10).
    const endLines = choice.ends && (subject.endA || subject.endB)
      ? `<div class="l-loc"><b>A</b> ${esc(subject.endA || "")}</div><div class="l-loc"><b>B</b> ${esc(subject.endB || "")}</div>`
      : "";
    const mm = (v: number) => +v.toFixed(2);
    // Les CASES de manchon se posent au MILLIÈME de mm, pas au centième comme les autres
    // cotes : elles sont répétées jusqu'à 20 fois, et un arrondi au centième laisserait un
    // reste cumulé allant jusqu'à 0,1 mm entre la somme des cases et la partie visible.
    // Au millième le reste tombe sous 0,01 mm — très en dessous du pixel d'impression,
    // et absorbé par l'`overflow:hidden` de l'étiquette.
    const mm3 = (v: number) => +v.toFixed(3);

    if (spec.size === "cable") {
      if (spec.content === "strip" || spec.content === "id") {
        // MANCHON sans QR. Les cases se partagent la partie VISIBLE — soit EXACTEMENT un
        // tour depuis l'amendement de l'enroulement (1,5 tour dont le demi-tour excédentaire
        // EST le recouvrement, cf. LabelLayout.sleeveGeometry) — et leur nombre est DÉDUIT
        // de cette longueur : un Ø 20 porte plus de repères qu'un Ø 3, au lieu de six cases
        // figées dont la largeur variait du simple au septuple. Le « repère complet » garde
        // ses deux panneaux (texte riche), sur la même assiette et à la même cote exacte.
        const g = LabelLayout.sleeveGeometry(spec.dia, spec.len);
        const idOnly = spec.content === "id";
        const count = idOnly ? LabelLayout.sleeveRepeats(g.visible) : LabelLayout.SLEEVE_STRIP_PANELS;
        const cellW = mm3(LabelLayout.sleeveCellWidth(g.visible, count));
        // Sur un manchon le texte est VERTICAL et étroit : toute déclaration se rend dans le
        // registre mono `l-loc` (comme le type du modèle figé), sauf `own` qui garde ses
        // capitales — même typographie qu'avant T10, appliquée à la liste déclarée.
        const extra = idOnly ? "" :
          endLines + checked.map((f) => f.style === "own" ? lineOf(f) : `<div class="l-loc">${esc(f.value)}</div>`).join("");
        // TOUTES les cases portent la MÊME largeur posée — l'égalité est une cote, pas un
        // reste réparti. Seule la dernière ajoute `fold` : le filet qui la termine borne la
        // partie visible (là où le manchon commence à se recouvrir), d'où sa couleur plus
        // sombre ; c'est aussi pour ça que `.ov` n'a plus de bordure gauche (double trait).
        /* REPÈRE D'ORIENTATION (retour terrain 2026-08-25) : ce format ne porte QUE le
           numéro, répété autour du câble — rien n'indique le sens de lecture, et un manchon
           posé à l'envers fait lire `168` comme `891`. On souligne alors l'identifiant.
           Réservé à « identifiant seul » : le « repère complet » affiche A/B et le type,
           dont le sens de lecture est évident (décision utilisateur). Et réservé aux
           identifiants RÉELLEMENT ambigus — cf. `LabelOrientation`, qui écarte aussi bien
           `1234` (illisible retourné) que `689` (qui se relit à l'identique). */
        const flipRisk = idOnly && LabelOrientation.isAmbiguous(subject.name);
        let cells = "";
        for (let i = 0; i < count; i++) {
          cells += `<div class="cell2${i === count - 1 ? " fold" : ""}" style="width:${cellW}mm">`
            + `<div class="l-id${flipRisk ? " flip" : ""}">${esc(subject.name)}</div>${extra}</div>`;
        }
        return `<div class="lab cable strip${cp ? " compact" : ""}" style="width:${mm(g.w)}mm;height:${mm(g.h)}mm">${cells}<div class="ov" style="width:${mm(g.overlap)}mm"></div></div>`;
      }
      // DRAPEAU : QR à gauche, texte (ou second QR — « scannable des deux faces ») à
      // droite, zone d'enroulement hachurée entre les deux. Géométrie dérivée du QR.
      const g = LabelLayout.flagGeometry(LabelLayout.qrSizeOf(spec), cp);
      const t = `<div class="l-id">${esc(subject.name)}</div>` + endLines + checked.map(lineOf).join("");
      const panB = spec.content === "qr" ? qrSvg : `<div class="txt">${t}</div>`;
      return `<div class="lab cable${cp ? " compact" : ""}" style="width:${mm(g.w)}mm;height:${mm(g.h)}mm">`
        + `<div class="pan" style="width:${g.pan}mm;padding:${g.pad}mm">${qrSvg}</div>`
        + `<div class="wz" style="width:${g.wz}mm"></div>`
        + `<div class="pan b" style="width:${g.pan}mm;padding:${g.pad}mm">${panB}</div></div>`;
    }

    const [w, h] = dims || LabelLayout.labelDims(spec);
    const cls = spec.size === "custom" ? LabelLayout.fontClassForHeight(h) : spec.size;

    if (spec.content === "qr") {
      // QR SEUL : carré (QR + marges), éventuelle bande sous le carré — `checked` ne
      // contient déjà PLUS que les déclarations `qrOnly` (fieldVisible), historiquement
      // le propriétaire ; la géométrie du carré suit la présence de la bande.
      const g = LabelLayout.qrOnlyGeometry(spec.qr, cp, checked.length > 0);
      return `<div class="lab ${cls} qronly${cp ? " compact" : ""}" style="width:${mm(g.side)}mm;height:${mm(g.side)}mm;padding:${g.pad}mm;gap:${g.gap}mm">${qrSvg}${checked.length ? `<div class="txt">${checked.map(lineOf).join("")}</div>` : ""}</div>`;
    }

    // QR + TEXTE (gabarits S/M/L/Baie/personnalisé) : QR TOUJOURS à gauche (la main
    // sait où viser sans lire), colonne de texte à droite — anatomie de la maquette.
    // Padding/gouttière INLINE depuis LabelLayout (table des densités + clamp du QR
    // des préréglages — bug S : en confort la marge cède, jamais la scannabilité).
    const rg = LabelLayout.rectQrGeometry(spec, h);
    const big = cls === "l" || cls === "rack";
    // Registre S : seules les déclarations marquées `hideOnSmall` sautent (héritage du
    // modèle figé — type/série d'un équipement) ; celles du petit matériel (T10) restent,
    // le S est leur gabarit PAR DÉFAUT (d'où les tailles `.lab.s .l-meta/.l-sn` du CSS).
    const lines = checked.filter((f) => !(f.hideOnSmall && cls === "s"));
    let t = `<div class="l-id">${esc(subject.name)}</div>`;
    // Filet séparateur des grands gabarits : AVANT la première ligne d'un registre autre
    // que `loc` — la position qu'il occupait dans le modèle figé (après l'emplacement,
    // avant type/série/propriétaire), exprimée sur la liste déclarée.
    const firstSecondary = lines.findIndex((f) => f.style !== "loc");
    lines.forEach((f, index) => {
      if (big && index === firstSecondary) t += `<div class="rule"></div>`;
      t += lineOf(f);
    });
    return `<div class="lab ${cls}${cp ? " compact" : ""}" style="width:${mm(w)}mm;height:${mm(h)}mm;padding:${mm(rg.padV)}mm ${mm(rg.padH)}mm;gap:${mm(rg.gap)}mm">${qrSvg}<div class="txt">${t}</div></div>`;
  }

  /* ---------------------------------- planche ---------------------------------- */

  /** UNE page de planche A4 : en-tête hors zone (source · compte/date) + grille de
      cellules. `cellsHtml` = étiquettes de CETTE page (≤ perPage), déjà rendues aux
      cotes de la cellule. `cuts` = traits de coupe pointillés (désactivables).

      🚨 LE RECTANGLE DE COUPE ÉPOUSE L'ÉTIQUETTE (retour terrain 2026-08-25). Deux
      défauts tenaient à la même cause — la cellule n'avait pas la taille de ce qu'elle
      contient :
        · les colonnes étaient en `1fr`, donc larges de 194/cols mm quelle que soit
          l'étiquette. Un manchon de 28 mm se retrouvait CENTRÉ dans une colonne de
          65 mm : couper sur les traits laissait deux bandes de papier mort. On pose
          donc la LARGEUR RÉELLE de la cellule et des colonnes `auto`, la grille étant
          calée à gauche (`justify-content:start` — sans quoi des pistes `auto`
          s'étirent pour remplir la page, et le `1fr` reviendrait par la bande) ;
        · en `border-box`, le trait de 0,2 mm était PRIS SUR la cellule : le contenu ne
          faisait plus que 24,8 mm pour une étiquette de 25, qui débordait donc et
          arrivait au contact du trait (l'étiquette est peinte APRÈS la bordure de son
          parent). D'où `content-box` : la cote posée est celle de l'étiquette, et les
          traits se dessinent EN DEHORS d'elle.
      Effet de bord assumé : les traits ajoutent ≤ 0,2 mm par cellule, soit ~1 mm sur
      une rangée de 5 — pris sur la marge de 8 mm de la page, jamais sur l'étiquette. */
  static sheetPage(cellsHtml: string[], layout: { cols: number; cellW: number; cellH: number }, opts: { source: string; headRight: string; cuts: boolean }): string {
    const esc = Html.escape;
    /* 🚨 TRAITS DE COUPE — UN trait par ARÊTE, jamais deux (retour terrain 2026-08-25 :
       « les lignes de découpe ne sont pas dessinées correctement »). Une bordure sur les
       QUATRE côtés de chaque cellule faisait border-right de A et border-left de B se
       toucher : le trait intérieur sortait deux fois plus épais que le trait de bord, et
       les DEUX pointillés, calés chacun sur sa propre phase, se décalaient l'un de
       l'autre — d'où l'aspect brouillon à l'impression. Chaque cellule ne peint donc plus
       que son bord DROIT et son bord BAS ; la première rangée et la première colonne
       ajoutent le bord manquant du pourtour. Le calcul se fait ICI, où l'on connaît le
       nombre de colonnes ET l'index — le CSS seul ne saurait pas le dire, `cols` étant
       dynamique. */
    const cells = cellsHtml.map((c, index) => {
      const edges = opts.cuts
        ? " " + [index < layout.cols ? "cut-t" : "", index % layout.cols === 0 ? "cut-l" : ""].filter(Boolean).join(" ")
        : " nocut";
      return `<div class="cell${edges.trimEnd()}" style="width:${+layout.cellW.toFixed(2)}mm;height:${+layout.cellH.toFixed(2)}mm">${c}</div>`;
    }).join("");
    return `<div class="a4" style="grid-template-columns:repeat(${layout.cols},auto)">`
      + `<div class="a4-head"><span>${esc(opts.source)}</span><span>${esc(opts.headRight)}</span></div>${cells}</div>`;
  }

  /* ----------------------------- document d'impression ----------------------------- */

  /** Déclarations `@font-face` d'une fonte EMBARQUÉE (data: URI), à passer à
      `printDocument`. Le document d'impression est une iframe ISOLÉE : il ne voit ni la
      feuille de l'app ni ses `url(../fonts/…)`. Sans ces déclarations, il retombe sur une
      police du système — et une autre police, ce sont d'autres chasses, donc un imprimé
      qui ne ressemble plus à l'aperçu (retour terrain 2026-08-25).

      🚨 Les URI arrivent par INJECTION, jamais par import : ce module est PUR et compilé
      SANS webpack pour les tests Node (un `import … from "*.woff2"` y serait irrésolu).
      C'est `ui/LabelPrintDialog` — qui vit, lui, dans le monde webpack — qui importe les
      woff2 (inlinés en data: URI par `asset/inline`) et passe le résultat ici. */
  static fontFaceCss(faces: readonly LabelFontFace[]): string {
    return faces.map((face) =>
      `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:block;`
      + `src:url(${face.src}) format("woff2");`
      + (face.unicodeRange ? `unicode-range:${face.unicodeRange};` : "")
      + "}",
    ).join("");
  }

  /** Document d'IMPRESSION complet (iframe isolée) : print-CSS embarquée noir sur
      blanc, `@page` à la taille voulue — `pageSize` = `"A4"` (planche) ou
      `"<w>mm <h>mm"` (unitaire : page à la taille EXACTE de l'étiquette, ce qui
      passe tel quel sur une imprimante à rouleau Brother/Dymo). Les pages
      `.a4`/`.unit` se suivent avec saut de page. */
  static printDocument(opts: { title: string; pageSize: string; pagesHtml: string; fontCss?: string }): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${Html.escape(opts.title)}</title><style>`
      + `html,body{margin:0;padding:0;background:#fff}`
      + (opts.fontCss || "")
      + LabelHtml.CSS
      + `@page{size:${opts.pageSize};margin:0}`
      + `.label-render .a4,.label-render .unit{page-break-after:always}`
      + `.label-render .a4:last-child,.label-render .unit:last-child{page-break-after:auto}`
      + `</style></head><body><div class="label-render">${opts.pagesHtml}</div></body></html>`;
  }
}
