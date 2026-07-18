/* =============================================================================
   BulkActions — logique PURE des OPÉRATIONS GROUPÉES de la page « Certificats »
   (aucun DOM, aucun réseau) : calcule quelles actions sont COMMUNES à une sélection
   (l'INTERSECTION, selon les snapshots + l'état de session) et partitionne une
   sélection à exporter entre éléments retenus et éléments EXCLUS car révoqués.

   Pourquoi une classe pure dédiée (principes n°2/n°7) : la règle d'intersection est
   le cœur métier de la barre de sélection (« quels boutons proposer ? ») et se teste
   en isolation (Tests/modules/test-certs.js). La vue (CertsAdminView) ne fait
   qu'assembler le DOM à partir de la décision rendue ici, en parité STRICTE avec les
   actions par ligne (cadrage certs 2026-07-15 §5).

   PARITÉ AVEC LES ACTIONS PAR LIGNE : dans la vue, TOUTES les actions de clé
   (export privé, révoquer, supprimer) sont réservées à la session DÉVERROUILLÉE ;
   seule persiste, verrouillée, l'export des artefacts PUBLICS. On applique ici la
   même règle : verrouillée → seul l'export (publics) reste ; révoquer/supprimer
   exigent le déverrouillage. Révoquer est en plus INTERDIT si un seul élément est
   déjà révoqué (rien de commun à révoquer).
   ============================================================================= */
import type { ExportCategoryKey } from "./CertZip";
import { I18n } from "../i18n/I18n";

/** Instantané MINIMAL d'un certificat sélectionné (mémorisé par la vue, `id` = clé de la Map).
    Suffit à décider les actions communes ET à afficher un bilan lisible (label). */
export interface CertSelectionSnapshot {
  /** Famille (root-ca / leaf-tls / ssh-ca / ssh-keypair / ssh-cert). */
  kind: string;
  label: string;
  /** Une clé privée chiffrée est-elle détenue ? (l'export inclura la clé si déverrouillé ET has_key). */
  has_key: boolean;
  /** Horodatage de révocation (null = actif) — un révoqué est exclu des exports (décision Q4). */
  revoked_at: string | null;
  /** Fin de validité — avec `revoked_at`, détermine si le certificat est ENCORE VALIDE, donc si sa
      suppression exige une intention explicite (cf. DeleteGuard / garde `force` du serveur). */
  not_after: string | null;
}

/** Décision d'affichage de la barre d'actions groupées : quels boutons proposer + libellé d'export. */
export interface BulkActionAvailability {
  /** Bouton « Exporter » toujours offert dès qu'il y a une sélection (au moins les artefacts publics). */
  canExport: boolean;
  /** Libellé du bouton d'export : « Exporter (ZIP) » (déverrouillé, clés incluses là où détenues) ou
      « Exporter publics (ZIP) » (verrouillé — aucune clé privée n'entrera dans le ZIP). */
  exportLabel: string;
  /** Les clés privées seront-elles incluses dans le ZIP ? (vrai ssi session déverrouillée.) */
  withPrivateKeys: boolean;
  /** « Révoquer » : proposé seulement si déverrouillé ET aucun sélectionné n'est déjà révoqué. */
  canRevoke: boolean;
  /** « Supprimer » : proposé si déverrouillé (parité action par ligne — un révoqué reste supprimable). */
  canDelete: boolean;
}

/** Partition d'une sélection à exporter : ids RETENUS vs ids EXCLUS car révoqués (signalés au bilan). */
export interface ExportPartition {
  included: string[];
  excludedRevoked: string[];
}

/** Une CATÉGORIE d'artefacts proposée au DIALOGUE d'export groupé : sa clé STABLE (partagée avec l'assemblage
    CertZip.bundleFor), son libellé UI et sa DISPONIBILITÉ. Une catégorie n'est `available` que si elle a du
    sens pour TOUS les éléments NON RÉVOQUÉS de la sélection (cf. exportChoices). */
export interface ExportChoice {
  key: ExportCategoryKey;
  label: string;
  available: boolean;
}

/** CLÉS i18n des libellés UI des catégories d'artefacts (le libellé vit dans la couche décision ; l'assemblage
    CertZip ne connaît que la CLÉ d'artefact). Table de CLÉS résolue par `I18n.t` AU POINT DE RENDU (exportChoices),
    jamais au chargement du module — la localisation n'est initialisée qu'au bootstrap. */
const CATEGORY_LABEL_KEY: Record<ExportCategoryKey, string> = {
  public: "certs.bulk.catPublic",
  fullchain: "certs.bulk.catFullchain",
  "ca-chain": "certs.bulk.catCaChain",
  key: "certs.bulk.catKey",
};

