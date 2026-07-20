/* =============================================================================
   CertDeployGuide — logique PURE (aucun DOM, aucun réseau) de l'AIDE AU DÉPLOIEMENT
   de la confiance d'une autorité. Produit une structure DÉCLARATIVE (intro + sections
   + blocs de commande PRÉ-REMPLIS) que la vue (CertsAdminView) rend en modale avec un
   bouton « Copier » par bloc ; la doc pérenne (docs/certs.md) raconte la MÊME chose.

   Pourquoi une classe pure dédiée (principes n°2/n°7) : le contenu (procédures Linux/
   Windows/Android pour un CA X.509, variante SSH) est une donnée métier stable, testable
   en isolation (Tests/modules/test-certs.js) — on vérifie notamment que le nom de fichier
   du certificat est bien injecté dans les commandes. La vue n'assemble que du DOM.

   Rappel ZÉRO-CONNAISSANCE : on ne déploie JAMAIS que le certificat PUBLIC de l'autorité
   (jamais sa clé privée). Les noms d'exemple restent fictifs (exemple.lan).

   LOCALISATION (lot B4) : la PROSE (intros, notes, libellés descriptifs de bloc) est résolue
   via `I18n.t` À L'APPEL (les méthodes sont statiques, invoquées après `I18n.init()`). Les
   COMMANDES, CHEMINS et exemples techniques restent VERBATIM (littéraux, avec injection du nom
   de fichier / de la ligne publique). Les titres de plateforme OS (Linux/Windows/Android) et les
   noms de distributions / de fichiers de conf (sshd_config, known_hosts) restent aussi verbatim. */
import { I18n } from "../i18n/I18n";

/** Un bloc de commande copiable (rendu en <pre> + bouton « Copier »). `command` peut être
    multi-lignes (plusieurs commandes enchaînées) ; il est copié tel quel. */
export interface DeployCommand {
  /** Étiquette courte au-dessus du bloc (ex. « Debian / Ubuntu »), optionnelle. */
  label?: string;
  command: string;
}

/** Une section de plateforme (Linux / Windows / Android, ou serveurs/clients pour SSH). */
export interface DeploySection {
  title: string;
  /** Paragraphe d'introduction de la section (avant les commandes), optionnel. */
  intro?: string;
  /** Blocs de commande PRÉ-REMPLIS (peut être vide — ex. Android est purement graphique). */
  commands: DeployCommand[];
  /** Notes de bas de section : alternatives (GUI, GPO…) et CAVEATS (Firefox/NSS, Android 7…). */
  notes?: string[];
}

/** Guide complet de déploiement de la confiance d'une autorité. */
export interface DeployGuide {
  /** Encadré d'introduction (rappel zéro-connaissance + rôle serveur TLS / clients). */
  intro: string[];
  sections: DeploySection[];
}

export class CertDeployGuide {
  /** Guide pour une CA racine X.509 : installer le certificat PUBLIC (`fileName`, ex.
      `CA Racine interne.crt`) dans le magasin de confiance des clients Linux/Windows/Android.
      `fileName` est PRÉ-CALCULÉ par l'appelant (`CertExports.safeFileName(label) + ".crt"`) —
      on le garde en paramètre pour rester pur (aucune dépendance à CertExports). */
  static forRootCa(fileName: string): DeployGuide {
    const f = fileName || "ca.crt";
    return {
      intro: [
        I18n.t("certs.guide.rootCa.intro1", { file: f }),
        I18n.t("certs.guide.rootCa.intro2"),
      ],
      sections: [
        {
          title: "Linux",
          intro: I18n.t("certs.guide.rootCa.linuxIntro"),
          commands: [
            { label: "Debian / Ubuntu", command: "sudo cp " + f + " /usr/local/share/ca-certificates/\nsudo update-ca-certificates" },
            { label: "RHEL / Fedora / CentOS", command: "sudo cp " + f + " /etc/pki/ca-trust/source/anchors/\nsudo update-ca-trust" },
            { label: I18n.t("certs.guide.rootCa.linuxVerifyLabel"), command: "openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt feuille.pem" },
          ],
          notes: [
            I18n.t("certs.guide.rootCa.linuxNoteFirefox"),
            I18n.t("certs.guide.rootCa.linuxNoteJava", { file: f }),
            I18n.t("certs.guide.rootCa.linuxNoteNode", { file: f }),
            I18n.t("certs.guide.rootCa.linuxNotePython", { file: f }),
          ],
        },
        {
          title: "Windows",
          intro: I18n.t("certs.guide.rootCa.winIntro"),
          commands: [
            { label: I18n.t("certs.guide.rootCa.winCmdLabel"), command: "certutil -addstore -f Root " + f },
            { label: I18n.t("certs.guide.rootCa.winPsLabel"), command: "Import-Certificate -FilePath " + f + " -CertStoreLocation Cert:\\LocalMachine\\Root" },
          ],
          notes: [
            I18n.t("certs.guide.rootCa.winNotePem"),
            I18n.t("certs.guide.rootCa.winNoteGui"),
            I18n.t("certs.guide.rootCa.winNoteGpo"),
            I18n.t("certs.guide.rootCa.winNoteFirefox"),
          ],
        },
        {
          title: "Android",
          intro: I18n.t("certs.guide.rootCa.androidIntro", { file: f }),
          commands: [],
          notes: [
            I18n.t("certs.guide.rootCa.androidNote1"),
            I18n.t("certs.guide.rootCa.androidNote2"),
            I18n.t("certs.guide.rootCa.androidNote3"),
            I18n.t("certs.guide.rootCa.androidNote4"),
          ],
        },
      ],
    };
  }

  /** Guide COURT pour une CA de signature SSH : la confiance se déploie différemment selon
      qu'on signe des certificats UTILISATEUR (les serveurs font confiance à la CA) ou HÔTE
      (les clients font confiance à la CA). `publicKeyLine` = la ligne authorized_keys de la CA
      (le `public_pem` stocké, ex. « ssh-ed25519 AAAA… ca-ssh@interne »). */
  static forSshCa(publicKeyLine: string): DeployGuide {
    const pub = (publicKeyLine || "").trim() || "ssh-ed25519 AAAA…";
    return {
      intro: [
        I18n.t("certs.guide.sshCa.intro1"),
        I18n.t("certs.guide.sshCa.intro2"),
      ],
      sections: [
        {
          title: I18n.t("certs.guide.sshCa.serversTitle"),
          intro: I18n.t("certs.guide.sshCa.serversIntro"),
          commands: [
            { label: I18n.t("certs.guide.sshCa.serversPubLabel"), command: pub },
            { label: "sshd_config", command: "TrustedUserCAKeys /etc/ssh/ca.pub" },
            { label: I18n.t("certs.guide.sshCa.serversReloadLabel"), command: "sudo systemctl reload sshd" },
          ],
        },
        {
          title: I18n.t("certs.guide.sshCa.clientsTitle"),
          intro: I18n.t("certs.guide.sshCa.clientsIntro"),
          commands: [
            { label: "known_hosts", command: "@cert-authority *.exemple.lan " + pub },
          ],
        },
      ],
    };
  }
}
