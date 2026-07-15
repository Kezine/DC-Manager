/* =============================================================================
   CertsTips — CONTENUS des tooltips enrichis de la page Certificats.

   DONNÉES pures (simple export, cf. CLAUDE.md : les constantes/tables restent des
   exports, seules les fonctions se regroupent en classe). Le moteur `RichTooltip`
   les résout par CLÉ (`data-rich-tooltip="certs.revoke"`) et construit le DOM
   lui-même — rien ici n'est du HTML, donc rien n'est à échapper.

   POURQUOI des mini-docs : les actions par ligne sont passées en ICÔNES (listes
   denses). L'icône dit « quoi », le tooltip dit « ce que ça fait vraiment » —
   notamment les effets irréversibles et les limites assumées du modèle (pas de
   CRL/OCSP, clé privée absente des exports si le coffre est verrouillé).
   ============================================================================= */
import type { TipContent } from "../ui/RichTooltip";
import { Icons } from "../ui/Icons";

/** Clés de tooltip de la page Certificats (source unique — évite les chaînes en dur). */
export const CERT_TIP = {
  issueTls: "certs.issueTls",
  issueSsh: "certs.issueSsh",
  export: "certs.export",
  revoke: "certs.revoke",
  remove: "certs.remove",
} as const;

export const CERTS_TIPS: { [key: string]: TipContent } = {
  [CERT_TIP.issueTls]: {
    title: "Émettre un certificat TLS",
    icon: Icons.ISSUE_TLS,
    sub: "Crée une feuille X.509 signée par cette autorité racine.",
    sections: [
      { head: "Ce que vous fournissez", body: "Un sujet (CN), des SAN (dns / ip / email) et une durée de validité." },
      { head: "Ce qui se passe", body: "La paire de clés naît dans votre navigateur ; la clé privée est chiffrée par la clé maître avant d'être envoyée. Le serveur ne reçoit que le certificat public et un blob opaque." },
      { head: "Prérequis", body: "Coffre déverrouillé : signer exige la clé privée de la CA." },
    ],
  },

  [CERT_TIP.issueSsh]: {
    title: "Émettre un certificat SSH",
    icon: Icons.ISSUE_SSH,
    sub: "Crée un certificat OpenSSH signé par cette CA SSH.",
    sections: [
      { head: "Ce que vous fournissez", body: "Une identité (key id), des principals et une durée. Type « user » en v1." },
      { head: "Déploiement", body: "La confiance se déclare à la main côté serveur (TrustedUserCAKeys) — voir l'aide « Déployer la confiance »." },
      { head: "Prérequis", body: "Coffre déverrouillé : signer exige la clé privée de la CA." },
    ],
  },

  [CERT_TIP.export]: {
    title: "Exporter les artefacts",
    icon: Icons.EXPORT,
    sub: "Assemble et télécharge les fichiers de cet objet.",
    sections: [
      { head: "Formats", body: "PEM et fullchain, PKCS#12 (.p12, chiffré AES-256), artefacts OpenSSH selon le type d'objet." },
      { head: "Clé privée", body: "Incluse UNIQUEMENT si le coffre est déverrouillé — le déchiffrement se fait dans votre navigateur. Verrouillé, l'export ne contient que du public." },
      { head: "Révoqué", body: "Un objet révoqué est exclu des exports." },
    ],
  },

  [CERT_TIP.revoke]: {
    title: "Révoquer",
    icon: Icons.REVOKE,
    sub: "Marque l'objet comme ne devant plus être utilisé. Réversible côté données, pas côté déploiement.",
    sections: [
      { head: "Effet", body: "Pose une date de révocation, exclut l'objet des exports et referme son alerte d'échéance." },
      { head: "Limite assumée", body: "Il n'y a ni CRL ni répondeur OCSP : la PKI est interne. Concrètement, la révocation vaut par le NON-DÉPLOIEMENT — ce qui est déjà installé ailleurs continue de fonctionner jusqu'à son retrait." },
      { head: "Clé", body: "Opération de métadonnées : aucun secret n'est touché, le coffre peut rester verrouillé." },
    ],
  },

  [CERT_TIP.remove]: {
    title: "Supprimer définitivement",
    icon: Icons.DELETE,
    sub: "Efface l'objet du serveur. Irréversible.",
    sections: [
      { head: "Ce qui est effacé", body: "Les métadonnées, les SAN et la clé privée chiffrée (key_enc). Aucune corbeille, aucune restauration." },
      { head: "Garde-fous", body: "Un émetteur ayant des dérivés est refusé (supprimez d'abord sa descendance). Un certificat ENCORE VALIDE exige une confirmation explicite." },
      { head: "Clé", body: "Opération de métadonnées : le coffre peut rester verrouillé — c'est ce qui permet de purger une PKI dont la phrase secrète est perdue." },
    ],
  },
};
