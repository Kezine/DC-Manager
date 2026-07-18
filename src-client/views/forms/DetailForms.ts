import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { IconButton } from "../../ui/IconButton";
import { Html } from "../../core/Html";
import { Markdown } from "../../core/Markdown";
import { Color } from "../../core/Color";
import { Format } from "../../core/Format";
import { Ip } from "../../core/Ip";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { EntityViz } from "../EntityViz";
import { RouteMiniGraph, RouteEndpointSpec } from "../RouteMiniGraph";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { CableStatuses } from "../../domain/CableStatuses";
import { GroupTypes } from "../../domain/GroupTypes";
import { SpareTypes } from "../../domain/SpareTypes";
import { SpareStatuses } from "../../domain/SpareStatuses";
import { POWER_SOURCES } from "../../domain/constants";
import { I18n } from "../../i18n/I18n";   // lot B2a : libellé de POWER_SOURCES (labelKey → I18n.t)
import type { FormHost } from "./shared";
import { IpamForms } from "./IpamForms";
import { VmNetMapping } from "../../core/VmNetMapping";
import { VmIpMatch } from "../../core/VmIpMatch";
import { VmForms } from "./VmForms";
import { InterventionFicheRow } from "./InterventionFicheRow";   // intégration « fiches » de la feature interventions (AMOVIBLE)

/* =============================================================================
   FICHES DÉTAIL (lecture) des entités « secondaires » — remplacent le vidage
   BRUT champ-par-champ de la modale générique (clés techniques + FK non résolues).
   Chaque fiche RÉSOUT les liens (noms au lieu d'ids), agrège les entités liées
   (ports d'un faisceau, adresses d'un réseau IP…) et propose « Modifier » +
   « Localiser » quand c'est pertinent. Même habillage que equipment/rackDetail
   (`detail-grid`/`dt`/`dd`, `section-divider`, `table-wrap`, pills) — réutilise
   les helpers de FormBase et EntityViz (fil d'Ariane de localisation).

   Placée en fin de chaîne (IpamForms ← DetailForms ← Forms) : `this` résout vers
   `Forms`, donc l'accès aux formulaires d'ÉDITION (this.network, this.cableBundle,
   this.datacenter…) et aux autres fiches (this.equipmentDetail…) est direct.
   ============================================================================= */
