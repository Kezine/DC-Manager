import { I18n } from "../../i18n/I18n";
import { CertsFormat } from "../../core/CertsFormat";
import type { CertFicheHooks, CertFicheMatch, CertFicheVia } from "../CertFicheHooks";

/* Rangée « Certificats TLS » DISCRÈTE d'une fiche (détail équipement/VM) : liste les certificats leaf-tls
   du document RAPPROCHÉS de la cible (rapprochement CALCULÉ, jamais persisté — cf. CertTargetMatch). Chargée en
   async, SILENCIEUSE en cas d'échec réseau (jamais bloquante). Helper PARTAGÉ par les deux fiches (principe n°3).

   Ne connaît que le contrat `CertFicheHooks` (injecté) — aucun import de la vue ni du client certs. No-op si
   `hooks` est null (mode fichier / hors API → rien ne s'affiche). Calque d'`InterventionFicheRow`.

   NAVIGATION : un clic sur un certificat FERME d'abord la fiche courante (`close`, sans perte : les fiches détail
   sont en lecture seule) PUIS délègue à `openCert` (bascule vers l'onglet « Certificats » focalisé). La modale de
   l'app est un overlay UNIQUE — pas d'empilement. */
export class CertFicheRow {
  /** Ajoute la rangée à `root`. @param close ferme la fiche courante (typiquement `() => host.closeModal?.()`). */
  static attach(
    root: HTMLElement,
    hooks: CertFicheHooks | null | undefined,
    target: { kind: "equipment" | "vm"; id: string },
    close: () => void,
  ): void {
    if (!hooks) return;   // hors mode API → aucune intégration dans les fiches

    const divider = document.createElement("div");
    divider.className = "section-divider";
    divider.textContent = I18n.t("detail.certs.section");
    root.appendChild(divider);

    // Conteneur rempli en async : « … » le temps du chargement, puis les correspondances (ou « aucune »).
    const body = document.createElement("div");
    body.style.cssText = "margin:2px 0 8px";
    const loading = document.createElement("span");
    loading.className = "pill"; loading.textContent = "…";
    loading.style.borderColor = "var(--fg-dimmer)"; loading.style.color = "var(--fg-dim)";
    body.appendChild(loading);
    root.appendChild(body);

    // Chargement ASYNCHRONE, non bloquant : un échec réseau laisse un « — » discret (jamais d'erreur remontée).
    hooks.certsForTarget(target.kind, target.id).then((matches) => {
      body.innerHTML = "";
      if (!matches.length) { body.appendChild(CertFicheRow.mutedPill(I18n.t("detail.certs.none"))); return; }
      for (const match of matches) body.appendChild(CertFicheRow.matchRow(match, hooks, close));
    }).catch(() => { body.innerHTML = ""; body.appendChild(CertFicheRow.mutedPill("—")); });
  }

  /** Une ligne cliquable = un certificat : libellé + puces de piste (dns/cn/wildcard/ip) + pastille d'échéance. */
  private static matchRow(match: CertFicheMatch, hooks: CertFicheHooks, close: () => void): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:3px 0";

    // Libellé cliquable (bouton-lien : ouvre le certificat dans l'onglet Certificats après fermeture de la fiche).
    const link = document.createElement("button");
    link.type = "button"; link.className = "btn btn-ghost btn-sm";
    link.textContent = match.label || match.certId;
    link.title = I18n.t("detail.certs.open");
    link.onclick = () => { close(); hooks.openCert(match.certId); };
    row.appendChild(link);

    for (const via of match.vias) row.appendChild(CertFicheRow.viaPill(via));

    // Pastille d'échéance : SEULEMENT si alerte (warn ≤ 30 j / err ≤ 7 j ou expiré) — un cert « ok » ne teinte rien.
    const cls = CertsFormat.expiryClass(match.notAfter);
    if (cls === "warn" || cls === "err") {
      const pill = document.createElement("span"); pill.className = "pill";
      const color = cls === "err" ? "var(--err)" : "var(--warn)";
      pill.style.borderColor = color; pill.style.color = color;
      pill.textContent = CertsFormat.expiryLabel(match.notAfter);
      row.appendChild(pill);
    }
    return row;
  }

  /** Puce de PISTE de rapprochement (dns/cn/wildcard/ip) ; « constatée » ajouté pour une IP vNIC informative. */
  private static viaPill(via: CertFicheVia): HTMLElement {
    const key = via.via === "dns" ? "detail.certs.viaDns"
      : via.via === "cn" ? "detail.certs.viaCn"
      : via.via === "wildcard" ? "detail.certs.viaWildcard"
      : "detail.certs.viaIp";
    const pill = document.createElement("span"); pill.className = "pill";
    pill.style.borderColor = "var(--fg-dimmer)"; pill.style.color = "var(--fg-dim)";
    pill.textContent = I18n.t(key) + (via.observed ? " · " + I18n.t("detail.certs.observed") : "");
    pill.title = via.value;   // la valeur exacte (SAN/CN) en infobulle
    return pill;
  }

  private static mutedPill(text: string): HTMLElement {
    const pill = document.createElement("span"); pill.className = "pill";
    pill.style.borderColor = "var(--fg-dimmer)"; pill.style.color = "var(--fg-dim)";
    pill.textContent = text;
    return pill;
  }
}
