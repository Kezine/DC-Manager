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
   ============================================================================= */

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
        "Seul le certificat PUBLIC de l'autorité se déploie : utilisez l'export « Certificat public » (cert.pem), renommé en « " + f + " » (extension .crt). La clé privée de la CA ne quitte JAMAIS la PKI — ne l'installez sur aucun client.",
        "Un serveur TLS présente sa FEUILLE (et, s'il existe des intermédiaires, la chaîne « fullchain » SANS la racine). La racine, elle, vit dans le magasin de confiance des CLIENTS : « déployer la confiance », c'est installer ce certificat racine sur chaque machine, navigateur ou service qui doit valider les certificats qu'elle signe.",
      ],
      sections: [
        {
          title: "Linux",
          intro: "Le fichier doit porter l'extension .crt (son contenu reste du PEM). Installation dans le magasin système, puis rafraîchissement du bundle.",
          commands: [
            { label: "Debian / Ubuntu", command: "sudo cp " + f + " /usr/local/share/ca-certificates/\nsudo update-ca-certificates" },
            { label: "RHEL / Fedora / CentOS", command: "sudo cp " + f + " /etc/pki/ca-trust/source/anchors/\nsudo update-ca-trust" },
            { label: "Vérifier une feuille signée par la racine", command: "openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt feuille.pem" },
          ],
          notes: [
            "Firefox et les applications NSS ont leur PROPRE magasin : soit importer la racine dans Paramètres → Vie privée et sécurité → Certificats → Autorités, soit activer « security.enterprise_roots.enabled » (about:config) pour qu'il lise le magasin système.",
            "Java (JVM) a son propre truststore : keytool -importcert -cacerts -alias <alias> -file " + f + ".",
            "Node.js : exporter NODE_EXTRA_CA_CERTS=/chemin/vers/" + f + " (variable d'environnement lue au démarrage du process).",
            "Python (requests) : exporter REQUESTS_CA_BUNDLE=/chemin/vers/" + f + " (ou passer verify=… explicitement).",
          ],
        },
        {
          title: "Windows",
          intro: "En tant qu'administrateur, dans le magasin de la MACHINE (« Ordinateur local » → « Autorités de certification racines de confiance »).",
          commands: [
            { label: "Invite de commandes (admin)", command: "certutil -addstore -f Root " + f },
            { label: "PowerShell (admin)", command: "Import-Certificate -FilePath " + f + " -CertStoreLocation Cert:\\LocalMachine\\Root" },
          ],
          notes: [
            "Interface graphique : double-cliquer sur le fichier → « Installer un certificat » → « Ordinateur local » → placer dans le magasin « Autorités de certification racines de confiance » (choisir le magasin EXPLICITEMENT — ne pas laisser la sélection automatique).",
            "Parc en domaine : déployer par GPO (Configuration ordinateur → Stratégies → Paramètres Windows → Paramètres de sécurité → Stratégies de clé publique → Autorités de certification racines de confiance).",
            "Firefox : même remarque que sous Linux (magasin NSS propre — « security.enterprise_roots.enabled »).",
          ],
        },
        {
          title: "Android",
          intro: "Installation manuelle : Paramètres → Sécurité → Chiffrement et identifiants → Installer un certificat → Certificat CA (puis sélectionner le fichier " + f + ").",
          commands: [],
          notes: [
            "Android 11 et suivants : le passage par ce menu est MANUEL (obligatoire) et un avertissement s'affiche — le confirmer.",
            "Un bandeau « le réseau peut être surveillé » apparaît ensuite : c'est NORMAL pour un CA installé par l'utilisateur.",
            "⚠ Depuis Android 7, les APPLICATIONS tierces ne font confiance qu'aux CA du magasin SYSTÈME : un CA « utilisateur » est bien reconnu par Chrome et les navigateurs, mais PAS par les applis — sauf si elles l'autorisent explicitement (networkSecurityConfig).",
            "Parc géré : déployer le CA via une solution MDM (Android Enterprise).",
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
        "Une CA SSH n'a pas de magasin système comme X.509 : la confiance se déclare à la main, différemment pour les certificats UTILISATEUR et HÔTE.",
        "Ne publiez que la clé PUBLIQUE de la CA (ci-dessous) ; sa clé privée ne quitte jamais la PKI.",
      ],
      sections: [
        {
          title: "Serveurs — accepter les certificats UTILISATEUR signés",
          intro: "Déposer la clé publique de la CA sur chaque serveur (ex. /etc/ssh/ca.pub), la déclarer dans sshd_config, puis recharger le service.",
          commands: [
            { label: "Contenu de /etc/ssh/ca.pub (clé publique de la CA)", command: pub },
            { label: "sshd_config", command: "TrustedUserCAKeys /etc/ssh/ca.pub" },
            { label: "Recharger sshd", command: "sudo systemctl reload sshd" },
          ],
        },
        {
          title: "Clients — accepter les certificats HÔTE signés",
          intro: "Ajouter une ligne @cert-authority dans un fichier known_hosts (global /etc/ssh/ssh_known_hosts ou personnel ~/.ssh/known_hosts) : les hôtes dont le certificat est signé par cette CA sont alors approuvés sans invite.",
          commands: [
            { label: "known_hosts", command: "@cert-authority *.exemple.lan " + pub },
          ],
        },
      ],
    };
  }
}
