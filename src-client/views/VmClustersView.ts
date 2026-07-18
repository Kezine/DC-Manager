import type { Store } from "../store";
import { Icons } from "../ui/Icons";
import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { VmClusterFormat } from "../core/VmClusterFormat";
import { VmSyncError } from "./forms/VmSyncClient";
import type { VmSyncClient, VmProviderStatus, VmClusterInfo, VmClusterNode } from "./forms/VmSyncClient";
import { I18n } from "../i18n/I18n";

/* =============================================================================
   VmClustersView — sous-onglet « Clusters » (sous l'onglet VMs, MODE API UNIQUEMENT).

   Classe DÉDIÉE et AUTONOME (feature VM AMOVIBLE) : la retirer = supprimer ce fichier +
   le branchement `shell.addView`/`links` de main.ts, sans cicatrice ailleurs. Elle NE
   dérive PAS de la chaîne `Forms` et n'emprunte pas les helpers privés de `DetailForms`
   (elle réplique les quelques primitives DOM qu'elle utilise — grille/table — avec les
   MÊMES classes CSS que les fiches, pour rester détachable).

   Rôle : afficher, PAR provider synchronisé, l'état du cluster (`VmClusterInfo`) et de la
   synchro (`VmProviderStatus`) — cartes + table des nœuds avec métriques et rapprochement
   nœud→équipement (logique PURE dans `core/VmClusterFormat`, testée en isolation). Lecture
   seule : le statut vit en MÉMOIRE serveur (pas de SSE) → tirage à la demande (`GET /vm/status`)
   à l'affichage du sous-onglet, au bouton « Actualiser » (en-tête) et après une « Synchroniser ».
   ============================================================================= */

/** Services applicatifs dont la vue Clusters dépend (injectés par le shell — découplage/testabilité). */
export interface VmClustersHost {
  /** Ouvre la fiche détail d'un équipement (rapprochement nœud→équipement rendu en LIEN). */
  openEquipmentDetail(id: string): void;
}

export class VmClustersView {
  /** Garde anti-rechargements concurrents (double-clic « Actualiser », synchro + navigation). */
  private loading = false;

  constructor(
    private readonly store: Store,
    private readonly container: HTMLElement,
    private readonly client: VmSyncClient,
    private readonly host: VmClustersHost,
  ) {}

  /** Activation du sous-onglet (onShow) : (re)charge le statut puis rend. */
  show(): void { void this.reload(); }

