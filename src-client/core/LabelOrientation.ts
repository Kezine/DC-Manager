/* ============================================================================
   LABELORIENTATION — un identifiant se lit-il DIFFÉREMMENT à 180° ? Module PUR,
   testé (Tests/modules/test-labels.js). Documentation : docs/qr-scan.md
   § « Étiquettes imprimables ».

   LE PROBLÈME (retour terrain 2026-08-25). Le manchon « identifiant seul » ne
   porte QUE le numéro, répété autour du câble — aucun autre mot pour donner le
   sens de lecture. Un manchon posé dans l'autre sens se lit donc retourné, et
   `168` devient `891` : un identifiant parfaitement plausible. C'est le seul cas
   où quelqu'un peut débrancher le mauvais câble en ayant lu correctement.

   POURQUOI PAS « QUE DES CHIFFRES » (le critère spontané) : il attrape trop et
   trop peu à la fois.
     · `1234` n'est PAS dangereux — retourné, ses glyphes ne sont plus des
       chiffres du tout, on voit immédiatement que le manchon est à l'envers ;
     · `689` non plus — 6→9, 8→8, 9→6 puis ordre inversé : on relit `689`. Un
       nombre STROBOGRAMMATIQUE ne peut induire aucune erreur ;
     · `168` → `891` : voilà le vrai piège.
   Le critère est donc « TOUS les caractères ont une image par rotation ET la
   lecture retournée DIFFÈRE de l'originale ». Le repère porte alors une
   information — « attention, celui-ci est retournable » — au lieu d'être un
   ornement posé partout.

   TABLE : les chiffres qui se relisent comme un chiffre à 180° (`0 1 6 8 9`) et
   le tiret, séparateur courant des identifiants et invariant par rotation.
     · `1` est INCLUS bien que sa forme retournée soit imparfaite : l'inclure
       ÉLARGIT l'ensemble des identifiants jugés ambigus, donc protège plus. Un
       repère de trop est bénin ; un repère manquant sur `168` ne l'est pas.
     · `2` et `5` sont EXCLUS : ils ne se répondent qu'en affichage à segments,
       jamais en typographie — `25` retourné n'est pas un nombre.
     · Les LETTRES sont exclues en bloc : un mot latin retourné se reconnaît
       instantanément comme tel, l'ambiguïté ne naît que de chiffres nus.
   ============================================================================ */

/** Image de chaque caractère par une rotation de 180° (cf. en-tête pour les choix). */
const ROTATED: Readonly<Record<string, string>> = {
  "0": "0", "1": "1", "6": "9", "8": "8", "9": "6", "-": "-",
};

export class LabelOrientation {
  /** Lecture du texte tourné à 180°, ou `null` si un seul caractère n'a pas d'image
      (le texte est alors illisible à l'envers — donc sans ambiguïté possible). */
  static rotated(text: string): string | null {
    const source = String(text || "");
    if (!source) return null;
    let out = "";
    for (const char of source) {
      const image = ROTATED[char];
      if (image === undefined) return null;
      out = image + out;   // la rotation INVERSE aussi l'ordre de lecture
    }
    return out;
  }

  /** L'identifiant peut-il être lu comme un AUTRE identifiant plausible une fois
      retourné ? Vrai seulement si tout se relit ET que la lecture change. */
  static isAmbiguous(text: string): boolean {
    const flipped = LabelOrientation.rotated(text);
    return flipped !== null && flipped !== String(text || "");
  }
}
