/* =============================================================================
   DeleteGuard — logique PURE des garde-fous de SUPPRESSION de certificats.

   Deux barrières indépendantes, et c'est voulu :
   - le SERVEUR exige `?force=true` pour tout certificat ENCORE VALIDE (seule
     protection quand on passe par l'API : là, il n'y a aucun prompt) ;
   - l'UI, elle, exige une INTENTION ÉCRITE avant d'envoyer ce `force`.

   Ce module ne contient QUE le calcul (aucun DOM, aucun réseau) : quelle
   cérémonie exiger, quel texte attendre, la saisie correspond-elle. Le dialogue
   et les appels REST vivent dans la vue.

   « ACTIF » = ni révoqué, ni expiré — MÊME définition que côté serveur
   (`CertsDb.isActive`). Duplication ASSUMÉE et signalée des deux côtés : le front
   ne peut pas importer un module serveur, et l'inverse non plus ; le serveur reste
   seul juge (l'UI ne fait qu'anticiper sa réponse pour choisir la cérémonie).
   ============================================================================= */
import { I18n } from "../i18n/I18n";

/** Ce dont le garde a besoin pour statuer (sous-ensemble d'un CertificateListItem). */
export interface DeletableCert { label?: string | null; revoked_at?: string | null; not_after?: string | null; }

/** Cérémonie exigée avant d'envoyer la suppression. */
export type DeleteCeremony =
  | { kind: "simple" }                                   // rien d'actif en jeu → confirmation ordinaire
  | { kind: "type-name"; expected: string }              // 1 certificat actif → recopier la phrase NOMMANT la cible
  | { kind: "type-phrase"; expected: string };           // lot → saisir la phrase de confirmation (de base)

export class DeleteGuard {
  /** Phrase à recopier pour un LOT (aucune cible unique à nommer). Volontairement une PHRASE (et non
      « OUI ») : assez longue pour qu'on ne la tape pas par réflexe. GETTER (et non constante) : le
      texte est LOCALISÉ, donc résolu via `I18n.t` À L'APPEL — jamais au chargement du module (avant
      `I18n.init()`). UNE SEULE clé sert d'invite affichée ET de référence de comparaison : `ceremony()`
      la capture dans `expected`, ce que l'UI affiche et compare — elles ne peuvent donc JAMAIS diverger. */
  static get PHRASE(): string { return I18n.t("certs.guard.phrase"); }

  /** Phrase NOMMANT la cible pour une suppression UNITAIRE d'un certificat encore valide :
      « Oui je supprime <label> ». Nommer explicitement l'objet dans la phrase (plutôt que recopier
      le seul nom) affirme l'INTENTION et vise CE certificat sans ambiguïté. MÊME source I18n que
      l'invite affichée (`ceremony().expected`) → invite et comparaison ne peuvent pas diverger. */
  static phraseFor(label: string): string { return I18n.t("certs.guard.phraseNamed", { label }); }

  /** Ni révoqué, ni expiré. `not_after` absent/illisible → ACTIF (on protège plutôt que de
      supposer l'expiration). Miroir EXACT de `CertsDb.isActive` côté serveur. */
  static isActive(c: DeletableCert, now: number = Date.now()): boolean {
    if (!c) return false;
    if (c.revoked_at) return false;
    if (!c.not_after) return true;
    const t = Date.parse(c.not_after);
    if (!isFinite(t)) return true;
    return t > now;
  }

  /** Combien d'ENCORE VALIDES dans un lot (sert à l'avertissement du dialogue). */
  static countActive(list: DeletableCert[], now: number = Date.now()): number {
    return (list || []).filter((c) => DeleteGuard.isActive(c, now)).length;
  }

  /** Quelle cérémonie exiger ?
      - 0 ou 1 élément NON actif → `simple` ;
      - 1 élément ACTIF → `type-name`, mais la phrase attendue NOMME la cible (« Oui je supprime
        <label> ») : on vise CE certificat, pas « un » certificat, et l'intention est affirmée ;
      - PLUSIEURS éléments → `type-phrase` (phrase de base), actifs ou non : le VOLUME est un risque
        en soi (une sélection se fait d'un glissement de souris), et il n'y a pas de cible unique à nommer.
      REPLI : un actif au libellé vide/blanc rendrait la phrase nommée intapable → on bascule sur la phrase de base. */
  static ceremony(list: DeletableCert[], now: number = Date.now()): DeleteCeremony {
    const items = list || [];
    if (items.length > 1) return { kind: "type-phrase", expected: DeleteGuard.PHRASE };
    const one = items[0];
    if (!one || !DeleteGuard.isActive(one, now)) return { kind: "simple" };
    const label = (one.label || "").trim();
    if (!label) return { kind: "type-phrase", expected: DeleteGuard.PHRASE };
    return { kind: "type-name", expected: DeleteGuard.phraseFor(label) };
  }

  /** La saisie lève-t-elle la cérémonie ? `trim` (une espace collée par un copier/coller ne doit pas
      punir) puis égalité STRICTE — la casse compte : c'est le point de friction recherché. */
  static accepts(ceremony: DeleteCeremony, typed: string): boolean {
    if (ceremony.kind === "simple") return true;
    return String(typed ?? "").trim() === ceremony.expected;
  }

  /** Faut-il poser `?force=true` pour CE certificat ? (le serveur ne l'exige que pour un actif) */
  static needsForce(c: DeletableCert, now: number = Date.now()): boolean { return DeleteGuard.isActive(c, now); }
}
