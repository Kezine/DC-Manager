import type { Store } from "../../store";
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
import type { FormHost } from "./shared";
import { IpamForms } from "./IpamForms";
import { VmNetMapping } from "../../core/VmNetMapping";
import { VmIpMatch } from "../../core/VmIpMatch";
import { VmForms } from "./VmForms";

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
    if (edit && !this.isViewer()) { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-primary"; b.textContent = "Modifier"; b.onclick = edit; actions.appendChild(b); }
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
    if (!c) { Notify.toast("Câble introuvable", "err"); return; }
    const root = document.createElement("div");
    const ct: any = c.cable_type_id ? store.get("cableTypes", c.cable_type_id) : null;
    const st = CableStatuses.get(c.status);
    // réseaux : le PRINCIPAL (network_id — porte la couleur du tracé) puis les secondaires
    const netPill = (n: any) => `<span class="pill colored-pill" ${Color.pillStyle(n.color)}>${Html.escape(n.label || "(réseau)")}</span>`;
    const primaryNet: any = c.network_id ? store.get("networks", c.network_id) : null;
    const otherNets = (c.network_ids || []).filter((nid: string) => nid !== c.network_id)
      .map((nid: string) => store.get("networks", nid)).filter((n: any) => n != null);
    const netsHtml = (primaryNet || otherNets.length)
      ? [primaryNet ? netPill(primaryNet) : null].concat(otherNets.map(netPill)).filter(Boolean).join(" ")
      : this.MUTED;
    root.appendChild(this.grid([
      ["Nom", Html.escape(c.name || "(câble)")],
      ["Type", ct ? `${Html.escape(ct.name)} <span style="color:var(--fg-dimmer)">· ${Html.escape(ct.family || "")}</span>` : this.MUTED],
      ["De", this.portRef(store, c.from_port_id)],
      ["Vers", this.portRef(store, c.to_port_id)],
      ["Réseau(x)", netsHtml],
      ["Statut", `<span class="pill ${st ? st.cls : ""}">${Html.escape(st ? st.label : (c.status || "—"))}</span>`],
      ["Longueur", c.length_m != null ? `${c.length_m} m` : this.MUTED],
      ["Description", c.description ? Html.escape(c.description) : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(c.created_date))],
      ["Modifié", Html.escape(Format.dateTime(c.updated_date))],
    ]));

    // tracé en mini-graphe (chaîne/profil) — couleur d'arête = réseau principal, tirets = statut
    this.sect(root, "Tracé");
    const epFromPort = (pid: string | null): RouteEndpointSpec | null => {
      const p: any = pid ? store.get("ports", pid) : null;
      if (!p) return null;
      const eq: any = store.get("equipments", p.equipment_id);
      return { label: eq ? (eq.name || "?") : "?", sub: "port " + (p.name || "?"), dcId: store.equipmentDcId(p.equipment_id) };
    };
    root.appendChild(RouteMiniGraph.render(store, store.cableRoute(c), {
      endpointA: epFromPort(c.from_port_id),
      endpointB: epFromPort(c.to_port_id),
      edgeColor: primaryNet && primaryNet.color ? primaryNet.color : null,
      status: c.status || null,
    }));

    // actions : Localiser en 3D + Modifier (mêmes conventions que equipment/rackDetail)
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    if (host.locate) { const locBtn = document.createElement("button"); locBtn.type = "button"; locBtn.className = "btn btn-ghost"; locBtn.textContent = "📍 Localiser en 3D"; locBtn.onclick = () => host.locate!("cable", c.id, () => this.cableDetail(store, host, id, onChanged)); actions.appendChild(locBtn); }
    if (!this.isViewer()) { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-primary"; b.textContent = "Modifier"; b.onclick = () => this.cable(store, host, id, onChanged); actions.appendChild(b); }
    root.appendChild(actions);
    host.openModal({ title: "Détail du câble", subtitle: Html.escape(c.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- FAISCEAU (trunk) ---- */
  static cableBundleDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const b: any = store.get("cableBundles", id);
    if (!b) { Notify.toast("Faisceau introuvable", "err"); return; }
    const root = document.createElement("div");
    const ct: any = b.cable_type_id ? store.get("cableTypes", b.cable_type_id) : null;
    const occ = store.bundleOccupancy(id);
    const endLabel = (eqId: string | null) => {
      const eq: any = eqId ? store.get("equipments", eqId) : null;
      if (!eq) return `<span style="color:var(--err)">non posée</span>`;
      return `${Html.escape(eq.name || "(patch)")} ${EntityViz.equipmentLocationShort(store, eq)}`;
    };
    root.appendChild(this.grid([
      ["Nom", Html.escape(b.name || "(faisceau)")],
      ["Type de fibre", ct ? `${Html.escape(ct.name)} <span style="color:var(--fg-dimmer)">· ${Html.escape(ct.family || "")}</span>` : this.MUTED],
      ["Capacité", `<span class="pill">${b.fiber_count} brins</span>`],
      ["Occupation", `<span class="pill">${occ.used}/${occ.capacity} pioché(s)</span> · <span class="pill">${occ.free} libre(s)</span>${occ.free <= 0 ? ` · <span class="pill" style="color:var(--err)">COMPLET</span>` : ""}`],
      ["Extrémité A", endLabel(b.endpoint_a_equipment_id)],
      ["Extrémité B", endLabel(b.endpoint_b_equipment_id)],
      ["Longueur", b.length_m != null ? `${b.length_m} m` : this.MUTED],
      ["Description", b.description ? Html.escape(b.description) : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(b.created_date))],
      ["Modifié", Html.escape(Format.dateTime(b.updated_date))],
    ]));

    // tracé en mini-graphe (remplace l'ancien résumé texte cableRouteSummary) — trunk : trait épais neutre
    // (un faisceau n'appartient pas à un réseau), pas de statut. Intra-salle sans waypoint : les deux
    // patchs reliés en direct dans la bande de leur salle.
    this.sect(root, "Tracé");
    const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: b.waypoint_ids || [] });
    const epSpec = (eqId: string | null): RouteEndpointSpec | null => {
      const eq: any = eqId ? store.get("equipments", eqId) : null;
      if (!eq) return null;
      return { label: eq.name || "(patch)", sub: "patch d'extrémité", dcId: store.equipmentDcId(eq.id) };
    };
    root.appendChild(RouteMiniGraph.render(store, r, {
      endpointA: epSpec(b.endpoint_a_equipment_id),
      endpointB: epSpec(b.endpoint_b_equipment_id),
      edgeColor: "var(--fg-dim)", thick: true,
    }));

    // ports de patch piochant des brins dans ce faisceau
    const ports = store.portsOfBundle(id).slice().sort((a: any, c: any) => (Math.min(a.strand_a ?? 99, a.strand_b ?? 99)) - (Math.min(c.strand_a ?? 99, c.strand_b ?? 99)));
    this.sect(root, "Brins piochés (" + ports.length + ")");
    const rows = ports.map((p: any) => {
      const eq: any = store.get("equipments", p.equipment_id);
      const strands = [p.strand_a, p.strand_b].filter((s) => s != null).join(" · ");
      const loc = host.locate ? `<button class="row-btn" data-port-loc="${p.id}" title="Localiser le port en 3D">📍</button>` : "";
      return [`${Html.escape(eq ? (eq.name || "?") : "?")} <span style="color:var(--fg-dimmer)">:</span> ${Html.escape(p.name || "(port)")}`, `<span style="font-family:var(--mono)">${strands || "—"}</span>`, `<span class="cell-actions">${loc}</span>`];
    });
    const tw = this.tbl(root, ["Port de patch", "Fibre(s)", ""], rows, "Aucun port ne pioche encore de brin (le tracé existe dès que les 2 extrémités sont posées).");
    tw?.querySelectorAll("[data-port-loc]").forEach((el) => { (el as HTMLElement).onclick = () => host.locate?.("port", (el as HTMLElement).dataset.portLoc!, () => this.cableBundleDetail(store, host, id, onChanged)); });

    this.footer(root, () => this.cableBundle(store, host, id, onChanged));
    host.openModal({ title: "Détail du faisceau", subtitle: Html.escape(b.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- RÉSEAU (logique) ---- */
  static networkDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const n: any = store.get("networks", id);
    if (!n) { Notify.toast("Réseau introuvable", "err"); return; }
    const root = document.createElement("div");
    const power = n.kind === "power";
    const swatch = `<span class="pill colored-pill" ${Color.pillStyle(n.color)}>${Html.escape(n.label || "(réseau)")}</span>`;
    const pairs: Array<[string, string]> = [
      ["Label", swatch],
      ["Type", `<span class="pill">${power ? "Power (alimentation)" : "Data (logique)"}</span>`],
    ];
    if (power) {
      const src = POWER_SOURCES.find((s) => s.id === n.power_source);
      pairs.push(["Tension", n.voltage != null ? `${n.voltage} V` : this.MUTED]);
      pairs.push(["Capacité max", n.max_amp != null ? `${n.max_amp} A` : this.MUTED]);
      pairs.push(["Alimentation", src ? Html.escape(src.label) : this.MUTED]);
    } else {
      const ipn: any = n.ip_network_id ? store.get("ipNetworks", n.ip_network_id) : null;
      pairs.push(["Réseau IP", ipn ? Html.escape(Ip.short(ipn)) : `<span style="color:var(--fg-dimmer)">purement logique</span>`]);
    }
    pairs.push(["Description", n.description ? Html.escape(n.description) : this.MUTED]);
    pairs.push(["Créé", Html.escape(Format.dateTime(n.created_date))]);
    pairs.push(["Modifié", Html.escape(Format.dateTime(n.updated_date))]);
    root.appendChild(this.grid(pairs));

    // ports d'équipement TERMINAL qui assertent ce réseau (source unique)
    const ports = store.portsOfNetwork(id);
    this.sect(root, "Ports assertant ce réseau (" + ports.length + ")");
    this.tbl(root, ["Équipement : port", "Principal ?"], ports.map((p: any) => {
      const isPrimary = p.network_id === id;
      return [this.portRef(store, p.id), isPrimary ? `<span class="pill">principal</span>` : `<span style="color:var(--fg-dimmer)">secondaire</span>`];
    }), "Aucun port n'assert ce réseau — assignez-le sur un port d'équipement terminal.");

    // câbles PORTANT le réseau (déduit le long des chemins)
    const cables = store.cablesOfNetwork(id);
    this.sect(root, "Câbles portant le réseau (" + cables.length + ")");
    this.tbl(root, ["Câble", "Liaison"], cables.slice(0, 50).map((c: any) => [
      Html.escape(c.name || "(câble)"),
      `${this.portRef(store, c.from_port_id)} <span style="color:var(--accent)">↔</span> ${this.portRef(store, c.to_port_id)}`,
    ]), "Aucun câble ne porte ce réseau.");
    if (cables.length > 50) { const m = document.createElement("div"); m.className = "form-hint"; m.textContent = "… et " + (cables.length - 50) + " autre(s)."; root.appendChild(m); }

    this.footer(root, () => this.network(store, host, id, onChanged));
    host.openModal({ title: "Détail du réseau", subtitle: Html.escape(n.label || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- RÉSEAU IP (IPAM) ---- */
  static ipNetworkDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const ipn: any = store.get("ipNetworks", id);
    if (!ipn) { Notify.toast("Réseau IP introuvable", "err"); return; }
    const root = document.createElement("div");
    const c = Ip.parseCidr(ipn.cidr);
    const pairs: Array<[string, string]> = [
      ["Label", Html.escape(ipn.label || "(réseau IP)")],
      ["CIDR", `<span style="font-family:var(--mono)">${Html.escape(ipn.cidr || "—")}</span>`],
    ];
    if (c) {
      pairs.push(["Adresse réseau", `<span style="font-family:var(--mono)">${c.networkStr}</span>`]);
      pairs.push(["Diffusion", `<span style="font-family:var(--mono)">${c.broadcastStr}</span>`]);
      pairs.push(["Plage d'hôtes", `<span style="font-family:var(--mono)">${Ip.toStr(c.firstHost)} – ${Ip.toStr(c.lastHost)}</span>`]);
      pairs.push(["Hôtes", `<span class="pill">${c.hostCount}</span>`]);
    } else if (ipn.cidr) pairs.push(["CIDR", `<span style="color:var(--err)">non analysable</span>`]);
    // passerelle / DNS / serveur DHCP du réseau
    pairs.push(["Passerelle", ipn.gateway ? `<span style="font-family:var(--mono)">${Html.escape(ipn.gateway)}</span>` : this.MUTED]);
    pairs.push(["Serveurs DNS", (Array.isArray(ipn.dns_servers) && ipn.dns_servers.length) ? `<span style="font-family:var(--mono)">${ipn.dns_servers.map((s: string) => Html.escape(s)).join(", ")}</span>` : this.MUTED]);
    const dhcpSrv: any = ipn.dhcp_server_id ? store.get("equipments", ipn.dhcp_server_id) : null;
    pairs.push(["Serveur DHCP", dhcpSrv ? `${Html.escape(dhcpSrv.name || "?")} ${EntityViz.equipmentLocationShort(store, dhcpSrv)}` : this.MUTED]);
    pairs.push(["Créé", Html.escape(Format.dateTime(ipn.created_date))]);
    pairs.push(["Modifié", Html.escape(Format.dateTime(ipn.updated_date))]);
    root.appendChild(this.grid(pairs));

    // réseaux LOGIQUES rattachés
    const nets = store.networksOfIpNetwork(id);
    if (nets.length) { this.sect(root, "Réseaux logiques associés (" + nets.length + ")");
      this.tbl(root, ["Réseau"], nets.map((nn: any) => [`<span class="pill colored-pill" ${Color.pillStyle(nn.color)}>${Html.escape(nn.label || "(réseau)")}</span>`]), ""); }

    // adresses statiques
    const addrs = store.ipAddressesOfNetwork(id).slice().sort((a: any, b: any) => (Ip.toInt(a.address) || 0) - (Ip.toInt(b.address) || 0));
    this.sect(root, "Adresses attribuées (" + addrs.length + ")");
    this.tbl(root, ["Adresse", "Équipement", "Hôte"], addrs.map((a: any) => {
      const eq: any = a.equipment_id ? store.get("equipments", a.equipment_id) : null;
      return [`<span style="font-family:var(--mono)">${Html.escape(a.address || "?")}</span>`, eq ? Html.escape(eq.name || "?") : this.MUTED, a.hostname ? Html.escape(a.hostname) : this.MUTED];
    }), "Aucune adresse statique.");

    // plages DHCP
    const ranges = store.dhcpRangesOfNetwork(id);
    if (ranges.length) { this.sect(root, "Plages DHCP (" + ranges.length + ")");
      this.tbl(root, ["Plage", "Serveur"], ranges.map((rg: any) => {
        const srv: any = rg.server_id ? store.get("equipments", rg.server_id) : null;
        return [`<span style="font-family:var(--mono)">${Html.escape(rg.start_ip || "?")} – ${Html.escape(rg.end_ip || "?")}</span>`, srv ? Html.escape(srv.name || "?") : this.MUTED];
      }), ""); }

    this.footer(root, () => this.ipNetwork(store, host, id, onChanged));
    host.openModal({ title: "Détail du réseau IP", subtitle: Html.escape(ipn.label || ipn.cidr || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- ADRESSE IP ---- */
  static ipAddressDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const a: any = store.get("ipAddresses", id);
    if (!a) { Notify.toast("Adresse introuvable", "err"); return; }
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
      ["Adresse", `<span style="font-family:var(--mono)">${Html.escape(a.address || "?")}</span>`],
      ["Réseau IP", ipn ? Html.escape(Ip.short(ipn)) : this.MUTED],
      ["Équipement", eq ? `${Html.escape(eq.name || "?")} ${EntityViz.equipmentLocationShort(store, eq)}` : `<span style="color:var(--fg-dimmer)">non attribuée</span>`],
    ];
    if (showVm) pairs.push(["VM", vm ? Html.escape(vm.name || "?") : this.MUTED]);
    pairs.push(
      ["Nom d'hôte", a.hostname ? Html.escape(a.hostname) : this.MUTED],
      ["Dans une plage DHCP", inRange ? `<span class="pill" style="color:var(--warn)">oui — ${Html.escape(inRange.start_ip)}–${Html.escape(inRange.end_ip)}</span>` : `<span style="color:var(--fg-dimmer)">non</span>`],
      ["Créé", Html.escape(Format.dateTime(a.created_date))],
      ["Modifié", Html.escape(Format.dateTime(a.updated_date))],
    );
    root.appendChild(this.grid(pairs));
    this.footer(root, () => this.ipAddress(store, host, id, onChanged));
    host.openModal({ title: "Détail de l'adresse IP", subtitle: Html.escape(a.address || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- PLAGE DHCP ---- */
  static dhcpRangeDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const rg: any = store.get("dhcpRanges", id);
    if (!rg) { Notify.toast("Plage introuvable", "err"); return; }
    const root = document.createElement("div");
    const ipn: any = rg.network_id ? store.get("ipNetworks", rg.network_id) : null;
    const srv: any = rg.server_id ? store.get("equipments", rg.server_id) : null;
    const s = Ip.toInt(rg.start_ip), e = Ip.toInt(rg.end_ip);
    const count = (s != null && e != null && e >= s) ? (e - s + 1) : null;
    root.appendChild(this.grid([
      ["Réseau IP", ipn ? Html.escape(Ip.short(ipn)) : this.MUTED],
      ["Plage", `<span style="font-family:var(--mono)">${Html.escape(rg.start_ip || "?")} – ${Html.escape(rg.end_ip || "?")}</span>`],
      ["Taille", count != null ? `<span class="pill">${count} adresse(s)</span>` : `<span style="color:var(--err)">plage invalide</span>`],
      ["Serveur DHCP", srv ? `${Html.escape(srv.name || "?")} ${EntityViz.equipmentLocationShort(store, srv)}` : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(rg.created_date))],
      ["Modifié", Html.escape(Format.dateTime(rg.updated_date))],
    ]));
    this.footer(root, () => this.dhcpRange(store, host, id, onChanged));
    host.openModal({ title: "Détail de la plage DHCP", subtitle: ipn ? Html.escape(ipn.label || ipn.cidr || "") : "", body: root, hideFooter: true, wide: true });
  }

  /* ---- SALLE (datacenter) ---- */
  static datacenterDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const dc: any = store.get("datacenters", id);
    if (!dc) { Notify.toast("Salle introuvable", "err"); return; }
    const root = document.createElement("div");
    const locBits = [store.siteLabel(dc.location || ""), dc.floor ? "ét. " + dc.floor : "", dc.room || ""].filter((x) => x && x !== "—");
    const doors = (dc.doors || []).length;
    root.appendChild(this.grid([
      ["Nom", Html.escape(dc.name || "(salle)")],
      ["Lieu", locBits.length ? `<span class="loc-pill">${Html.escape(locBits.join(" · "))}</span>` : this.MUTED],
      ["Dimensions", `${dc.width_mm} × ${dc.depth_mm} mm <span style="color:var(--fg-dimmer)">(l × p)</span> · maille ${dc.cell_mm} mm`],
      ["Portes", doors ? `<span class="pill">${doors}</span>` : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(dc.created_date))],
      ["Modifié", Html.escape(Format.dateTime(dc.updated_date))],
    ]));

    const racks = store.racksOfDc(id).slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    this.sect(root, "Baies (" + racks.length + ")");
    const tw = this.tbl(root, ["Baie", "Taille", ""], racks.map((r: any) => {
      const loc = host.locate ? `<button class="row-btn" data-rack-loc="${r.id}" title="Localiser en 3D">📍</button>` : "";
      const view = `<button class="row-btn" data-rack-view="${r.id}" title="Détails">ⓘ</button>`;
      return [Html.escape(r.name || "(baie)"), `<span class="pill">${r.u_count} U</span>`, `<span class="cell-actions">${loc}${view}</span>`];
    }), "Aucune baie dans cette salle.");
    tw?.querySelectorAll("[data-rack-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.rackDetail(store, host, (el as HTMLElement).dataset.rackView!, onChanged); });
    tw?.querySelectorAll("[data-rack-loc]").forEach((el) => { (el as HTMLElement).onclick = () => host.locate?.("rack", (el as HTMLElement).dataset.rackLoc!, () => this.datacenterDetail(store, host, id, onChanged)); });

    const free = store.freeEquipsOfDc(id).length, wps = store.waypointsOfDc(id).length;
    root.appendChild(this.grid([
      ["Équipements libres", free ? `<span class="pill">${free}</span>` : this.MUTED],
      ["Waypoints", wps ? `<span class="pill">${wps}</span>` : this.MUTED],
    ]));

    this.footer(root, () => this.datacenter(store, host, id, onChanged));
    host.openModal({ title: "Détail de la salle", subtitle: Html.escape(dc.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- SITE (bâtiment) ---- */
  static siteDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const site: any = store.get("sites", id);
    if (!site) { Notify.toast("Site introuvable", "err"); return; }
    const root = document.createElement("div");
    const dcs = store.all("datacenters").filter((d: any) => (d.location || "") === id);
    const floors = store.floorsOf(id);
    const racks = dcs.reduce((sum: number, d: any) => sum + store.racksOfDc(d.id).length, 0);
    root.appendChild(this.grid([
      ["Nom", Html.escape(site.name || "(site)")],
      ["Adresse", site.address ? Html.escape(site.address) : this.MUTED],
      ["Étages", floors.length ? `<span class="pill">${floors.length}</span>` : this.MUTED],
      ["Salles", dcs.length ? `<span class="pill">${dcs.length}</span>` : this.MUTED],
      ["Baies (total)", racks ? `<span class="pill">${racks}</span>` : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(site.created_date))],
      ["Modifié", Html.escape(Format.dateTime(site.updated_date))],
    ]));
    this.sect(root, "Salles (" + dcs.length + ")");
    const tw = this.tbl(root, ["Salle", "Étage", "Baies", ""], dcs.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => [
      Html.escape(d.name || "(salle)"), d.floor ? Html.escape(String(d.floor)) : this.MUTED, `<span class="pill">${store.racksOfDc(d.id).length}</span>`,
      `<span class="cell-actions"><button class="row-btn" data-dc-view="${d.id}" title="Détails">ⓘ</button></span>`,
    ]), "Aucune salle dans ce site.");
    tw?.querySelectorAll("[data-dc-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.datacenterDetail(store, host, (el as HTMLElement).dataset.dcView!, onChanged); });
    this.footer(root, () => this.site(store, host, id, onChanged));
    host.openModal({ title: "Détail du site", subtitle: Html.escape(site.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- GROUPE ---- */
  static groupDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const g: any = store.get("groups", id);
    if (!g) { Notify.toast("Groupe introuvable", "err"); return; }
    const root = document.createElement("div");
    root.appendChild(this.grid([
      ["Label", `<span class="pill colored-pill" ${Color.pillStyle(g.color)}>${Html.escape(g.label || "(groupe)")}</span>`],
      ["Type", `<span class="pill">${Html.escape(GroupTypes.label(g.type))}</span>`],
      ["Créé", Html.escape(Format.dateTime(g.created_date))],
      ["Modifié", Html.escape(Format.dateTime(g.updated_date))],
    ]));
    const eqs = store.equipmentsOfGroup(id).slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    this.sect(root, "Membres (" + eqs.length + ")");
    const tw = this.tbl(root, ["Équipement", "Type", "Emplacement", ""], eqs.map((e: any) => {
      const primary = e.group_id === id;
      const view = `<button class="row-btn" data-eq-view="${e.id}" title="Détails">ⓘ</button>`;
      return [`${Html.escape(e.name || "(équip.)")}${primary ? ` <span class="pill">primaire</span>` : ""}`, `<span class="pill">${Html.escape(EquipmentTypes.label(e.type))}</span>`, EntityViz.equipmentLocationShort(store, e), `<span class="cell-actions">${view}</span>`];
    }), "Aucun équipement dans ce groupe.");
    tw?.querySelectorAll("[data-eq-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.equipmentDetail(store, host, (el as HTMLElement).dataset.eqView!, onChanged); });
    this.footer(root, () => this.group(store, host, id, onChanged));
    host.openModal({ title: "Détail du groupe", subtitle: Html.escape(g.label || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- ÉTAGE ---- */
  static floorDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const f: any = store.get("floors", id);
    if (!f) { Notify.toast("Étage introuvable", "err"); return; }
    const root = document.createElement("div");
    const dcs = store.dcsOfFloor(f.location, f.floor);
    const oob = store.oobWaypoints().filter((w: any) => (w.location || "") === (f.location || "") && String(w.floor || "") === String(f.floor || ""));
    root.appendChild(this.grid([
      ["Bâtiment", Html.escape(store.siteLabel(f.location || ""))],
      ["Étage", Html.escape(String(f.floor || "—"))],
      ["Dimensions", `${f.width_mm} × ${f.depth_mm} mm <span style="color:var(--fg-dimmer)">(l × p)</span> · maille ${f.cell_mm} mm`],
      ["Hauteur", f.height_mm ? `${f.height_mm} mm` : `<span style="color:var(--fg-dimmer)">auto (contenu)</span>`],
      ["Pins d'étage", oob.length ? `<span class="pill">${oob.length}</span>` : this.MUTED],
      ["Description", f.description ? Html.escape(f.description) : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(f.created_date))],
      ["Modifié", Html.escape(Format.dateTime(f.updated_date))],
    ]));
    this.sect(root, "Salles de l'étage (" + dcs.length + ")");
    const tw = this.tbl(root, ["Salle", "Baies", ""], dcs.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => [
      Html.escape(d.name || "(salle)"), `<span class="pill">${store.racksOfDc(d.id).length}</span>`,
      `<span class="cell-actions"><button class="row-btn" data-dc-view="${d.id}" title="Détails">ⓘ</button></span>`,
    ]), "Aucune salle sur cet étage.");
    tw?.querySelectorAll("[data-dc-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.datacenterDetail(store, host, (el as HTMLElement).dataset.dcView!, onChanged); });
    this.footer(root, () => this.floor(store, host, f.location || "", String(f.floor || ""), {}));
    host.openModal({ title: "Détail de l'étage", subtitle: Html.escape(store.siteLabel(f.location || "") + " · ét. " + (f.floor || "")), body: root, hideFooter: true, wide: true });
  }

  /* ---- SPARE (pièce de rechange) ---- */
  static spareDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const sp: any = store.get("spares", id);
    if (!sp) { Notify.toast("Pièce introuvable", "err"); return; }
    const root = document.createElement("div");
    const assignedEq: any = sp.assigned_equipment_id ? store.get("equipments", sp.assigned_equipment_id) : null;
    const assignHtml = sp.status !== "assigned" ? `<span class="pill">${Html.escape(SpareStatuses.label(sp.status))}</span>`
      : assignedEq ? `${Html.escape(assignedEq.name || "?")} ${EntityViz.equipmentLocationShort(store, assignedEq)}`
      : sp.assigned_free ? Html.escape(sp.assigned_free) : this.MUTED;
    root.appendChild(this.grid([
      ["Désignation", Html.escape(sp.displayName ? sp.displayName() : (sp.name || "(pièce)"))],
      ["Type", `<span class="pill">${SpareTypes.icon(sp.type)} ${Html.escape(SpareTypes.label(sp.type))}</span>`],
      ["Caractéristiques", sp.techSummary && sp.techSummary() ? Html.escape(sp.techSummary()) : this.MUTED],
      ["Marque / modèle", [sp.brand, sp.model_pn].filter(Boolean).map(Html.escape).join(" · ") || this.MUTED],
      ["N° de série", sp.serial ? Html.escape(sp.serial) : this.MUTED],
      ["Statut", `<span class="pill">${Html.escape(SpareStatuses.label(sp.status))}</span>`],
      ["Affectation", assignHtml],
      ["Stockage", sp.storage_location ? Html.escape(sp.storage_location) : this.MUTED],
      ["Achat", [sp.purchase_date ? Html.escape(sp.purchase_date) : null, sp.po_ref ? "BC " + Html.escape(sp.po_ref) : null].filter(Boolean).join(" · ") || this.MUTED],
      ["Commentaire", sp.comment ? Html.escape(sp.comment) : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(sp.created_date))],
      ["Modifié", Html.escape(Format.dateTime(sp.updated_date))],
    ]));
    this.footer(root, () => this.spare(store, host, id, onChanged));
    host.openModal({ title: "Détail de la pièce", subtitle: Html.escape(sp.displayName ? sp.displayName() : (sp.name || "")), body: root, hideFooter: true, wide: true });
  }

  /* ---- CONTACT (destinataire de notifications) ---- */
  static contactDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const c: any = store.get("contacts", id);
    if (!c) { Notify.toast("Contact introuvable", "err"); return; }
    const root = document.createElement("div");
    root.appendChild(this.grid([
      ["Nom", Html.escape(c.name || "(contact)")],
      ["E-mail", c.email ? Html.escape(c.email) : this.MUTED],
      ["Téléphone", c.phone ? Html.escape(c.phone) : this.MUTED],
      ["Notes", c.notes ? Html.escape(c.notes) : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(c.created_date))],
      ["Modifié", Html.escape(Format.dateTime(c.updated_date))],
    ]));
    this.footer(root, () => this.contact(store, host, id, onChanged));
    host.openModal({ title: "Détail du contact", subtitle: Html.escape(c.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- VM (équipement virtuel — feature amovible) ---- */
  /** Fiche détail RICHE d'une VM. Sépare visuellement l'IDENTITÉ SOURCE (alimentée par la synchro, lecture
      seule) des ENRICHISSEMENTS LOCAUX (édités via `VmForms.edit`, jamais écrasés par la synchro — cf.
      src-shared/VmSync). Résout : les vNIC → réseau logique via la table de mapping (`VmNetMapping`), les
      adresses IPAM rapprochées (`store.ipAddressesOfVm`), et l'hôte hébergeur → fiche équipement. */
  static vmDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const vm: any = store.get("vms", id);
    if (!vm) { Notify.toast("VM introuvable", "err"); return; }
    const root = document.createElement("div");

    // -- IDENTITÉ SOURCE (lecture seule) --
    // Statut : pastille sémantique (running=ok, stopped=neutre, autre valeur affichée telle quelle — tolérance
    // aux releases Proxmox) ; une VM ORPHELINE (disparue au dernier sync) prime avec une pastille d'erreur EN TÊTE.
    const s = String(vm.status || "");
    const statusPill = (s === "running") ? `<span class="pill" style="border-color:var(--ok);color:var(--ok)">running</span>`
      : (s === "stopped") ? `<span class="pill" style="border-color:var(--fg-dimmer);color:var(--fg-dim)">stopped</span>`
      : s ? `<span class="pill">${Html.escape(s)}</span>` : this.MUTED;
    const orphanPill = vm.orphan ? `<span class="pill" style="border-color:var(--err);color:var(--err)" title="Disparue à la dernière synchronisation">orpheline</span> ` : "";
    // RAM : Mo → lisible (Go dès 1024 Mo, avec le détail en Mo) ; disque déjà en Go côté source.
    const ramHtml = vm.ram_mb != null
      ? (vm.ram_mb >= 1024
        ? `${Math.round(vm.ram_mb / 102.4) / 10} Go <span style="color:var(--fg-dimmer)">(${vm.ram_mb} Mo)</span>`
        : `${vm.ram_mb} Mo`)
      : this.MUTED;
    const tagsHtml = (vm.tags_src || []).length ? (vm.tags_src as string[]).map((t) => `<span class="pill">${Html.escape(t)}</span>`).join(" ") : this.MUTED;
    root.appendChild(this.grid([
      ["Nom", Html.escape(vm.name || "(VM)")],
      ["Type", vm.vm_type ? `<span class="pill">${Html.escape(vm.vm_type)}</span>` : this.MUTED],
      ["Statut", orphanPill + statusPill],
      ["vCPU", vm.cpu != null ? `<span class="pill">${vm.cpu}</span>` : this.MUTED],
      ["Mémoire", ramHtml],
      ["Disque", vm.disk_gb != null ? `${vm.disk_gb} Go` : this.MUTED],
      // Description remontée par le provider : rendue en MARKDOWN (micromark, défauts sûrs — cf. core/Markdown)
      // dans un conteneur DÉDIÉ ; le HTML produit est neutralisé/filtré, injectable en innerHTML sans risque.
      ["Description (source)", vm.description_src ? `<div class="md-body">${Markdown.render(vm.description_src)}</div>` : this.MUTED],
      ["Tags (source)", tagsHtml],
      ["Dernière synchro", Html.escape(Format.dateTime(vm.last_sync))],
      ["Identifiant provider", vm.ext_id ? `<span style="font-family:var(--mono);color:var(--fg-dim)">${Html.escape(vm.ext_id)}</span>${vm.provider_id ? ` <span style="color:var(--fg-dimmer)">· ${Html.escape(vm.provider_id)}</span>` : ""}` : this.MUTED],
    ]));

    // -- vNIC : réseau logique RÉSOLU via la table de mapping (bridge/tag → réseau), pastille de couleur comme
    //    les réseaux ; « non raccordé » si aucun mapping. IPs constatées = donnée source informative (décision IPAM). --
    const mapEntries = VmNetMapping.read(store.meta);
    const nics: any[] = Array.isArray(vm.nics) ? vm.nics : [];
    this.sect(root, "Interfaces réseau (vNIC) (" + nics.length + ")");
    this.tbl(root, ["Nom", "MAC", "Pont / VLAN", "Réseau logique", "IPs constatées"], nics.map((nic: any) => {
      const bridgeTag = nic.bridge
        ? `<span style="font-family:var(--mono)">${Html.escape(nic.bridge)}</span>` + (nic.vlan_tag != null ? ` <span style="color:var(--fg-dimmer)">· tag ${nic.vlan_tag}</span>` : ` <span style="color:var(--fg-dimmer)">· sans tag</span>`)
        : this.MUTED;
      const net: any = (() => { const nid = VmNetMapping.resolve(mapEntries, nic.bridge, nic.vlan_tag); return nid ? store.get("networks", nid) : null; })();
      const netHtml = net ? `<span class="pill colored-pill" ${Color.pillStyle(net.color)}>${Html.escape(net.label || "(réseau)")}</span>` : `<span style="color:var(--fg-dimmer)">non raccordé</span>`;
      const ips: string[] = Array.isArray(nic.ips) ? nic.ips : [];
      const ipsHtml = ips.length ? ips.map((ip) => `<code>${Html.escape(ip)}</code>`).join(" ") : this.MUTED;
      return [Html.escape(nic.name || "(vNIC)"), nic.mac ? `<span style="font-family:var(--mono)">${Html.escape(nic.mac)}</span>` : this.MUTED, bridgeTag, netHtml, ipsHtml];
    }), "Aucune interface réseau.");

    // -- Adresses IPAM LIÉES (rapprochées par vm_id) : ouverture de la fiche adresse (pattern des enfants liés). --
    const addrs = store.ipAddressesOfVm(id).slice().sort((a: any, b: any) => (Ip.toInt(a.address) || 0) - (Ip.toInt(b.address) || 0));
    this.sect(root, "Adresses IPAM liées (" + addrs.length + ")");
    const twAddr = this.tbl(root, ["Adresse", "Réseau IP", "Nom d'hôte", ""], addrs.map((a: any) => {
      const ipn: any = a.network_id ? store.get("ipNetworks", a.network_id) : null;
      return [
        `<span style="font-family:var(--mono)">${Html.escape(a.address || "?")}</span>`,
        ipn ? Html.escape(Ip.short(ipn)) : this.MUTED,
        a.hostname ? Html.escape(a.hostname) : this.MUTED,
        `<span class="cell-actions"><button class="row-btn" data-addr-view="${a.id}" title="Ouvrir la fiche de l'adresse">ⓘ</button></span>`,
      ];
    }), "Aucune adresse IPAM rapprochée de cette VM (rapprochement informatif depuis l'IPAM).");
    twAddr?.querySelectorAll("[data-addr-view]").forEach((el) => { (el as HTMLElement).onclick = () => this.ipAddressDetail(store, host, (el as HTMLElement).dataset.addrView!, () => this.vmDetail(store, host, id, onChanged)); });

    // -- Rapprochements SUGGÉRÉS (IPAM informatif — cf. docs/vm-proxmox.md) : adresses IPAM EXISTANTES dont la valeur
    //    correspond à une IP constatée d'une vNIC, sans rattachement automatique. Bloc réservé au NON-viewer et
    //    n'apparaissant que s'il y a des propositions : sa seule raison d'être est le bouton « Rattacher » (aucune
    //    action en mode visualiseur → rien à afficher). La logique de correspondance/conflit vit dans le module PUR
    //    VmIpMatch (testé) ; ici on ne fait que rendre les propositions et câbler le clic. --
    if (!this.isViewer()) {
      const suggestions = VmIpMatch.suggestions(vm, store.all("ipAddresses"));
      if (suggestions.length) {
        this.sect(root, "Rapprochements suggérés (" + suggestions.length + ")");
        const twSug = this.tbl(root, ["Adresse", "Réseau IP", "vNIC", "Conflit", ""], suggestions.map((sg) => {
          const ipn: any = sg.network_id ? store.get("ipNetworks", sg.network_id) : null;
          // Avertissement de bascule : l'adresse est déjà prise par un équipement ou une autre VM (exclusivité). Le
          // rattachement videra l'affectation actuelle — on nomme la cible actuelle pour un consentement éclairé.
          let conflictHtml = this.MUTED;
          if (sg.conflict === "equipment") {
            const eq: any = sg.conflictId ? store.get("equipments", sg.conflictId) : null;
            conflictHtml = `<span style="color:var(--warn)">Rattachée à l'équipement ${Html.escape(eq ? (eq.name || "?") : "?")}</span>`;
          } else if (sg.conflict === "other_vm") {
            const ovm: any = sg.conflictId ? store.get("vms", sg.conflictId) : null;
            conflictHtml = `<span style="color:var(--warn)">Rattachée à la VM ${Html.escape(ovm ? (ovm.name || "?") : "?")}</span>`;
          }
          return [
            `<span style="font-family:var(--mono)">${Html.escape(sg.ip || "?")}</span>`,
            ipn ? Html.escape(Ip.short(ipn)) : this.MUTED,
            Html.escape(sg.nicName || "(vNIC)"),
            conflictHtml,
            `<span class="cell-actions"><button class="row-btn" data-attach="${sg.id}" data-conflict="${sg.conflict || ""}" title="Rattacher cette adresse à la VM">Rattacher</button></span>`,
          ];
        }), "");
        twSug?.querySelectorAll("[data-attach]").forEach((el) => {
          const btn = el as HTMLElement;
          btn.onclick = async () => {
            const addrId = btn.dataset.attach!;
            const addr: any = store.get("ipAddresses", addrId);
            if (!addr) { Notify.toast("Adresse introuvable", "err"); return; }
            // Bascule d'exclusivité : si l'adresse est déjà prise (equipment/other_vm), on CONFIRME explicitement —
            // le rattachement vide l'affectation actuelle (l'invariant equipment_id/vm_id mutuellement exclusifs
            // l'impose, cf. spec ipAddresses). Adresse libre → rattachement direct, sans confirmation.
            const conflict = btn.dataset.conflict;
            if (conflict) {
              const target = (conflict === "equipment")
                ? `l'équipement « ${(store.get("equipments", addr.equipment_id) as any)?.name || "?"} »`
                : `la VM « ${(store.get("vms", addr.vm_id) as any)?.name || "?"} »`;
              const ok = await Dialog.confirm({
                title: "Rattacher cette adresse à la VM ?",
                message: `L'adresse ${addr.address || "?"} est actuellement rattachée à ${target}. La rattacher à « ${vm.name || "cette VM"} » retirera ce rattachement (une adresse vise un équipement OU une VM, jamais les deux).`,
                confirmLabel: "Rattacher",
              });
              if (!ok) return;
            }
            // Patch MINIMAL passé au store (comme les autres écritures de fiche) : la validation PARTAGÉE fusionne et
            // vérifie l'invariant d'exclusivité. On vide `equipment_id` pour respecter la bascule côté équipement.
            await store.update("ipAddresses", addrId, { vm_id: id, equipment_id: null });
            Notify.toast("Adresse rattachée à la VM");
            onChanged?.();                                   // rafraîchit la liste/vue d'origine
            this.vmDetail(store, host, id, onChanged);       // re-rendu de la fiche (l'adresse passe en « liées »)
          };
        });
      }
    }

    // -- Hôte hébergeur : lien vers la fiche équipement si rapproché ; sinon nœud source BRUT « non rapproché ». --
    this.sect(root, "Hôte hébergeur");
    const hostEq: any = vm.host_equipment_id ? store.get("equipments", vm.host_equipment_id) : null;
    if (hostEq) {
      root.appendChild(this.grid([["Équipement", `${Html.escape(hostEq.name || "?")} ${EntityViz.equipmentLocationShort(store, hostEq)}`]]));
      const openWrap = document.createElement("div"); openWrap.style.cssText = "margin-top:4px";
      const openBtn = document.createElement("button"); openBtn.type = "button"; openBtn.className = "btn btn-ghost btn-sm"; openBtn.textContent = "Ouvrir la fiche de l'hôte";
      openBtn.onclick = () => this.equipmentDetail(store, host, hostEq.id, () => this.vmDetail(store, host, id, onChanged));
      openWrap.appendChild(openBtn); root.appendChild(openWrap);
    } else {
      root.appendChild(this.grid([["Nœud (source)", vm.host_node ? `${Html.escape(vm.host_node)} <span class="pill" style="border-color:var(--warn);color:var(--warn)">non rapproché</span>` : this.MUTED]]));
    }

    // -- ENRICHISSEMENTS LOCAUX (édités séparément, jamais écrasés par la synchro) --
    this.sect(root, "Enrichissements locaux");
    const primaryGrp: any = vm.group_id ? store.get("groups", vm.group_id) : null;
    const secondaryGrps: any[] = (Array.isArray(vm.group_ids) ? vm.group_ids : []).filter((gid: string) => gid !== (vm.group_id || null)).map((gid: string) => store.get("groups", gid)).filter(Boolean);
    const grpPills = [
      primaryGrp ? `<span class="pill colored-pill" ${Color.pillStyle(primaryGrp.color)} title="Groupe primaire">${Html.escape(primaryGrp.label)}</span>` : null,
      ...secondaryGrps.map((g: any) => `<span class="pill colored-pill" ${Color.pillStyle(g.color)} title="Groupe secondaire">${Html.escape(g.label)}</span>`),
    ].filter(Boolean);
    root.appendChild(this.grid([
      [grpPills.length > 1 ? "Groupes" : "Groupe", grpPills.length ? grpPills.join(" ") : this.MUTED],
      // Description LOCALE retirée du modèle d'édition (les notes suffisent) → plus affichée ; la description
      // remontée par le provider (description_src, en markdown) reste dans l'identité source ci-dessus.
      ["Notes", vm.notes ? Html.escape(vm.notes) : this.MUTED],
      ["Créé", Html.escape(Format.dateTime(vm.created_date))],
      ["Modifié", Html.escape(Format.dateTime(vm.updated_date))],
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
      delBtn.textContent = "Supprimer cette VM orpheline…";
      delBtn.onclick = async () => {
        const ok = await Dialog.confirm({
          title: "Supprimer cette VM orpheline ?",
          message: `Supprimer définitivement « ${vm.name || "cette VM"} » de l'inventaire ? Les adresses IP qui lui sont rattachées seront DÉTACHÉES (conservées dans l'IPAM), pas supprimées.`,
          confirmLabel: "Supprimer", danger: true,
        });
        if (!ok) return;
        // MÊME chemin que la suppression depuis une liste (main.ts → store.remove) : la cascade PARTAGÉE
        // (shared/Cascade) détache les ipAddresses.vm_id, et le pipeline REST/fichier existant s'applique.
        await store.remove("vms", id);
        host.closeModal?.();   // la VM n'existe plus → refermer la fiche
        onChanged?.();          // rafraîchit la liste/vue d'origine (équivalent du reRender d'une suppression de liste)
        Notify.toast("VM supprimée");
      };
      actions.appendChild(delBtn);
    }
    if (!this.isViewer()) {
      const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "btn btn-primary";
      editBtn.textContent = "Modifier"; editBtn.onclick = () => VmForms.edit(store, host, id, onChanged);
      actions.appendChild(editBtn);
    }
    root.appendChild(actions);
    host.openModal({ title: "Détail de la VM", subtitle: Html.escape(vm.name || ""), body: root, hideFooter: true, wide: true });
  }

  /* ---- TYPE DE CÂBLE (catalogue, lecture seule) ---- */
  static cableTypeDetail(store: Store, host: FormHost, id: string): void {
    const t: any = store.get("cableTypes", id);
    if (!t) { Notify.toast("Type introuvable", "err"); return; }
    const root = document.createElement("div");
    const used = store.cablesOfType(id).length;
    root.appendChild(this.grid([
      ["Nom", Html.escape(t.name || "(type)")],
      ["Famille", t.family ? Html.escape(t.family) : this.MUTED],
      ["Média", t.medium ? Html.escape(t.medium) : this.MUTED],
      ["Nature", `<span class="pill">${t.kind === "power" ? "Power" : "Data"}</span>`],
      ["Câbles de ce type", used ? `<span class="pill">${used}</span>` : this.MUTED],
    ]));
    host.openModal({ title: "Détail du type de câble", subtitle: Html.escape(t.name || ""), body: root, hideFooter: true });
  }

  /* ---- TYPE DE PORT (catalogue, lecture seule) ---- */
  static portTypeDetail(store: Store, host: FormHost, id: string): void {
    const t: any = store.get("portTypes", id);
    if (!t) { Notify.toast("Type introuvable", "err"); return; }
    const root = document.createElement("div");
    const used = store.portsOfType(id).length;
    root.appendChild(this.grid([
      ["Nom", Html.escape(t.name || "(type)")],
      ["Famille", t.family ? Html.escape(t.family) : this.MUTED],
      ["Connecteur", t.connector ? Html.escape(t.connector) : this.MUTED],
      ["Débit", t.speed ? Html.escape(t.speed) : this.MUTED],
      ["Duplex", t.duplex ? "Oui" : "Non"],
      ["Nature", `<span class="pill">${t.kind === "power" ? "Power" : "Data"}</span>`],
      ["Ports de ce type", used ? `<span class="pill">${used}</span>` : this.MUTED],
    ]));
    host.openModal({ title: "Détail du type de port", subtitle: Html.escape(t.name || ""), body: root, hideFooter: true });
  }
}