  /** Charge `GET /vm/status` et rend les cartes. Point d'entrée UNIQUE du rafraîchissement
      (onShow, bouton « Actualiser », après une synchro réussie). Ré-entrance garde. */
  async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.renderMessage(I18n.t("vm.clusters.loading"));
    try {
      const providers = await this.client.status();
      this.render(providers);
    } catch (e) {
      this.renderMessage(I18n.t("vm.clusters.unavailable", { detail: VmClustersView.errText(e) }), true);
    } finally {
      this.loading = false;
    }
  }

  /* -------------------------------------------------------------------------- */

  /** Rendu complet : intro + une carte par provider (ou message si aucun). */
  private render(providers: VmProviderStatus[]): void {
    this.container.innerHTML = "";
    const intro = document.createElement("div"); intro.className = "form-hint";
    intro.textContent = I18n.t("vm.clusters.intro");
    this.container.appendChild(intro);

    if (!providers.length) {
      this.appendNote(I18n.t("vm.common.noProvider"));
      return;
    }
    // Résolution nœud→équipement et comptage des VMs : lus UNE fois par rendu (partagés par toutes les cartes).
    // Les adresses IP alimentent le NIVEAU 1 du rapprochement v3 (hostnames des IP rattachées, cf. VmClusterFormat).
    const equipments = this.store.all("equipments") as Array<{ id: string; name: string }>;
    const ipAddresses = this.store.all("ipAddresses") as Array<{ equipment_id: string | null; hostname: string }>;
    const vms = this.store.all("vms") as Array<{ provider_id?: string; host_node?: string }>;
    providers.forEach((p) => this.container.appendChild(this.card(p, equipments, ipAddresses, vms)));
  }

  /** Une CARTE de provider : en-tête (identité + pills version/quorum/synchro), état de synchro,
      puis table des nœuds (ou invitation si le cluster n'a jamais été synchronisé). */
  private card(p: VmProviderStatus, equipments: Array<{ id: string; name: string }>, ipAddresses: Array<{ equipment_id: string | null; hostname: string }>, vms: Array<{ provider_id?: string; host_node?: string }>): HTMLElement {
    const cluster = p.cluster;
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid var(--line); background:var(--bg-2); border-radius:6px; padding:16px; margin-top:14px";

    // -- EN-TÊTE : titre (nom du cluster, repli sur l'id du provider) + sous-titre (id · kind) + pills d'état. --
    const head = document.createElement("div");
    head.style.cssText = "display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px 14px";
    const left = document.createElement("div");
    const title = document.createElement("div"); title.style.cssText = "font-size:16px; font-weight:600; color:var(--fg)";
    title.textContent = (cluster && cluster.name) ? cluster.name : p.provider_id;
    const sub = document.createElement("div"); sub.className = "form-hint";
    sub.innerHTML = Html.escape(p.provider_id) + ` <span style="color:var(--fg-dimmer)">· ${Html.escape(p.kind)}</span>`;
    left.append(title, sub);
    // Bouton « Management » du cluster : l'URL de l'outil de management (Proxmox Datacenter Manager)
    // est FOURNIE en config et recopiée dans cluster.management_url. Lien externe (nouvel onglet) —
    // href posé par propriété DOM (aucune injection). Absent → pas de bouton.
    if (cluster && cluster.management_url) {
      const mgmt = document.createElement("a");
      mgmt.href = cluster.management_url;
      mgmt.target = "_blank"; mgmt.rel = "noopener noreferrer";
      mgmt.className = "btn btn-ghost btn-sm";
      mgmt.textContent = I18n.t("vm.clusters.mgmtBtn");
      mgmt.title = I18n.t("vm.clusters.mgmtTitle");
      mgmt.style.cssText = "margin-top:8px; display:inline-flex; text-decoration:none";
      left.appendChild(mgmt);
    }
    const pills = document.createElement("div"); pills.style.cssText = "display:flex; flex-wrap:wrap; gap:6px; align-items:center";
    pills.innerHTML = this.headerPills(p, cluster);
    head.append(left, pills);
    card.appendChild(head);

    // -- ÉTAT DE SYNCHRO : période, dernière tentative/réussite (formatage de dates du repo), compteurs.
    //    Le « Message » n'entre dans la grille QU'EN SUCCÈS (résumé/compteurs, indice d'inventaire vide) ;
    //    en ERREUR il part dans un BANDEAU dédié ci-dessous (plus visible et actionnable, sans doublon). --
    const period = p.interval_sec > 0 ? I18n.t("vm.clusters.periodAuto", { n: p.interval_sec }) : I18n.t("vm.clusters.periodManual");
    const counts = p.counts
      ? I18n.t("vm.clusters.counts", { created: p.counts.created, updated: p.counts.updated, orphaned: p.counts.orphaned, unchanged: p.counts.unchanged })
      : VmClustersView.MUTED;
    const gridPairs: Array<[string, string]> = [
      [I18n.t("vm.clusters.gPeriod"), Html.escape(period)],
      [I18n.t("vm.clusters.gLastAttempt"), Html.escape(Format.dateTime(p.last_attempt || ""))],
      [I18n.t("vm.clusters.gLastSuccess"), Html.escape(Format.dateTime(p.last_success || ""))],
    ];
    if (p.ok) gridPairs.push([I18n.t("vm.clusters.gMessage"), Html.escape(p.message)]);
    gridPairs.push([I18n.t("vm.clusters.gCounts"), counts]);
    card.appendChild(this.grid(gridPairs));

    // -- BANDEAU D'ERREUR (par provider) : synchro OU construction en échec → message serveur ACTIONNABLE
    //    bien visible. Cas emblématique corrigé : jeton indéchiffrable après changement de la clé
    //    DCMANAGER_SECRETS_KEY → « le secret doit être ressaisi » (au lieu d'une liste vide silencieuse).
    //    Inspiré des bandeaux 503 de CertsAdminView/NotificationsAdminView. --
    if (!p.ok) this.appendErrorBanner(card, p.message);

    // -- NŒUDS : cluster synchronisé → table des nœuds + métriques + rapprochement. Jamais synchronisé
    //    (cluster null) → invitation, mais SEULEMENT si le provider est SAIN : en erreur, le bandeau
    //    ci-dessus explique déjà — l'invitation « pas encore synchronisé » serait trompeuse. --
    if (cluster) {
      this.appendNodes(card, p, cluster, equipments, ipAddresses, vms);
    } else if (p.ok) {
      this.appendNote(I18n.t("vm.clusters.neverSynced"), card);
    }
    return card;
  }

  /** Pills d'en-tête : synchro (ok/err), et — si le cluster est connu — version + gamme + quorum. */
  private headerPills(p: VmProviderStatus, cluster: VmClusterInfo | null): string {
    const out: string[] = [];
    out.push(this.pill(p.ok ? I18n.t("vm.clusters.syncOk") : I18n.t("vm.clusters.syncErr"), p.ok ? "ok" : "err"));
    if (cluster) {
      out.push(cluster.version ? this.pill(I18n.t("vm.common.pveVersion", { version: cluster.version }), "neutral") : this.pill(I18n.t("vm.common.versionUnknown"), "dim"));
      out.push(this.pill(cluster.supported ? I18n.t("vm.common.rangeSupported") : I18n.t("vm.common.rangeOut"), cluster.supported ? "ok" : "warn"));
      // Quorum : true = OK ; false = PERDU (erreur) ; null = inconnu (nœud isolé sans cluster).
      out.push(cluster.quorate === true ? this.pill(I18n.t("vm.clusters.quorumOk"), "ok")
        : cluster.quorate === false ? this.pill(I18n.t("vm.clusters.quorumLost"), "err")
        : this.pill(I18n.t("vm.clusters.quorumUnknown"), "dim"));
    }
    return out.join(" ");
  }

  /** Section + table des nœuds d'un cluster (nom · état · CPU · RAM · uptime · équipement · nb VMs). */
  private appendNodes(card: HTMLElement, p: VmProviderStatus, cluster: VmClusterInfo, equipments: Array<{ id: string; name: string }>, ipAddresses: Array<{ equipment_id: string | null; hostname: string }>, vms: Array<{ provider_id?: string; host_node?: string }>): void {
    const nodes = Array.isArray(cluster.nodes) ? cluster.nodes : [];
    this.sect(card, I18n.t("vm.clusters.nodesSection", { count: nodes.length }));
    const rows = nodes.map((node: VmClusterNode) => {
      const statePill = node.online ? this.pill(I18n.t("vm.clusters.online"), "ok") : this.pill(I18n.t("vm.clusters.offline"), "err");
      // Rapprochement nœud→équipement : MÊME hiérarchie v3 que la synchro (VmClusterFormat, miroir serveur —
      // les hostnames des IP rattachées priment, cf. ipAddresses). Résolu → nom + lien ⓘ vers la fiche
      // (pattern inter-fiches de DetailForms) ; sinon « non rapproché ».
      const eqId = VmClusterFormat.resolveHostEquipmentId(equipments, ipAddresses, node.name);
      const eq = eqId ? this.store.get("equipments", eqId) as { name?: string } | undefined : undefined;
      const eqCell = eq
        ? `${Html.escape(eq.name || I18n.t("lists.ph.equipment"))} <button class="btn btn-ghost btn-sm icon-action" data-eq-view="${Html.escape(eqId!)}" title="${Html.escape(I18n.t("vm.clusters.eqOpenTitle"))}" aria-label="${Html.escape(I18n.t("vm.clusters.eqOpenTitle"))}">${Icons.INFO}</button>`
        : `<span class="pill" style="border-color:var(--warn);color:var(--warn)">${Html.escape(I18n.t("vm.clusters.notMatched"))}</span>`;
      // Lien de management PAR nœud (généré par le provider — lien profond de l'UI web Proxmox).
      // Anchor externe (nouvel onglet) accolé au nom ; URL échappée pour l'attribut HTML (elle est
      // http(s) validée côté serveur). Absent → pas de lien.
      const mgmtLink = node.management_url
        ? ` <a href="${Html.escape(node.management_url)}" target="_blank" rel="noopener noreferrer" class="row-btn" title="${Html.escape(I18n.t("vm.clusters.nodeMgmtTitle"))}">↗</a>`
        : "";
      // Nb de VMs du document hébergées sur ce nœud (même provider) — `host_node` == nom du nœud.
      const vmCount = vms.filter((v) => v.provider_id === p.provider_id && v.host_node === node.name).length;
      return [
        `<span style="font-family:var(--mono)">${Html.escape(node.name)}</span>${mgmtLink}`,
        statePill,
        Html.escape(VmClusterFormat.cpuText(node.cpu_used, node.cpu_total)),
        Html.escape(VmClusterFormat.memGo(node.mem_used_mb, node.mem_total_mb)),
        Html.escape(VmClusterFormat.uptime(node.uptime_sec)),
        eqCell,
        String(vmCount),
      ];
    });
    const tw = this.tbl(card, [I18n.t("vm.clusters.colNode"), I18n.t("vm.clusters.colState"), I18n.t("vm.clusters.colCpu"), I18n.t("vm.clusters.colRam"), I18n.t("vm.clusters.colUptime"), I18n.t("vm.clusters.colEquipment"), I18n.t("vm.clusters.colVms")], rows, I18n.t("vm.clusters.nodesEmpty"));
    // Liaison des liens ⓘ → fiche équipement (après injection du HTML), pattern DetailForms.
    tw?.querySelectorAll("[data-eq-view]").forEach((el) => {
      (el as HTMLElement).onclick = () => this.host.openEquipmentDetail((el as HTMLElement).dataset.eqView!);
    });
  }

  /* ---- primitives DOM (répliquées pour rester AUTONOME — mêmes classes CSS que les fiches) ---- */

  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  /** Pill sémantique (mêmes couleurs que VmForms/DetailForms). `kind` pilote bordure/texte. */
  private pill(text: string, kind: "ok" | "err" | "warn" | "dim" | "neutral"): string {
    const style = kind === "ok" ? ` style="border-color:var(--ok);color:var(--ok)"`
      : kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : kind === "dim" ? ` style="border-color:var(--fg-dimmer);color:var(--fg-dim)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  /** Grille clé→valeur (classes `detail-grid`/`dt`/`dd` des fiches ; valeurs = HTML déjà échappé par l'appelant). */
  private grid(pairs: Array<[string, string]>): HTMLElement {
    const g = document.createElement("div"); g.className = "detail-grid"; g.style.marginTop = "12px";
    pairs.forEach(([k, v]) => {
      const dt = document.createElement("div"); dt.className = "dt"; dt.textContent = k;
      const dd = document.createElement("div"); dd.className = "dd"; dd.innerHTML = v;
      g.append(dt, dd);
    });
    return g;
  }

  /** Intercalaire de section (classe `section-divider`). */
  private sect(root: HTMLElement, label: string): void {
    const d = document.createElement("div"); d.className = "section-divider"; d.textContent = label; root.appendChild(d);
  }

  /** Table compacte (cellules = HTML) — `empty` si aucune ligne. Renvoie le conteneur (pour lier les événements). */
  private tbl(root: HTMLElement, headers: string[], rows: string[][], empty: string): HTMLElement | null {
    if (!rows.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = empty; root.appendChild(e); return null; }
    const tw = document.createElement("div"); tw.className = "table-wrap"; tw.style.marginTop = "4px";
    const head = headers.map((h) => `<th>${Html.escape(h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    tw.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    root.appendChild(tw); return tw;
  }

  /** Bandeau d'erreur PAR provider (bordure `--err`, message serveur ACTIONNABLE) — même esprit que
      les bandeaux 503 de CertsAdminView/NotificationsAdminView, répliqué ici pour rester AUTONOME
      (feature VM amovible). `white-space:pre-line` : le serveur peut renvoyer un message multi-lignes. */
  private appendErrorBanner(card: HTMLElement, message: string): void {
    const banner = document.createElement("div");
    banner.style.cssText = "border:1px solid var(--err); border-radius:6px; padding:10px 12px; margin-top:12px; background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600; color:var(--err); margin-bottom:4px";
    title.textContent = I18n.t("vm.clusters.bannerTitle");
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line";
    detail.textContent = message;
    banner.append(title, detail);
    card.appendChild(banner);
  }

  /** Note libre (form-hint), sur `parent` (défaut = conteneur de vue). */
  private appendNote(text: string, parent: HTMLElement = this.container): void {
    const n = document.createElement("div"); n.className = "form-hint"; n.style.marginTop = "10px"; n.style.fontStyle = "italic";
    n.textContent = text; parent.appendChild(n);
  }

  /** Message pleine vue (chargement / erreur) — remplace tout le contenu. */
  private renderMessage(text: string, isError = false): void {
    this.container.innerHTML = "";
    const n = document.createElement("div"); n.className = isError ? "form-hint err" : "form-hint";
    n.textContent = text; this.container.appendChild(n);
  }

  /** Message d'erreur lisible : `VmSyncError` porte le code HTTP + `detail` serveur ; sinon message brut. */
  private static errText(e: unknown): string {
    if (e instanceof VmSyncError) return e.message + (e.detail ? " — " + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
