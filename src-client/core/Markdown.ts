import { micromark } from "micromark";

/* =============================================================================
   RENDU MARKDOWN — enveloppe FINE et UNIQUE autour de micromark.

   Point de configuration CENTRAL du rendu markdown de l'application (principe
   n°11 : librairie éprouvée retenue par l'utilisateur plutôt qu'un parseur
   maison). Tout rendu markdown passe par ici — jamais un appel direct à
   `micromark(...)` ailleurs — pour garantir UNE configuration cohérente et un
   SEUL endroit à auditer si la politique de sécurité doit évoluer.

   SÉCURITÉ (INVARIANT À NE PAS ROMPRE) : on s'en tient aux DÉFAUTS de micromark,
   qui sont sûrs. On n'active JAMAIS `allowDangerousHtml` ni
   `allowDangerousProtocol` :
     - `allowDangerousHtml` (désactivé par défaut) ⇒ le HTML brut présent dans
       l'entrée est NEUTRALISÉ (échappé) : une balise `<script>` ressort en
       « &lt;script&gt; », jamais comme balise active ;
     - `allowDangerousProtocol` (désactivé par défaut) ⇒ les protocoles d'URL
       dangereux (`javascript:`…) sont filtrés — l'attribut `href` produit est
       vidé, aucun lien actif n'est fabriqué.
   La sortie est donc directement injectable en `innerHTML` SANS passe
   d'assainissement supplémentaire. Ne PAS passer d'options à micromark depuis
   ici sans réévaluer cet invariant (ce serait rouvrir une surface XSS).
   ============================================================================= */
export class Markdown {
  /** Rend un texte markdown en HTML SÛR (défauts micromark). Entrée nulle/vide → "". */
  static render(texte: string | null | undefined): string {
    // Entrée vide/absente → chaîne vide : évite un `<p></p>` parasite et le coût d'un parse inutile.
    if (!texte) return "";
    return micromark(texte);
  }
}
