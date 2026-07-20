/* Contrat d'INTÉGRATION « fiches » du rapprochement CERTIFICAT ↔ équipement/VM (AMOVIBLE) — DÉCOUPLAGE
   (principe n°2), calqué sur `InterventionFicheHooks`.

   Les fiches détail (équipement/VM) ne doivent importer NI la vue certs (`CertsAdminView`) NI son client
   (`CertsClient`) : elles ne connaissent que ce petit contrat, injecté via `FormHost` (`host.certHooks`) et
   implémenté dans `main.ts`. Retirer la feature = retirer l'implémentation dans `main.ts` + ce fichier +
   `CertFicheRow`, sans toucher aux fiches (elles voient alors `certHooks` à null → aucune rangée « Certificats »).

   Le rapprochement est CALCULÉ (jamais persisté) : `certsForTarget` interroge le moteur pur `CertTargetMatch`
   sur les certificats leaf-tls NON révoqués du document (les révoqués sont d'office écartés → toutes les
   correspondances rendues sont valables). `openCert` NAVIGUE vers l'onglet « Certificats » focalisé sur le
   certificat (l'appelant ferme d'abord la fiche courante — overlay UNIQUE, cf. InterventionFicheRow). */
import type { CertMatchVia } from "../core/CertTargetMatch";

/** Une piste de rapprochement affichée en puce dans la fiche (dns/cn/wildcard/ip, « constatée » si IP vNIC seule). */
export interface CertFicheVia {
  via: CertMatchVia;
  value: string;
  /** true = la piste IP repose UNIQUEMENT sur une IP vNIC constatée (informatif) — cf. CertTargetMatch. */
  observed?: boolean;
}

/** Un certificat rapproché d'une cible, prêt à l'affichage dans la fiche (une entrée par certificat,
    ses pistes regroupées). `notAfter` = échéance BRUTE (la rangée calcule classe + libellé via CertsFormat). */
export interface CertFicheMatch {
  certId: string;
  label: string;
  vias: CertFicheVia[];
  notAfter: string | null;
}

export interface CertFicheHooks {
  /** Certificats leaf-tls (non révoqués) du document rapprochant la cible — chargé en async par la rangée. */
  certsForTarget(kind: "equipment" | "vm", id: string): Promise<CertFicheMatch[]>;
  /** Ouvre l'onglet « Certificats » focalisé sur `certId` (l'appelant ferme la fiche AVANT — overlay unique). */
  openCert(certId: string): void;
}