export class BulkActions {
  /** INTERSECTION des actions communes à une sélection, selon l'état de session (cadrage §5).
      Sélection vide → aucune action. Export toujours possible (publics au minimum).

      Révoquer/supprimer NE dépendent PAS du déverrouillage (parité avec les actions par ligne) :
      ce sont des opérations de MÉTADONNÉES — aucun secret n'est déchiffré, la clé maître n'y sert
      à rien. Les en exclure rendait IMPURGEABLE une PKI dont la phrase est perdue, en contradiction
      avec docs/certs.md (« peut encore être consultée et purgée »). Le garde-fou pertinent n'est pas
      le verrou mais l'intention explicite (confirmation par saisie côté UI, `force` côté serveur).
      Révoquer exige EN PLUS qu'aucun ne soit déjà révoqué (sinon rien de commun à révoquer). */
  static commonActions(snapshots: CertSelectionSnapshot[], unlocked: boolean): BulkActionAvailability {
    const list = Array.isArray(snapshots) ? snapshots : [];
    const hasSelection = list.length > 0;
    const anyRevoked = list.some((s) => BulkActions.isRevoked(s.revoked_at));
    return {
      canExport: hasSelection,
      exportLabel: unlocked ? I18n.t("certs.bulk.selExportFull") : I18n.t("certs.bulk.selExportPublic"),
      withPrivateKeys: unlocked,
      canRevoke: hasSelection && !anyRevoked,
      canDelete: hasSelection,
    };
  }

  /** CATÉGORIES d'artefacts proposées au DIALOGUE d'export groupé — liste dans un ORDRE stable (public,
      fullchain, ca-chain, key). Une catégorie n'est `available` que si elle a du sens pour TOUS les éléments
      NON RÉVOQUÉS de la sélection (les révoqués sont exclus du ZIP — décision Q4 — donc ne contraignent pas
      le choix) :
      - `public`   : TOUJOURS (le certificat/la clé publique existe pour tout kind) ;
      - `fullchain`/`ca-chain` : seulement si TOUS les non-révoqués sont des feuilles TLS (chaîne d'émission
                     dénuée de sens pour une racine, une paire SSH ou un certificat SSH) ;
      - `key`      : seulement si session DÉVERROUILLÉE **et** tous les non-révoqués détiennent une clé privée.
      Le dialogue n'affiche que les catégories `available` ; `public` l'étant toujours, il s'ouvre au moins pour
      proposer le mot de passe. Fonction PURE (aucun DOM), testée en isolation. */
  static exportChoices(snapshots: CertSelectionSnapshot[], unlocked: boolean): ExportChoice[] {
    const list = Array.isArray(snapshots) ? snapshots : [];
    const active = list.filter((s) => !BulkActions.isRevoked(s.revoked_at));   // les révoqués n'entrent jamais au ZIP
    const hasActive = active.length > 0;
    // `every` sur un ensemble vide vaut vrai : on EXIGE au moins un non-révoqué (hasActive) pour proposer une
    // catégorie conditionnelle — sinon rien n'est réellement exportable et la catégorie n'aurait pas de sens.
    const allLeaf = hasActive && active.every((s) => s.kind === "leaf-tls");
    const allHaveKey = hasActive && active.every((s) => s.has_key);
    return [
      { key: "public", label: I18n.t(CATEGORY_LABEL_KEY.public), available: true },
      { key: "fullchain", label: I18n.t(CATEGORY_LABEL_KEY.fullchain), available: allLeaf },
      { key: "ca-chain", label: I18n.t(CATEGORY_LABEL_KEY["ca-chain"]), available: allLeaf },
      { key: "key", label: I18n.t(CATEGORY_LABEL_KEY.key), available: unlocked && allHaveKey },
    ];
  }

  /** Partitionne une sélection à exporter : les RÉVOQUÉS sont exclus du ZIP (décision Q4) et signalés
      au bilan ; les autres sont retenus. L'ordre d'entrée est préservé dans chaque groupe. */
  static partitionExport(items: Array<{ id: string; revoked_at: string | null }>): ExportPartition {
    const included: string[] = [];
    const excludedRevoked: string[] = [];
    for (const it of Array.isArray(items) ? items : []) {
      (BulkActions.isRevoked(it.revoked_at) ? excludedRevoked : included).push(it.id);
    }
    return { included, excludedRevoked };
  }

  /** Un `revoked_at` non vide marque une révocation (robuste aux valeurs nulles/blanches). */
  private static isRevoked(revokedAt: string | null | undefined): boolean {
    return typeof revokedAt === "string" && revokedAt.trim() !== "";
  }
}
