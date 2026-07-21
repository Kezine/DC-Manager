/* =============================================================================
   CertsTips — CONTENUS des tooltips enrichis de la page Certificats.

   Le moteur `RichTooltip` résout chaque tooltip par CLÉ (`data-rich-tooltip=
   "certs.revoke"`, cf. CERT_TIP) et construit le DOM lui-même — rien ici n'est du
   HTML, donc rien n'est à échapper.

   LOCALISATION (lot B4) : les textes sont RENDUS → résolus via `I18n.t`. Comme la
   map était auparavant une CONSTANTE évaluée au chargement du module (avant
   `I18n.init()`), elle devient une MÉTHODE (`CertsTips.build()`), appelée à
   l'enregistrement (constructeur de la vue, donc après l'init) — pas d'appel à
   `I18n.t` au chargement. Les CLÉS de tooltip (`CERT_TIP`) restent des données.

   POURQUOI des mini-docs : les actions par ligne sont passées en ICÔNES (listes
   denses). L'icône dit « quoi », le tooltip dit « ce que ça fait vraiment » —
   notamment les effets irréversibles et les limites assumées du modèle (pas de
   CRL/OCSP, clé privée absente des exports si le coffre est verrouillé).
   ============================================================================= */
import type { TipContent } from "../ui/RichTooltip";
import { Icons } from "../ui/Icons";
import { I18n } from "../i18n/I18n";

/** Clés de tooltip de la page Certificats (source unique — évite les chaînes en dur).
    NB : ce sont les CLÉS d'enregistrement `RichTooltip` (attribut DOM), distinctes des
    clés i18n `certs.tips.*` qui portent le TEXTE localisé. */
export const CERT_TIP = {
  issueTls: "certs.issueTls",
  issueSsh: "certs.issueSsh",
  export: "certs.export",
  revoke: "certs.revoke",
  renew: "certs.renew",
  remove: "certs.remove",
  trustDeploy: "certs.trustDeploy",
  certList: "certs.certList",
} as const;

/** Fabrique les contenus de tooltips (textes localisés) — appelée À L'ENREGISTREMENT (après I18n.init()). */
export class CertsTips {
  static build(): { [key: string]: TipContent } {
    return {
      [CERT_TIP.issueTls]: {
        title: I18n.t("certs.tips.issueTls.title"),
        icon: Icons.ISSUE_TLS,
        sub: I18n.t("certs.tips.issueTls.sub"),
        sections: [
          { head: I18n.t("certs.tips.issueTls.h1"), body: I18n.t("certs.tips.issueTls.b1") },
          { head: I18n.t("certs.tips.issueTls.h2"), body: I18n.t("certs.tips.issueTls.b2") },
          { head: I18n.t("certs.tips.issueTls.h3"), body: I18n.t("certs.tips.issueTls.b3") },
        ],
      },

      [CERT_TIP.issueSsh]: {
        title: I18n.t("certs.tips.issueSsh.title"),
        icon: Icons.ISSUE_SSH,
        sub: I18n.t("certs.tips.issueSsh.sub"),
        sections: [
          { head: I18n.t("certs.tips.issueSsh.h1"), body: I18n.t("certs.tips.issueSsh.b1") },
          { head: I18n.t("certs.tips.issueSsh.h2"), body: I18n.t("certs.tips.issueSsh.b2") },
          { head: I18n.t("certs.tips.issueSsh.h3"), body: I18n.t("certs.tips.issueSsh.b3") },
        ],
      },

      [CERT_TIP.export]: {
        title: I18n.t("certs.tips.export.title"),
        icon: Icons.EXPORT,
        sub: I18n.t("certs.tips.export.sub"),
        sections: [
          { head: I18n.t("certs.tips.export.h1"), body: I18n.t("certs.tips.export.b1") },
          { head: I18n.t("certs.tips.export.h2"), body: I18n.t("certs.tips.export.b2") },
          { head: I18n.t("certs.tips.export.h3"), body: I18n.t("certs.tips.export.b3") },
        ],
      },

      [CERT_TIP.revoke]: {
        title: I18n.t("certs.tips.revoke.title"),
        icon: Icons.REVOKE,
        sub: I18n.t("certs.tips.revoke.sub"),
        sections: [
          { head: I18n.t("certs.tips.revoke.h1"), body: I18n.t("certs.tips.revoke.b1") },
          { head: I18n.t("certs.tips.revoke.h2"), body: I18n.t("certs.tips.revoke.b2") },
          { head: I18n.t("certs.tips.revoke.h3"), body: I18n.t("certs.tips.revoke.b3") },
        ],
      },

      [CERT_TIP.renew]: {
        title: I18n.t("certs.tips.renew.title"),
        icon: Icons.RENEW,
        sub: I18n.t("certs.tips.renew.sub"),
        sections: [
          { head: I18n.t("certs.tips.renew.h1"), body: I18n.t("certs.tips.renew.b1") },
          { head: I18n.t("certs.tips.renew.h2"), body: I18n.t("certs.tips.renew.b2") },
          { head: I18n.t("certs.tips.renew.h3"), body: I18n.t("certs.tips.renew.b3") },
        ],
      },

      [CERT_TIP.trustDeploy]: {
        title: I18n.t("certs.tips.trustDeploy.title"),
        icon: Icons.TRUST_DEPLOY,
        sub: I18n.t("certs.tips.trustDeploy.sub"),
        sections: [
          { head: I18n.t("certs.tips.trustDeploy.h1"), body: I18n.t("certs.tips.trustDeploy.b1") },
          { head: I18n.t("certs.tips.trustDeploy.h2"), body: I18n.t("certs.tips.trustDeploy.b2") },
          { head: I18n.t("certs.tips.trustDeploy.h3"), body: I18n.t("certs.tips.trustDeploy.b3") },
        ],
      },

      [CERT_TIP.certList]: {
        title: I18n.t("certs.tips.certList.title"),
        icon: Icons.CERT_LIST,
        sub: I18n.t("certs.tips.certList.sub"),
        sections: [
          { head: I18n.t("certs.tips.certList.h1"), body: I18n.t("certs.tips.certList.b1") },
        ],
      },

      [CERT_TIP.remove]: {
        title: I18n.t("certs.tips.remove.title"),
        icon: Icons.DELETE,
        sub: I18n.t("certs.tips.remove.sub"),
        sections: [
          { head: I18n.t("certs.tips.remove.h1"), body: I18n.t("certs.tips.remove.b1") },
          { head: I18n.t("certs.tips.remove.h2"), body: I18n.t("certs.tips.remove.b2") },
          { head: I18n.t("certs.tips.remove.h3"), body: I18n.t("certs.tips.remove.b3") },
        ],
      },
    };
  }
}