export class DetailForms extends IpamForms {
  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  /** Grille clé→valeur (valeurs = HTML déjà échappé par l'appelant). */
  private static grid(pairs: Array<[string, string]>): HTMLElement {
    const g = document.createElement("div"); g.className = "detail-grid";
    pairs.forEach(([k, v]) => { g.appendChild(this.dt(k)); g.appendChild(this.dd(v)); });
    return g;
  }
  /** Intercalaire de section (avec compte optionnel). */
  private static sect(root: HTMLElement, label: string): void {
    const d = document.createElement("div"); d.className = "section-divider"; d.textContent = label; root.appendChild(d);
  }
  /** Tableau compact (cellules = HTML). `empty` affiché à la place si aucune ligne. */
  private static tbl(root: HTMLElement, headers: string[], rows: string[][], empty: string): HTMLElement | null {
    if (!rows.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = empty; root.appendChild(e); return null; }
    const tw = document.createElement("div"); tw.className = "table-wrap";
    const head = headers.map((h) => `<th>${Html.escape(h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    tw.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    root.appendChild(tw); return tw;
  }
  /** Pied de fiche : « Modifier » (si un éditeur est fourni et hors mode visualiseur). */
  private static footer(root: HTMLElement, edit?: () => void): void {
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    if (edit && !this.isViewer()) { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-primary"; b.textContent = I18n.t("lists.chrome.rowEdit"); b.onclick = edit; actions.appendChild(b); }
    root.appendChild(actions);
  }
  /** Étiquette « équipement : port » résolue (— si absent). */
  private static portRef(store: Store, portId: string | null): string {
    const p: any = portId ? store.get("ports", portId) : null; if (!p) return this.MUTED;
    const eq: any = store.get("equipments", p.equipment_id);
    return `${Html.escape(eq ? (eq.name || "?") : "?")} <span style="color:var(--fg-dimmer)">:</span> ${Html.escape(p.name || "(port)")}`;
  }
  /** Ouvre la fiche détail générique correcte selon la collection — POINT D'ENTRÉE unique (remplace `openDetail`
      du shell pour les collections couvertes ; renvoie false si aucune fiche dédiée n'existe → repli générique). */
  static detail(store: Store, host: FormHost, collection: string, id: string, onChanged?: () => void): boolean {
    switch (collection) {
      case "cables": this.cableDetail(store, host, id, onChanged); return true;
      case "cableBundles": this.cableBundleDetail(store, host, id, onChanged); return true;
      case "networks": this.networkDetail(store, host, id, onChanged); return true;
      case "ipNetworks": this.ipNetworkDetail(store, host, id, onChanged); return true;
      case "ipAddresses": this.ipAddressDetail(store, host, id, onChanged); return true;
      case "dhcpRanges": this.dhcpRangeDetail(store, host, id, onChanged); return true;
      case "datacenters": this.datacenterDetail(store, host, id, onChanged); return true;
      case "sites": this.siteDetail(store, host, id, onChanged); return true;
      case "groups": this.groupDetail(store, host, id, onChanged); return true;
      case "floors": this.floorDetail(store, host, id, onChanged); return true;
      case "spares": this.spareDetail(store, host, id, onChanged); return true;
      case "contacts": this.contactDetail(store, host, id, onChanged); return true;
      case "vms": this.vmDetail(store, host, id, onChanged); return true;
      case "cableTypes": this.cableTypeDetail(store, host, id); return true;
      case "portTypes": this.portTypeDetail(store, host, id); return true;
    }
    return false;
  }

  /* ---- CÂBLE ---- */
  static cableDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const c: any = store.get("cables", id);
    if (!c) { Notify.toast(I18n.t("detail.nf.cable"), "err"); return; }
    const root = document.createElement("div");
    const ct: any = c.cable_type_id ? store.get("cableTypes", c.cable_type_id) : null;
    const st = CableStatuses.get(c.status);
    // réseaux : le PRINCIPAL (network_id — porte la couleur du tracé) puis les secondaires
    const netPill = (n: any) => `<span class="pill colored-pill" ${Color.pillStyle(n.color)}>${Html.escape(n.label || I18n.t("lists.ph.network"))}</span>`;
    const primaryNet: any = c.network_id ? store.get("networks", c.network_id) : null;
    const otherNets = (c.network_ids || []).filter((nid: string) => nid !== c.network_id)
      .map((nid: string) => store.get("networks", nid)).filter((n: any) => n != null);
    const netsHtml = (primaryNet || otherNets.length)
      ? [primaryNet ? netPill(primaryNet) : null].concat(otherNets.map(netPill)).filter(Boolean).join(" ")
      : this.MUTED;
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(c.name || I18n.t("lists.ph.cable"))],
      [I18n.t("lists.col.type"), ct ? `${Html.escape(ct.name)} <span style="color:var(--fg-dimmer)">· ${Html.escape(ct.family || "")}</span>` : this.MUTED],
      [I18n.t("detail.cable.from"), this.portRef(store, c.from_port_id)],
      [I18n.t("detail.cable.to"), this.portRef(store, c.to_port_id)],
      [I18n.t("detail.cable.networks"), netsHtml],
      [I18n.t("lists.col.status"), `<span class="pill ${st ? st.cls : ""}">${Html.escape(CableStatuses.label(c.status))}</span>`],
      [I18n.t("lists.col.length"), c.length_m != null ? `${c.length_m} m` : this.MUTED],
      [I18n.t("lists.col.description"), c.description ? Html.escape(c.description) : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(c.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(c.updated_date))],
    ]));

    // tracé en mini-graphe (chaîne/profil) — couleur d'arête = réseau principal, tirets = statut
    this.sect(root, I18n.t("detail.common.route"));
    const epFromPort = (pid: string | null): RouteEndpointSpec | null => {
      const p: any = pid ? store.get("ports", pid) : null;
      if (!p) return null;
      const eq: any = store.get("equipments", p.equipment_id);
      return { label: eq ? (eq.name || "?") : "?", sub: I18n.t("detail.cable.portSub", { name: p.name || "?" }), dcId: store.equipmentDcId(p.equipment_id) };
    };
    root.appendChild(RouteMiniGraph.render(store, store.cableRoute(c), {
      endpointA: epFromPort(c.from_port_id),
      endpointB: epFromPort(c.to_port_id),
      edgeColor: primaryNet && primaryNet.color ? primaryNet.color : null,
      status: c.status || null,
    }));

    // actions : Localiser en 3D + Modifier (mêmes conventions que equipment/rackDetail)
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    if (host.locate) { const locBtn = document.createElement("button"); locBtn.type = "button"; locBtn.className = "btn btn-ghost"; locBtn.innerHTML = `<span class="gi">${Icons.LOCATE}</span>${I18n.t("lists.chrome.rowLocate")}`; locBtn.onclick = () => host.locate!("cable", c.id, () => this.cableDetail(store, host, id, onChanged)); actions.appendChild(locBtn); }
    if (!this.isViewer()) { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-primary"; b.textContent = I18n.t("lists.chrome.rowEdit"); b.onclick = () => this.cable(store, host, id, onChanged); actions.appendChild(b); }
    root.appendChild(actions);
    host.openModal({ title: I18n.t("detail.cable.title"), subtitle: Html.escape(c.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- FAISCEAU (trunk) ---- */
  static cableBundleDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const b: any = store.get("cableBundles", id);
    if (!b) { Notify.toast(I18n.t("detail.nf.bundle"), "err"); return; }
    const root = document.createElement("div");
    const ct: any = b.cable_type_id ? store.get("cableTypes", b.cable_type_id) : null;
    const occ = store.bundleOccupancy(id);
    const endLabel = (eqId: string | null) => {
      const eq: any = eqId ? store.get("equipments", eqId) : null;
      if (!eq) return `<span style="color:var(--err)">${I18n.t("detail.bundle.notPlaced")}</span>`;
      return `${Html.escape(eq.name || I18n.t("detail.bundle.patchFallback"))} ${EntityViz.equipmentLocationShort(store, eq)}`;
    };
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(b.name || I18n.t("lists.ph.bundle"))],
      [I18n.t("detail.bundle.fiberType"), ct ? `${Html.escape(ct.name)} <span style="color:var(--fg-dimmer)">· ${Html.escape(ct.family || "")}</span>` : this.MUTED],
      [I18n.t("detail.bundle.capacity"), `<span class="pill">${I18n.t("detail.bundle.strandCount", { count: b.fiber_count })}</span>`],
      [I18n.t("detail.bundle.occupancy"), `<span class="pill">${I18n.t("detail.bundle.drawn", { used: occ.used, capacity: occ.capacity })}</span> · <span class="pill">${I18n.t("detail.bundle.free", { count: occ.free })}</span>${occ.free <= 0 ? ` · <span class="pill" style="color:var(--err)">${I18n.t("detail.bundle.full")}</span>` : ""}`],
      [I18n.t("detail.bundle.endpointA"), endLabel(b.endpoint_a_equipment_id)],
      [I18n.t("detail.bundle.endpointB"), endLabel(b.endpoint_b_equipment_id)],
      [I18n.t("lists.col.length"), b.length_m != null ? `${b.length_m} m` : this.MUTED],
      [I18n.t("lists.col.description"), b.description ? Html.escape(b.description) : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(b.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(b.updated_date))],
    ]));

    // tracé en mini-graphe (remplace l'ancien résumé texte cableRouteSummary) — trunk : trait épais neutre
    // (un faisceau n'appartient pas à un réseau), pas de statut. Intra-salle sans waypoint : les deux
    // patchs reliés en direct dans la bande de leur salle.
    this.sect(root, I18n.t("detail.common.route"));
    const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: b.waypoint_ids || [] });
    const epSpec = (eqId: string | null): RouteEndpointSpec | null => {
      const eq: any = eqId ? store.get("equipments", eqId) : null;
      if (!eq) return null;
      return { label: eq.name || I18n.t("detail.bundle.patchFallback"), sub: I18n.t("detail.bundle.endpointPatch"), dcId: store.equipmentDcId(eq.id) };
    };
    root.appendChild(RouteMiniGraph.render(store, r, {
      endpointA: epSpec(b.endpoint_a_equipment_id),
      endpointB: epSpec(b.endpoint_b_equipment_id),
      edgeColor: "var(--fg-dim)", thick: true,
    }));

    // ports de patch piochant des brins dans ce faisceau
    const ports = store.portsOfBundle(id).slice().sort((a: any, c: any) => (Math.min(a.strand_a ?? 99, a.strand_b ?? 99)) - (Math.min(c.strand_a ?? 99, c.strand_b ?? 99)));
    this.sect(root, I18n.t("detail.bundle.strandsSection", { count: ports.length }));
    const rows = ports.map((p: any) => {
      const eq: any = store.get("equipments", p.equipment_id);
      const strands = [p.strand_a, p.strand_b].filter((s) => s != null).join(" · ");
      const loc = host.locate ? `<button class="btn btn-ghost btn-sm icon-action" data-port-loc="${p.id}" title="${I18n.t("detail.common.locatePort")}" aria-label="${I18n.t("detail.common.locatePort")}">${Icons.LOCATE}</button>` : "";
      return [`${Html.escape(eq ? (eq.name || "?") : "?")} <span style="color:var(--fg-dimmer)">:</span> ${Html.escape(p.name || I18n.t("detail.common.port"))}`, `<span style="font-family:var(--mono)">${strands || "—"}</span>`, `<span class="cell-actions">${loc}</span>`];
    });
    const tw = this.tbl(root, [I18n.t("detail.bundle.colPatchPort"), I18n.t("detail.bundle.colFibers"), ""], rows, I18n.t("detail.bundle.strandsEmpty"));
    tw?.querySelectorAll("[data-port-loc]").forEach((el) => { (el as HTMLElement).onclick = () => host.locate?.("port", (el as HTMLElement).dataset.portLoc!, () => this.cableBundleDetail(store, host, id, onChanged)); });

    this.footer(root, () => this.cableBundle(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.bundle.title"), subtitle: Html.escape(b.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- RÉSEAU (logique) ---- */
  static networkDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const n: any = store.get("networks", id);
    if (!n) { Notify.toast(I18n.t("detail.nf.network"), "err"); return; }
    const root = document.createElement("div");
    const power = n.kind === "power";
    const swatch = `<span class="pill colored-pill" ${Color.pillStyle(n.color)}>${Html.escape(n.label || I18n.t("lists.ph.network"))}</span>`;
    const pairs: Array<[string, string]> = [
      [I18n.t("lists.col.label"), swatch],
      [I18n.t("lists.col.type"), `<span class="pill">${power ? I18n.t("detail.network.typePower") : I18n.t("detail.network.typeData")}</span>`],
    ];
    if (power) {
      const src = POWER_SOURCES.find((s) => s.id === n.power_source);
      pairs.push([I18n.t("detail.network.voltage"), n.voltage != null ? `${n.voltage} V` : this.MUTED]);
      pairs.push([I18n.t("detail.network.maxCapacity"), n.max_amp != null ? `${n.max_amp} A` : this.MUTED]);
      pairs.push([I18n.t("detail.network.supply"), src ? Html.escape(I18n.t(src.labelKey)) : this.MUTED]);
    } else {
      const ipn: any = n.ip_network_id ? store.get("ipNetworks", n.ip_network_id) : null;
      pairs.push([I18n.t("lists.col.ipNetwork"), ipn ? Html.escape(Ip.short(ipn)) : `<span style="color:var(--fg-dimmer)">${I18n.t("detail.network.purelyLogical")}</span>`]);
    }
    pairs.push([I18n.t("lists.col.description"), n.description ? Html.escape(n.description) : this.MUTED]);
    pairs.push([I18n.t("detail.common.created"), Html.escape(Format.dateTime(n.created_date))]);
    pairs.push([I18n.t("detail.common.updated"), Html.escape(Format.dateTime(n.updated_date))]);
    root.appendChild(this.grid(pairs));

    // ports d'équipement TERMINAL qui assertent ce réseau (source unique)
    const ports = store.portsOfNetwork(id);
    this.sect(root, I18n.t("detail.network.portsSection", { count: ports.length }));
    this.tbl(root, [I18n.t("detail.network.colEqPort"), I18n.t("detail.network.colPrimary")], ports.map((p: any) => {
      const isPrimary = p.network_id === id;
      return [this.portRef(store, p.id), isPrimary ? `<span class="pill">${I18n.t("detail.network.primary")}</span>` : `<span style="color:var(--fg-dimmer)">${I18n.t("detail.network.secondary")}</span>`];
    }), I18n.t("detail.network.portsEmpty"));

    // câbles PORTANT le réseau (déduit le long des chemins)
    const cables = store.cablesOfNetwork(id);
    this.sect(root, I18n.t("detail.network.cablesSection", { count: cables.length }));
    this.tbl(root, [I18n.t("detail.network.colCable"), I18n.t("lists.col.link")], cables.slice(0, 50).map((c: any) => [
      Html.escape(c.name || I18n.t("lists.ph.cable")),
      `${this.portRef(store, c.from_port_id)} <span style="color:var(--accent)">↔</span> ${this.portRef(store, c.to_port_id)}`,
    ]), I18n.t("detail.network.cablesEmpty"));
    if (cables.length > 50) { const m = document.createElement("div"); m.className = "form-hint"; m.textContent = I18n.t("detail.common.andMore", { count: cables.length - 50 }); root.appendChild(m); }

    this.footer(root, () => this.network(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.network.title"), subtitle: Html.escape(n.label || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- RÉSEAU IP (IPAM) ---- */
  static ipNetworkDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const ipn: any = store.get("ipNetworks", id);
    if (!ipn) { Notify.toast(I18n.t("detail.nf.ipNetwork"), "err"); return; }
    const root = document.createElement("div");
    const c = Ip.parseCidr(ipn.cidr);
    const pairs: Array<[string, string]> = [
      [I18n.t("lists.col.label"), Html.escape(ipn.label || I18n.t("detail.ipNet.fallback"))],
      [I18n.t("detail.ipNet.cidr"), `<span style="font-family:var(--mono)">${Html.escape(ipn.cidr || "—")}</span>`],
    ];
    if (c) {
      pairs.push([I18n.t("detail.ipNet.networkAddr"), `<span style="font-family:var(--mono)">${c.networkStr}</span>`]);
      pairs.push([I18n.t("detail.ipNet.broadcast"), `<span style="font-family:var(--mono)">${c.broadcastStr}</span>`]);
      pairs.push([I18n.t("detail.ipNet.hostRange"), `<span style="font-family:var(--mono)">${Ip.toStr(c.firstHost)} – ${Ip.toStr(c.lastHost)}</span>`]);
      pairs.push([I18n.t("detail.ipNet.hosts"), `<span class="pill">${c.hostCount}</span>`]);
    } else if (ipn.cidr) pairs.push([I18n.t("detail.ipNet.cidr"), `<span style="color:var(--err)">${I18n.t("detail.ipNet.unparseable")}</span>`]);
    // passerelle / DNS / serveur DHCP du réseau
    pairs.push([I18n.t("detail.ipNet.gateway"), ipn.gateway ? `<span style="font-family:var(--mono)">${Html.escape(ipn.gateway)}</span>` : this.MUTED]);
    pairs.push([I18n.t("detail.ipNet.dnsServers"), (Array.isArray(ipn.dns_servers) && ipn.dns_servers.length) ? `<span style="font-family:var(--mono)">${ipn.dns_servers.map((s: string) => Html.escape(s)).join(", ")}</span>` : this.MUTED]);
    const dhcpSrv: any = ipn.dhcp_server_id ? store.get("equipments", ipn.dhcp_server_id) : null;
    pairs.push([I18n.t("lists.col.dhcpServer"), dhcpSrv ? `${Html.escape(dhcpSrv.name || "?")} ${EntityViz.equipmentLocationShort(store, dhcpSrv)}` : this.MUTED]);
    pairs.push([I18n.t("detail.common.created"), Html.escape(Format.dateTime(ipn.created_date))]);
    pairs.push([I18n.t("detail.common.updated"), Html.escape(Format.dateTime(ipn.updated_date))]);
    root.appendChild(this.grid(pairs));

    // réseaux LOGIQUES rattachés
    const nets = store.networksOfIpNetwork(id);
    if (nets.length) { this.sect(root, I18n.t("detail.ipNet.logicalSection", { count: nets.length }));
      this.tbl(root, [I18n.t("lists.col.network")], nets.map((nn: any) => [`<span class="pill colored-pill" ${Color.pillStyle(nn.color)}>${Html.escape(nn.label || I18n.t("lists.ph.network"))}</span>`]), ""); }

    // adresses statiques
    const addrs = store.ipAddressesOfNetwork(id).slice().sort((a: any, b: any) => (Ip.toInt(a.address) || 0) - (Ip.toInt(b.address) || 0));
    this.sect(root, I18n.t("detail.ipNet.addrSection", { count: addrs.length }));
    this.tbl(root, [I18n.t("lists.col.address"), I18n.t("lists.col.equipment"), I18n.t("lists.col.host")], addrs.map((a: any) => {
      const eq: any = a.equipment_id ? store.get("equipments", a.equipment_id) : null;
      return [`<span style="font-family:var(--mono)">${Html.escape(a.address || "?")}</span>`, eq ? Html.escape(eq.name || "?") : this.MUTED, a.hostname ? Html.escape(a.hostname) : this.MUTED];
    }), I18n.t("detail.ipNet.addrEmpty"));

    // plages DHCP
    const ranges = store.dhcpRangesOfNetwork(id);
    if (ranges.length) { this.sect(root, I18n.t("detail.ipNet.dhcpSection", { count: ranges.length }));
      this.tbl(root, [I18n.t("lists.col.range"), I18n.t("lists.filter.server")], ranges.map((rg: any) => {
        const srv: any = rg.server_id ? store.get("equipments", rg.server_id) : null;
        return [`<span style="font-family:var(--mono)">${Html.escape(rg.start_ip || "?")} – ${Html.escape(rg.end_ip || "?")}</span>`, srv ? Html.escape(srv.name || "?") : this.MUTED];
      }), ""); }

    this.footer(root, () => this.ipNetwork(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.ipNet.title"), subtitle: Html.escape(ipn.label || ipn.cidr || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- ADRESSE IP ---- */
  static ipAddressDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const a: any = store.get("ipAddresses", id);
    if (!a) { Notify.toast(I18n.t("detail.nf.ipAddress"), "err"); return; }
    const root = document.createElement("div");
    const ipn: any = a.network_id ? store.get("ipNetworks", a.network_id) : null;
    const eq: any = a.equipment_id ? store.get("equipments", a.equipment_id) : null;
    // VM rattachée (exclusive avec l'équipement) — nom résolu, non cliquable (parité avec la ligne « Équipement »).
    // La ligne n'apparaît que si une VM est ciblée OU s'il existe des VMs (feature amovible : rien en mode fichier sans VM).
    const vm: any = a.vm_id ? store.get("vms", a.vm_id) : null;
    const showVm = !!vm || store.all("vms").length > 0;
    const ipInt = Ip.toInt(a.address);
    const inRange = a.network_id ? Ip.dhcpRangeContaining(store, a.network_id, ipInt) : null;
    const pairs: Array<[string, string]> = [
      [I18n.t("lists.col.address"), `<span style="font-family:var(--mono)">${Html.escape(a.address || "?")}</span>`],
      [I18n.t("lists.col.ipNetwork"), ipn ? Html.escape(Ip.short(ipn)) : this.MUTED],
      [I18n.t("lists.col.equipment"), eq ? `${Html.escape(eq.name || "?")} ${EntityViz.equipmentLocationShort(store, eq)}` : `<span style="color:var(--fg-dimmer)">${I18n.t("detail.ipAddr.unassigned")}</span>`],
    ];
    if (showVm) pairs.push([I18n.t("detail.ipAddr.vm"), vm ? Html.escape(vm.name || "?") : this.MUTED]);
    pairs.push(
      [I18n.t("detail.ipAddr.hostname"), a.hostname ? Html.escape(a.hostname) : this.MUTED],
      [I18n.t("detail.ipAddr.inDhcp"), inRange ? `<span class="pill" style="color:var(--warn)">${I18n.t("detail.ipAddr.inDhcpYes", { start: Html.escape(inRange.start_ip), end: Html.escape(inRange.end_ip) })}</span>` : `<span style="color:var(--fg-dimmer)">${I18n.t("detail.ipAddr.inDhcpNo")}</span>`],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(a.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(a.updated_date))],
    );
    root.appendChild(this.grid(pairs));
    this.footer(root, () => this.ipAddress(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.ipAddr.title"), subtitle: Html.escape(a.address || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- PLAGE DHCP ---- */
  static dhcpRangeDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const rg: any = store.get("dhcpRanges", id);
    if (!rg) { Notify.toast(I18n.t("detail.nf.dhcpRange"), "err"); return; }
    const root = document.createElement("div");
    const ipn: any = rg.network_id ? store.get("ipNetworks", rg.network_id) : null;
    const srv: any = rg.server_id ? store.get("equipments", rg.server_id) : null;
    const s = Ip.toInt(rg.start_ip), e = Ip.toInt(rg.end_ip);
    const count = (s != null && e != null && e >= s) ? (e - s + 1) : null;
    root.appendChild(this.grid([
      [I18n.t("lists.col.ipNetwork"), ipn ? Html.escape(Ip.short(ipn)) : this.MUTED],
      [I18n.t("lists.col.range"), `<span style="font-family:var(--mono)">${Html.escape(rg.start_ip || "?")} – ${Html.escape(rg.end_ip || "?")}</span>`],
      [I18n.t("lists.col.size"), count != null ? `<span class="pill">${I18n.t("detail.dhcp.addrCount", { count })}</span>` : `<span style="color:var(--err)">${I18n.t("detail.dhcp.invalidRange")}</span>`],
      [I18n.t("lists.col.dhcpServer"), srv ? `${Html.escape(srv.name || "?")} ${EntityViz.equipmentLocationShort(store, srv)}` : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(rg.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(rg.updated_date))],
    ]));
    this.footer(root, () => this.dhcpRange(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.dhcp.title"), subtitle: ipn ? Html.escape(ipn.label || ipn.cidr || "") : "", body: root, hideFooter: true, wide: true });
  }

  /* ---- SALLE (datacenter) ---- */
  static datacenterDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const dc: any = store.get("datacenters", id);
    if (!dc) { Notify.toast(I18n.t("detail.nf.datacenter"), "err"); return; }
    const root = document.createElement("div");
    const locBits = [store.siteLabel(dc.location || ""), dc.floor ? I18n.t("detail.common.floorAbbrev", { floor: dc.floor }) : "", dc.room || ""].filter((x) => x && x !== "—");
    const doors = (dc.doors || []).length;
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(dc.name || I18n.t("lists.ph.room"))],
      [I18n.t("detail.common.place"), locBits.length ? `<span class="loc-pill">${Html.escape(locBits.join(" · "))}</span>` : this.MUTED],
      [I18n.t("lists.col.dimensions"), `${dc.width_mm} × ${dc.depth_mm} mm <span style="color:var(--fg-dimmer)">${I18n.t("detail.common.lxd")}</span> · ${I18n.t("detail.common.mesh", { cell: dc.cell_mm })}`],
      [I18n.t("detail.dc.doors"), doors ? `<span class="pill">${doors}</span>` : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(dc.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(dc.updated_date))],
    ]));

    const racks = store.racksOfDc(id).slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    this.sect(root, I18n.t("detail.dc.racksSection", { count: racks.length }));
    const tw = this.tbl(root, [I18n.t("detail.common.colRack"), I18n.t("lists.col.size"), ""], racks.map((r: any) => {
      const loc = host.locate ? `<button class="btn btn-ghost btn-sm icon-action" data-rack-loc="${r.id}" title="${I18n.t("lists.chrome.rowLocate")}" aria-label="${I18n.t("lists.chrome.rowLocate")}">${Icons.LOCATE}</button>` : "";
      const view = `<button class="btn btn-ghost btn-sm icon-action" data-rack-view="${r.id}" title="${I18n.t("lists.chrome.rowView")}" aria-label="${I18n.t("lists.chrome.rowView")}">${Icons.INFO}</button>`;
      return [Html.escape(r.name || I18n.t("lists.ph.rack")), `<span class="pill">${r.u_count} U</span>`, `<span class="cell-actions">${loc}${view}</span>`];
    }), I18n.t("detail.dc.racksEmpty"));
    tw?.querySelectorAll("[data-rack-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.rackDetail(store, host, (el as HTMLElement).dataset.rackView!, onChanged); });
    tw?.querySelectorAll("[data-rack-loc]").forEach((el) => { (el as HTMLElement).onclick = () => host.locate?.("rack", (el as HTMLElement).dataset.rackLoc!, () => this.datacenterDetail(store, host, id, onChanged)); });

    const free = store.freeEquipsOfDc(id).length, wps = store.waypointsOfDc(id).length;
    root.appendChild(this.grid([
      [I18n.t("detail.dc.freeEquips"), free ? `<span class="pill">${free}</span>` : this.MUTED],
      [I18n.t("detail.dc.waypoints"), wps ? `<span class="pill">${wps}</span>` : this.MUTED],
    ]));

    this.footer(root, () => this.datacenter(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.dc.title"), subtitle: Html.escape(dc.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- SITE (bâtiment) ---- */
  static siteDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const site: any = store.get("sites", id);
    if (!site) { Notify.toast(I18n.t("detail.nf.site"), "err"); return; }
    const root = document.createElement("div");
    const dcs = store.all("datacenters").filter((d: any) => (d.location || "") === id);
    const floors = store.floorsOf(id);
    const racks = dcs.reduce((sum: number, d: any) => sum + store.racksOfDc(d.id).length, 0);
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(site.name || I18n.t("lists.ph.site"))],
      [I18n.t("lists.col.address"), site.address ? Html.escape(site.address) : this.MUTED],
      [I18n.t("lists.col.floors"), floors.length ? `<span class="pill">${floors.length}</span>` : this.MUTED],
      [I18n.t("lists.col.rooms"), dcs.length ? `<span class="pill">${dcs.length}</span>` : this.MUTED],
      [I18n.t("detail.site.racksTotal"), racks ? `<span class="pill">${racks}</span>` : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(site.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(site.updated_date))],
    ]));
    this.sect(root, I18n.t("detail.site.roomsSection", { count: dcs.length }));
    const tw = this.tbl(root, [I18n.t("detail.common.colRoom"), I18n.t("lists.col.floor"), I18n.t("lists.col.racks"), ""], dcs.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => [
      Html.escape(d.name || I18n.t("lists.ph.room")), d.floor ? Html.escape(String(d.floor)) : this.MUTED, `<span class="pill">${store.racksOfDc(d.id).length}</span>`,
      `<span class="cell-actions"><button class="btn btn-ghost btn-sm icon-action" data-dc-view="${d.id}" title="${I18n.t("lists.chrome.rowView")}" aria-label="${I18n.t("lists.chrome.rowView")}">${Icons.INFO}</button></span>`,
    ]), I18n.t("detail.site.roomsEmpty"));
    tw?.querySelectorAll("[data-dc-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.datacenterDetail(store, host, (el as HTMLElement).dataset.dcView!, onChanged); });
    this.footer(root, () => this.site(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.site.title"), subtitle: Html.escape(site.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- GROUPE ---- */
  static groupDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const g: any = store.get("groups", id);
    if (!g) { Notify.toast(I18n.t("detail.nf.group"), "err"); return; }
    const root = document.createElement("div");
    root.appendChild(this.grid([
      [I18n.t("lists.col.label"), `<span class="pill colored-pill" ${Color.pillStyle(g.color)}>${Html.escape(g.label || I18n.t("lists.ph.group"))}</span>`],
      [I18n.t("lists.col.type"), `<span class="pill">${Html.escape(GroupTypes.label(g.type))}</span>`],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(g.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(g.updated_date))],
    ]));
    const eqs = store.equipmentsOfGroup(id).slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    this.sect(root, I18n.t("detail.group.membersSection", { count: eqs.length }));
    const tw = this.tbl(root, [I18n.t("lists.col.equipment"), I18n.t("lists.col.type"), I18n.t("lists.col.location"), ""], eqs.map((e: any) => {
      const primary = e.group_id === id;
      const view = `<button class="btn btn-ghost btn-sm icon-action" data-eq-view="${e.id}" title="${I18n.t("lists.chrome.rowView")}" aria-label="${I18n.t("lists.chrome.rowView")}">${Icons.INFO}</button>`;
      return [`${Html.escape(e.name || I18n.t("lists.ph.equipment"))}${primary ? ` <span class="pill">${I18n.t("detail.group.primary")}</span>` : ""}`, `<span class="pill">${Html.escape(EquipmentTypes.label(e.type))}</span>`, EntityViz.equipmentLocationShort(store, e), `<span class="cell-actions">${view}</span>`];
    }), I18n.t("detail.group.membersEmpty"));
    tw?.querySelectorAll("[data-eq-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.equipmentDetail(store, host, (el as HTMLElement).dataset.eqView!, onChanged); });
    this.footer(root, () => this.group(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.group.title"), subtitle: Html.escape(g.label || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- ÉTAGE ---- */
  static floorDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const f: any = store.get("floors", id);
    if (!f) { Notify.toast(I18n.t("detail.nf.floor"), "err"); return; }
    const root = document.createElement("div");
    const dcs = store.dcsOfFloor(f.location, f.floor);
    const oob = store.oobWaypoints().filter((w: any) => (w.location || "") === (f.location || "") && String(w.floor || "") === String(f.floor || ""));
    root.appendChild(this.grid([
      [I18n.t("lists.col.building"), Html.escape(store.siteLabel(f.location || ""))],
      [I18n.t("lists.col.floor"), Html.escape(String(f.floor || "—"))],
      [I18n.t("lists.col.dimensions"), `${f.width_mm} × ${f.depth_mm} mm <span style="color:var(--fg-dimmer)">${I18n.t("detail.common.lxd")}</span> · ${I18n.t("detail.common.mesh", { cell: f.cell_mm })}`],
      [I18n.t("lists.col.height"), f.height_mm ? `${f.height_mm} mm` : `<span style="color:var(--fg-dimmer)">${I18n.t("detail.floor.autoHeight")}</span>`],
      [I18n.t("detail.floor.floorPins"), oob.length ? `<span class="pill">${oob.length}</span>` : this.MUTED],
      [I18n.t("lists.col.description"), f.description ? Html.escape(f.description) : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(f.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(f.updated_date))],
    ]));
    this.sect(root, I18n.t("detail.floor.roomsSection", { count: dcs.length }));
    const tw = this.tbl(root, [I18n.t("detail.common.colRoom"), I18n.t("lists.col.racks"), ""], dcs.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => [
      Html.escape(d.name || I18n.t("lists.ph.room")), `<span class="pill">${store.racksOfDc(d.id).length}</span>`,
      `<span class="cell-actions"><button class="btn btn-ghost btn-sm icon-action" data-dc-view="${d.id}" title="${I18n.t("lists.chrome.rowView")}" aria-label="${I18n.t("lists.chrome.rowView")}">${Icons.INFO}</button></span>`,
    ]), I18n.t("detail.floor.roomsEmpty"));
    tw?.querySelectorAll("[data-dc-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.datacenterDetail(store, host, (el as HTMLElement).dataset.dcView!, onChanged); });
    this.footer(root, () => this.floor(store, host, f.location || "", String(f.floor || ""), {}));
    host.openModal({ title: I18n.t("detail.floor.title"), subtitle: Html.escape(I18n.t("detail.floor.subtitle", { site: store.siteLabel(f.location || ""), floor: f.floor || "" })), body: root, hideFooter: true, wide: true });
  }

  /* ---- SPARE (pièce de rechange) ---- */
  static spareDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const sp: any = store.get("spares", id);
    if (!sp) { Notify.toast(I18n.t("detail.nf.spare"), "err"); return; }
    const root = document.createElement("div");
    const assignedEq: any = sp.assigned_equipment_id ? store.get("equipments", sp.assigned_equipment_id) : null;
    const assignHtml = sp.status !== "assigned" ? `<span class="pill">${Html.escape(SpareStatuses.label(sp.status))}</span>`
      : assignedEq ? `${Html.escape(assignedEq.name || "?")} ${EntityViz.equipmentLocationShort(store, assignedEq)}`
      : sp.assigned_free ? Html.escape(sp.assigned_free) : this.MUTED;
    root.appendChild(this.grid([
      [I18n.t("lists.col.designation"), Html.escape(sp.displayName ? sp.displayName() : (sp.name || I18n.t("detail.spare.fallback")))],
      [I18n.t("lists.col.type"), `<span class="pill">${SpareTypes.svg(sp.type)}${Html.escape(SpareTypes.label(sp.type))}</span>`],
      [I18n.t("lists.col.characteristics"), sp.techSummary && sp.techSummary() ? Html.escape(sp.techSummary()) : this.MUTED],
      [I18n.t("detail.spare.brandModel"), [sp.brand, sp.model_pn].filter(Boolean).map(Html.escape).join(" · ") || this.MUTED],
      [I18n.t("detail.spare.serial"), sp.serial ? Html.escape(sp.serial) : this.MUTED],
      [I18n.t("lists.col.status"), `<span class="pill">${Html.escape(SpareStatuses.label(sp.status))}</span>`],
      [I18n.t("detail.spare.assignment"), assignHtml],
      [I18n.t("lists.col.storage"), sp.storage_location ? Html.escape(sp.storage_location) : this.MUTED],
      [I18n.t("lists.col.purchase"), [sp.purchase_date ? Html.escape(sp.purchase_date) : null, sp.po_ref ? I18n.t("detail.common.poRef", { ref: Html.escape(sp.po_ref) }) : null].filter(Boolean).join(" · ") || this.MUTED],
      [I18n.t("detail.spare.comment"), sp.comment ? Html.escape(sp.comment) : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(sp.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(sp.updated_date))],
    ]));
    // Intégration « fiches » : badge d'interventions ouvertes + « Déclarer une intervention » (no-op hors mode API).
    InterventionFicheRow.attach(root, host.interventionHooks, { kind: "spare", id, label: (sp.displayName ? sp.displayName() : (sp.name || "")) }, () => host.closeModal?.());
    this.footer(root, () => this.spare(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.spare.title"), subtitle: Html.escape(sp.displayName ? sp.displayName() : (sp.name || "")), body: root, hideFooter: true, wide: true });
  }

  /* ---- CONTACT (destinataire de notifications) ---- */
  static contactDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const c: any = store.get("contacts", id);
    if (!c) { Notify.toast(I18n.t("detail.nf.contact"), "err"); return; }
    const root = document.createElement("div");
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(c.name || I18n.t("lists.ph.contact"))],
      [I18n.t("lists.col.email"), c.email ? Html.escape(c.email) : this.MUTED],
      [I18n.t("lists.col.phone"), c.phone ? Html.escape(c.phone) : this.MUTED],
      [I18n.t("lists.col.notes"), c.notes ? Html.escape(c.notes) : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(c.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(c.updated_date))],
    ]));
    this.footer(root, () => this.contact(store, host, id, onChanged));
    host.openModal({ title: I18n.t("detail.contact.title"), subtitle: Html.escape(c.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- VM (équipement virtuel — feature amovible) ---- */
  /** Fiche détail RICHE d'une VM. Sépare visuellement l'IDENTITÉ SOURCE (alimentée par la synchro, lecture
      seule) des ENRICHISSEMENTS LOCAUX (édités via `VmForms.edit`, jamais écrasés par la synchro — cf.
      src-shared/VmSync). Résout : les vNIC → réseau logique via la table de mapping (`VmNetMapping`), les
      adresses IPAM rapprochées (`store.ipAddressesOfVm`), et l'hôte hébergeur → fiche équipement. */
  static vmDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const vm: any = store.get("vms", id);
    if (!vm) { Notify.toast(I18n.t("detail.nf.vm"), "err"); return; }
    const root = document.createElement("div");

    // -- IDENTITÉ SOURCE (lecture seule) --
    // Statut : pastille sémantique (running=ok, stopped=neutre, autre valeur affichée telle quelle — tolérance
    // aux releases Proxmox) ; une VM ORPHELINE (disparue au dernier sync) prime avec une pastille d'erreur EN TÊTE.
    const s = String(vm.status || "");
    const statusPill = (s === "running") ? `<span class="pill" style="border-color:var(--ok);color:var(--ok)">running</span>`
      : (s === "stopped") ? `<span class="pill" style="border-color:var(--fg-dimmer);color:var(--fg-dim)">stopped</span>`
      : s ? `<span class="pill">${Html.escape(s)}</span>` : this.MUTED;
    const orphanPill = vm.orphan ? `<span class="pill" style="border-color:var(--err);color:var(--err)" title="${I18n.t("detail.vm.orphanTitle")}">${I18n.t("lists.ph.orphan")}</span> ` : "";
    // RAM : Mo → lisible (Go dès 1024 Mo, avec le détail en Mo) ; disque déjà en Go côté source.
    const ramHtml = vm.ram_mb != null
      ? (vm.ram_mb >= 1024
        ? `${Math.round(vm.ram_mb / 102.4) / 10} Go <span style="color:var(--fg-dimmer)">(${vm.ram_mb} Mo)</span>`
        : `${vm.ram_mb} Mo`)
      : this.MUTED;
    const tagsHtml = (vm.tags_src || []).length ? (vm.tags_src as string[]).map((t) => `<span class="pill">${Html.escape(t)}</span>`).join(" ") : this.MUTED;
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(vm.name || I18n.t("lists.ph.vm"))],
      [I18n.t("lists.col.type"), vm.vm_type ? `<span class="pill">${Html.escape(vm.vm_type)}</span>` : this.MUTED],
      [I18n.t("lists.col.status"), orphanPill + statusPill],
      [I18n.t("detail.vm.vcpu"), vm.cpu != null ? `<span class="pill">${vm.cpu}</span>` : this.MUTED],
      [I18n.t("detail.vm.memory"), ramHtml],
      [I18n.t("detail.vm.disk"), vm.disk_gb != null ? `${vm.disk_gb} Go` : this.MUTED],
      // Description remontée par le provider : rendue en MARKDOWN (micromark, défauts sûrs — cf. core/Markdown)
      // dans un conteneur DÉDIÉ ; le HTML produit est neutralisé/filtré, injectable en innerHTML sans risque.
      [I18n.t("detail.vm.descSource"), vm.description_src ? `<div class="md-body">${Markdown.render(vm.description_src)}</div>` : this.MUTED],
      [I18n.t("detail.vm.tagsSource"), tagsHtml],
      [I18n.t("detail.vm.lastSync"), Html.escape(Format.dateTime(vm.last_sync))],
      [I18n.t("detail.vm.providerId"), vm.ext_id ? `<span style="font-family:var(--mono);color:var(--fg-dim)">${Html.escape(vm.ext_id)}</span>${vm.provider_id ? ` <span style="color:var(--fg-dimmer)">· ${Html.escape(vm.provider_id)}</span>` : ""}` : this.MUTED],
    ]));

    // -- vNIC : réseau logique RÉSOLU via la table de mapping (bridge/tag → réseau), pastille de couleur comme
    //    les réseaux ; « non raccordé » si aucun mapping. IPs constatées = donnée source informative (décision IPAM). --
    // Intégration « fiches » : badge d'interventions ouvertes + « Déclarer une intervention » (no-op hors mode API).
    InterventionFicheRow.attach(root, host.interventionHooks, { kind: "vm", id, label: vm.name || "" }, () => host.closeModal?.());

    const mapEntries = VmNetMapping.read(store.meta);
    const nics: any[] = Array.isArray(vm.nics) ? vm.nics : [];
    this.sect(root, I18n.t("detail.vm.nicsSection", { count: nics.length }));
    this.tbl(root, [I18n.t("lists.col.name"), I18n.t("detail.vm.colMac"), I18n.t("detail.vm.colBridge"), I18n.t("detail.vm.colLogicalNet"), I18n.t("detail.vm.colObservedIps")], nics.map((nic: any) => {
      const bridgeTag = nic.bridge
        ? `<span style="font-family:var(--mono)">${Html.escape(nic.bridge)}</span>` + (nic.vlan_tag != null ? ` <span style="color:var(--fg-dimmer)">${I18n.t("detail.vm.tag", { tag: nic.vlan_tag })}</span>` : ` <span style="color:var(--fg-dimmer)">${I18n.t("detail.vm.noTag")}</span>`)
        : this.MUTED;
      const net: any = (() => { const nid = VmNetMapping.resolve(mapEntries, nic.bridge, nic.vlan_tag); return nid ? store.get("networks", nid) : null; })();
      const netHtml = net ? `<span class="pill colored-pill" ${Color.pillStyle(net.color)}>${Html.escape(net.label || I18n.t("lists.ph.network"))}</span>` : `<span style="color:var(--fg-dimmer)">${I18n.t("detail.vm.notConnected")}</span>`;
      const ips: string[] = Array.isArray(nic.ips) ? nic.ips : [];
      const ipsHtml = ips.length ? ips.map((ip) => `<code>${Html.escape(ip)}</code>`).join(" ") : this.MUTED;
      return [Html.escape(nic.name || I18n.t("detail.vm.nicFallback")), nic.mac ? `<span style="font-family:var(--mono)">${Html.escape(nic.mac)}</span>` : this.MUTED, bridgeTag, netHtml, ipsHtml];
    }), I18n.t("detail.vm.nicsEmpty"));

    // -- Adresses IPAM LIÉES (rapprochées par vm_id) : ouverture de la fiche adresse (pattern des enfants liés). --
    const addrs = store.ipAddressesOfVm(id).slice().sort((a: any, b: any) => (Ip.toInt(a.address) || 0) - (Ip.toInt(b.address) || 0));
    this.sect(root, I18n.t("detail.vm.linkedSection", { count: addrs.length }));
    const twAddr = this.tbl(root, [I18n.t("lists.col.address"), I18n.t("lists.col.ipNetwork"), I18n.t("detail.ipAddr.hostname"), ""], addrs.map((a: any) => {
      const ipn: any = a.network_id ? store.get("ipNetworks", a.network_id) : null;
      return [
        `<span style="font-family:var(--mono)">${Html.escape(a.address || "?")}</span>`,
        ipn ? Html.escape(Ip.short(ipn)) : this.MUTED,
        a.hostname ? Html.escape(a.hostname) : this.MUTED,
        `<span class="cell-actions"><button class="btn btn-ghost btn-sm icon-action" data-addr-view="${a.id}" title="${I18n.t("detail.vm.openAddr")}" aria-label="${I18n.t("detail.vm.openAddr")}">${Icons.INFO}</button></span>`,
      ];
    }), I18n.t("detail.vm.linkedEmpty"));
    twAddr?.querySelectorAll("[data-addr-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.ipAddressDetail(store, host, (el as HTMLElement).dataset.addrView!, () => this.vmDetail(store, host, id, onChanged)); });

    // -- Rapprochements SUGGÉRÉS (IPAM informatif — cf. docs/vm-proxmox.md) : adresses IPAM EXISTANTES dont la valeur
    //    correspond à une IP constatée d'une vNIC, sans rattachement automatique. Bloc réservé au NON-viewer et
    //    n'apparaissant que s'il y a des propositions : sa seule raison d'être est le bouton « Rattacher » (aucune
    //    action en mode visualiseur → rien à afficher). La logique de correspondance/conflit vit dans le module PUR
    //    VmIpMatch (testé) ; ici on ne fait que rendre les propositions et câbler le clic. --
    if (!this.isViewer()) {
      const suggestions = VmIpMatch.suggestions(vm, store.all("ipAddresses"));
      if (suggestions.length) {
        this.sect(root, I18n.t("detail.vm.suggestSection", { count: suggestions.length }));
        const twSug = this.tbl(root, [I18n.t("lists.col.address"), I18n.t("lists.col.ipNetwork"), I18n.t("detail.vm.colVnic"), I18n.t("detail.vm.colConflict"), ""], suggestions.map((sg) => {
          const ipn: any = sg.network_id ? store.get("ipNetworks", sg.network_id) : null;
          // Avertissement de bascule : l'adresse est déjà prise par un équipement ou une autre VM (exclusivité). Le
          // rattachement videra l'affectation actuelle — on nomme la cible actuelle pour un consentement éclairé.
          let conflictHtml = this.MUTED;
          if (sg.conflict === "equipment") {
            const eq: any = sg.conflictId ? store.get("equipments", sg.conflictId) : null;
            conflictHtml = `<span style="color:var(--warn)">${I18n.t("detail.vm.conflictEquip", { name: Html.escape(eq ? (eq.name || "?") : "?") })}</span>`;
          } else if (sg.conflict === "other_vm") {
            const ovm: any = sg.conflictId ? store.get("vms", sg.conflictId) : null;
            conflictHtml = `<span style="color:var(--warn)">${I18n.t("detail.vm.conflictVm", { name: Html.escape(ovm ? (ovm.name || "?") : "?") })}</span>`;
          }
          return [
            `<span style="font-family:var(--mono)">${Html.escape(sg.ip || "?")}</span>`,
            ipn ? Html.escape(Ip.short(ipn)) : this.MUTED,
            Html.escape(sg.nicName || I18n.t("detail.vm.nicFallback")),
            conflictHtml,
            `<span class="cell-actions"><button class="row-btn" data-attach="${sg.id}" data-conflict="${sg.conflict || ""}" title="${I18n.t("detail.vm.attachTitle")}">${I18n.t("detail.vm.attach")}</button></span>`,
          ];
        }), "");
        twSug?.querySelectorAll("[data-attach]").forEach((el) => {
          const btn = el as HTMLElement;
          btn.onclick = async () => {
            const addrId = btn.dataset.attach!;
            const addr: any = store.get("ipAddresses", addrId);
            if (!addr) { Notify.toast(I18n.t("detail.nf.ipAddress"), "err"); return; }
            // Bascule d'exclusivité : si l'adresse est déjà prise (equipment/other_vm), on CONFIRME explicitement —
            // le rattachement vide l'affectation actuelle (l'invariant equipment_id/vm_id mutuellement exclusifs
            // l'impose, cf. spec ipAddresses). Adresse libre → rattachement direct, sans confirmation.
            const conflict = btn.dataset.conflict;
            if (conflict) {
              const target = (conflict === "equipment")
                ? I18n.t("detail.vm.targetEquip", { name: (store.get("equipments", addr.equipment_id) as any)?.name || "?" })
                : I18n.t("detail.vm.targetVm", { name: (store.get("vms", addr.vm_id) as any)?.name || "?" });
              const ok = await Dialog.confirm({
                title: I18n.t("detail.vm.attachConfirmTitle"),
                message: I18n.t("detail.vm.attachConfirmMsg", { addr: addr.address || "?", target, vm: vm.name || I18n.t("detail.vm.thisVm") }),
                confirmLabel: I18n.t("detail.vm.attach"),
              });
              if (!ok) return;
            }
            // Patch MINIMAL passé au store (comme les autres écritures de fiche) : la validation PARTAGÉE fusionne et
            // vérifie l'invariant d'exclusivité. On vide `equipment_id` pour respecter la bascule côté équipement.
            await store.update("ipAddresses", addrId, { vm_id: id, equipment_id: null });
            Notify.toast(I18n.t("detail.vm.attached"));
            onChanged?.();                                   // rafraîchit la liste/vue d'origine
            this.vmDetail(store, host, id, onChanged);       // re-rendu de la fiche (l'adresse passe en « liées »)
          };
        });
      }
    }

    // -- Hôte hébergeur : lien vers la fiche équipement si rapproché ; sinon nœud source BRUT « non rapproché ». --
    this.sect(root, I18n.t("detail.vm.hostSection"));
    const hostEq: any = vm.host_equipment_id ? store.get("equipments", vm.host_equipment_id) : null;
    if (hostEq) {
      // Fiche de l'hôte ouverte par un bouton-ICÔNE (Icons.INFO, principe n°14) posé SUR LA MÊME LIGNE que la valeur
      // « Équipement » — comme l'icône « ouvrir l'adresse » des IP liées plus haut. Aller-retour FAÇON INTERVENTIONS
      // (cf. app/main.ts openTargetDetail) : on ENVELOPPE le FormHost pour injecter un onClose GÉNÉRIQUE qui rouvre
      // CETTE fiche VM à TOUTE fermeture de la fiche équipement (pas seulement en cas de modification).
      const hostGrid = this.grid([[I18n.t("lists.col.equipment"),
        `${Html.escape(hostEq.name || "?")} ${EntityViz.equipmentLocationShort(store, hostEq)} `
        + IconButton.html({ icon: Icons.INFO, label: I18n.t("detail.vm.openHost"), act: "open-host" })]]);
      const openBtn = hostGrid.querySelector('[data-act="open-host"]') as HTMLElement | null;
      if (openBtn) openBtn.onclick = () => {
        const reopenVm = () => this.vmDetail(store, host, id, onChanged);
        const wrappedHost: FormHost = { ...host, openModal: (o) => host.openModal({ ...o, onClose: reopenVm }) };
        this.equipmentDetail(store, wrappedHost, hostEq.id, onChanged);
      };
      root.appendChild(hostGrid);
    } else {
      root.appendChild(this.grid([[I18n.t("detail.vm.sourceNode"), vm.host_node ? `${Html.escape(vm.host_node)} <span class="pill" style="border-color:var(--warn);color:var(--warn)">${I18n.t("detail.vm.notMatched")}</span>` : this.MUTED]]));
    }

    // -- ENRICHISSEMENTS LOCAUX (édités séparément, jamais écrasés par la synchro) --
    this.sect(root, I18n.t("detail.vm.localSection"));
    const primaryGrp: any = vm.group_id ? store.get("groups", vm.group_id) : null;
    const secondaryGrps: any[] = (Array.isArray(vm.group_ids) ? vm.group_ids : []).filter((gid: string) => gid !== (vm.group_id || null)).map((gid: string) => store.get("groups", gid)).filter(Boolean);
    const grpPills = [
      primaryGrp ? `<span class="pill colored-pill" ${Color.pillStyle(primaryGrp.color)} title="${I18n.t("detail.common.groupPrimary")}">${Html.escape(primaryGrp.label)}</span>` : null,
      ...secondaryGrps.map((g: any) => `<span class="pill colored-pill" ${Color.pillStyle(g.color)} title="${I18n.t("detail.common.groupSecondary")}">${Html.escape(g.label)}</span>`),
    ].filter(Boolean);
    root.appendChild(this.grid([
      [grpPills.length > 1 ? I18n.t("detail.common.groups") : I18n.t("lists.col.group"), grpPills.length ? grpPills.join(" ") : this.MUTED],
      // Description LOCALE retirée du modèle d'édition (les notes suffisent) → plus affichée ; la description
      // remontée par le provider (description_src, en markdown) reste dans l'identité source ci-dessus.
      [I18n.t("lists.col.notes"), vm.notes ? Html.escape(vm.notes) : this.MUTED],
      [I18n.t("detail.common.created"), Html.escape(Format.dateTime(vm.created_date))],
      [I18n.t("detail.common.updated"), Html.escape(Format.dateTime(vm.updated_date))],
    ]));

    // Pied d'actions : « Modifier » (champs LOCAUX, classe dédiée VmForms, feature amovible) + « Supprimer »
    // RÉSERVÉ AUX ORPHELINES. Pourquoi restreindre la suppression aux orphelines : une VM encore présente au
    // cluster serait RECRÉÉE à la synchro suivante en repartant de la source seule — on perdrait tous ses
    // enrichissements locaux (notes, groupes) et le mapping ; la frontière source/locaux (cf. docs/vm-proxmox.md)
    // n'a de sens que si l'on ne détruit pas la VM sous les pieds de la synchro. Seule une VM DISPARUE de
    // l'inventaire (orphan) est un vrai résidu que l'utilisateur peut purger sans qu'elle ne réapparaisse.
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    if (vm.orphan && !this.isViewer()) {
      const delBtn = document.createElement("button"); delBtn.type = "button"; delBtn.className = "btn btn-danger";
      delBtn.style.marginRight = "auto";   // isolé à gauche, à l'écart du bouton primaire « Modifier »
      delBtn.textContent = I18n.t("detail.vm.deleteOrphan");
      delBtn.onclick = async () => {
        const ok = await Dialog.confirm({
          title: I18n.t("detail.vm.deleteConfirmTitle"),
          message: I18n.t("detail.vm.deleteConfirmMsg", { name: vm.name || I18n.t("detail.vm.thisVm") }),
          confirmLabel: I18n.t("ui.action.delete"), danger: true,
        });
        if (!ok) return;
        // MÊME chemin que la suppression depuis une liste (main.ts → store.remove) : la cascade PARTAGÉE
        // (shared/Cascade) détache les ipAddresses.vm_id, et le pipeline REST/fichier existant s'applique.
        await store.remove("vms", id);
        host.closeModal?.();   // la VM n'existe plus → refermer la fiche
        onChanged?.();          // rafraîchit la liste/vue d'origine (équivalent du reRender d'une suppression de liste)
        Notify.toast(I18n.t("detail.vm.deleted"));
      };
      actions.appendChild(delBtn);
    }
    if (!this.isViewer()) {
      const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "btn btn-primary";
      editBtn.textContent = I18n.t("lists.chrome.rowEdit"); editBtn.onclick = () => VmForms.edit(store, host, id, onChanged);
      actions.appendChild(editBtn);
    }
    root.appendChild(actions);
    host.openModal({ title: I18n.t("detail.vm.title"), subtitle: Html.escape(vm.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- TYPE DE CÂBLE (catalogue, lecture seule) ---- */
  static cableTypeDetail(store: Store, host: FormHost, id: string): void {
    const t: any = store.get("cableTypes", id);
    if (!t) { Notify.toast(I18n.t("detail.nf.type"), "err"); return; }
    const root = document.createElement("div");
    const used = store.cablesOfType(id).length;
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(t.name || I18n.t("detail.common.typeFallback"))],
      [I18n.t("lists.col.family"), t.family ? Html.escape(t.family) : this.MUTED],
      [I18n.t("lists.col.medium"), t.medium ? Html.escape(t.medium) : this.MUTED],
      [I18n.t("detail.cableType.nature"), `<span class="pill">${t.kind === "power" ? I18n.t("detail.common.power") : I18n.t("detail.common.data")}</span>`],
      [I18n.t("detail.cableType.count"), used ? `<span class="pill">${used}</span>` : this.MUTED],
    ]));
    host.openModal({ title: I18n.t("detail.cableType.title"), subtitle: Html.escape(t.name || ""), body: root, hideFooter: true });
  }

  /* ---- TYPE DE PORT (catalogue, lecture seule) ---- */
  static portTypeDetail(store: Store, host: FormHost, id: string): void {
    const t: any = store.get("portTypes", id);
    if (!t) { Notify.toast(I18n.t("detail.nf.type"), "err"); return; }
    const root = document.createElement("div");
    const used = store.portsOfType(id).length;
    root.appendChild(this.grid([
      [I18n.t("lists.col.name"), Html.escape(t.name || I18n.t("detail.common.typeFallback"))],
      [I18n.t("lists.col.family"), t.family ? Html.escape(t.family) : this.MUTED],
      [I18n.t("lists.col.connector"), t.connector ? Html.escape(t.connector) : this.MUTED],
      [I18n.t("lists.col.speed"), t.speed ? Html.escape(t.speed) : this.MUTED],
      [I18n.t("detail.portType.duplex"), t.duplex ? I18n.t("detail.common.yes") : I18n.t("detail.common.no")],
      [I18n.t("detail.cableType.nature"), `<span class="pill">${t.kind === "power" ? I18n.t("detail.common.power") : I18n.t("detail.common.data")}</span>`],
      [I18n.t("detail.portType.count"), used ? `<span class="pill">${used}</span>` : this.MUTED],
    ]));
    host.openModal({ title: I18n.t("detail.portType.title"), subtitle: Html.escape(t.name || ""), body: root, hideFooter: true });
  }
}
