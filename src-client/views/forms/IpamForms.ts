import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { Ip } from "../../core/Ip";
import { FormUi } from "./shared";
import type { FormHost } from "./shared";
import { RackForms } from "./RackForms";
import { LiveValidation } from "./LiveValidation";
import { I18n } from "../../i18n/I18n";

export class IpamForms extends RackForms {

  static ipNetwork(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("ipNetworks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", I18n.t("ipam.net.labelPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.net.label"), labelI));
    const cidrI = FormControls.text(net ? net.cidr : "", I18n.t("ipam.net.cidrPlaceholder"));
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => {
      const c = Ip.parseCidr(cidrI.value);
      if (!cidrI.value.trim()) { hint.textContent = I18n.t("ipam.net.cidrPrompt"); hint.style.color = ""; return; }
      if (!c) { hint.textContent = I18n.t("ipam.net.cidrInvalid"); hint.style.color = "var(--err)"; return; }
      hint.style.color = "";
      hint.innerHTML = I18n.t("ipam.net.cidrInfo", { count: c.hostCount, network: c.networkStr, broadcast: c.broadcastStr });
    };
    cidrI.addEventListener("input", refresh); refresh();
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.net.cidr"), cidrI)); root.appendChild(hint);
    // passerelle (∈ CIDR) + serveurs DNS (plusieurs, résolveurs externes admis) + serveur DHCP du réseau (FK équipement).
    const gwI = FormControls.text(net ? (net.gateway || "") : "", I18n.t("ipam.net.gwPlaceholder")); gwI.style.fontFamily = "var(--mono)";
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.net.gateway"), gwI, I18n.t("ipam.net.gatewayHint")));
    const dnsI = FormControls.text(net && Array.isArray(net.dns_servers) ? net.dns_servers.join(", ") : "", I18n.t("ipam.net.dnsPlaceholder")); dnsI.style.fontFamily = "var(--mono)";
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.net.dnsServers"), dnsI, I18n.t("ipam.net.dnsHint")));
    const dhcpSel = FormControls.select(FormUi.eqOptions(store, I18n.t("ipam.common.noneDesignated")), net ? (net.dhcp_server_id || "") : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.dhcpServer"), dhcpSel, I18n.t("ipam.net.dhcpHint")));
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.description"), descI));
    const live = new LiveValidation("ipNetworks", { label: labelI, cidr: cidrI, gateway: gwI, dns_servers: dnsI });
    live.clearOnInput();

    host.openModal({
      title: net ? I18n.t("ipam.net.titleEdit") : I18n.t("ipam.net.titleNew"),
      subtitle: net ? Html.escape(Ip.short(net)) : "",
      body: root,
      onSave: async () => {
        const c = Ip.parseCidr(cidrI.value);
        const gateway = gwI.value.trim() || null;
        const dns_servers = dnsI.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        const dhcp_server_id = dhcpSel.value || null;
        // surlignés par la validation live : label/CIDR (format) + passerelle (format + ∈ CIDR) + DNS (format par élément).
        if (live.check({ label: labelI.value.trim(), cidr: cidrI.value.trim(), gateway, dns_servers }).length || !c) return false;
        const cidr = c.networkStr + "/" + c.prefix;
        if (net) {
          const bad = store.ipAddressesOfNetwork(net.id).find((a: any) => !Ip.inCidr(Ip.toInt(a.address), c));
          if (bad) { Notify.toast(I18n.t("ipam.net.addrOutOfCidr", { addr: bad.address, cidr }), "err"); return false; }
          const badR = store.dhcpRangesOfNetwork(net.id).find((r: any) => !Ip.inCidr(Ip.toInt(r.start_ip), c) || !Ip.inCidr(Ip.toInt(r.end_ip), c));
          if (badR) { Notify.toast(I18n.t("ipam.net.rangeOutOfCidr", { start: badR.start_ip, end: badR.end_ip, cidr }), "err"); return false; }
        }
        const payload = { label: labelI.value.trim(), cidr, description: descI.value.trim(), gateway, dns_servers, dhcp_server_id };
        if (net) await store.update("ipNetworks", net.id, payload); else await store.create("ipNetworks", payload);
        host.setDirty?.(true); Notify.toast(net ? I18n.t("ipam.net.updated") : I18n.t("ipam.net.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Adresse IP statique. */
  static ipAddress(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const addr: any = id ? store.get("ipAddresses", id) : null;
    if (!addr && !store.all("ipNetworks").length) { Notify.toast(I18n.t("ipam.common.needIpNetwork"), "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(FormUi.ipNetOptions(store), addr ? addr.network_id : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.ipNetwork"), netSel));
    const ipWrap = document.createElement("div"); ipWrap.style.display = "flex"; ipWrap.style.gap = "8px";
    const ipI = FormControls.text(addr ? addr.address : "", I18n.t("ipam.addr.ipPlaceholder")); ipI.style.flex = "1"; ipI.style.fontFamily = "var(--mono)";
    const freeBtn = document.createElement("button"); freeBtn.type = "button"; freeBtn.className = "btn btn-ghost btn-sm"; freeBtn.textContent = I18n.t("ipam.addr.proposeFree");
    freeBtn.onclick = () => { const f = Ip.nextFree(store, netSel.value); if (f) ipI.value = f; else Notify.toast(I18n.t("ipam.addr.noFree"), "err"); };
    ipWrap.appendChild(ipI); ipWrap.appendChild(freeBtn);
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? I18n.t("ipam.addr.assignable", { first: Ip.toStr(c.firstHost), last: Ip.toStr(c.lastHost) }) : I18n.t("ipam.common.chooseCidrNet"); };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.addr.ipField"), ipWrap)); root.appendChild(hint);
    const hostI = FormControls.text(addr ? addr.hostname : "", I18n.t("ipam.addr.hostPlaceholder")); hostI.style.fontFamily = "var(--mono)";
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.addr.hostname"), hostI, I18n.t("ipam.common.optional")));
    const eqSel = FormControls.select(FormUi.eqOptions(store, I18n.t("ipam.addr.noneEquip")), addr ? (addr.equipment_id || "") : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.addr.equipment"), eqSel, I18n.t("ipam.addr.equipmentHint")));
    // Sélecteur VM (rattachement à une VM, parité équipement) — feature AMOVIBLE : affiché SEULEMENT s'il existe des
    // VMs (ou si l'adresse en cible déjà une), pour ne pas encombrer le formulaire en mode fichier / sans inventaire VM.
    const hasVms = store.all("vms").length > 0 || !!(addr && addr.vm_id);
    const vmSel = hasVms ? FormControls.select(FormUi.vmOptions(store, I18n.t("ipam.addr.noneVm")), addr ? (addr.vm_id || "") : "") : null;
    if (vmSel) root.appendChild(FormControls.fieldRow(I18n.t("ipam.addr.vm"), vmSel, I18n.t("ipam.addr.vmHint")));
    // EXCLUSIVITÉ VISIBLE (miroir de l'invariant de la spec) : choisir un équipement vide la VM, et inversement —
    // l'utilisateur VOIT le champ opposé se remettre à « aucun », plutôt que de se faire refuser les deux à l'enregistrement.
    if (vmSel) {
      eqSel.addEventListener("change", () => { if (eqSel.value) vmSel.value = ""; });
      vmSel.addEventListener("change", () => { if (vmSel.value) eqSel.value = ""; });
    }
    const descI = FormControls.textArea(addr ? addr.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.description"), descI));
    // validation live : adresse (format) + IP ∈ CIDR du réseau (cross-entité) + adresse UNIQUE (portée V6)
    // + exclusivité équipement/VM (invariant, surligné sur le champ VM quand il est présent).
    const liveFields: Record<string, HTMLElement> = { address: ipI, network_id: netSel, equipment_id: eqSel };
    if (vmSel) liveFields.vm_id = vmSel;
    const live = new LiveValidation("ipAddresses", liveFields,
      (coll, i) => store.get(coll, i) || null, (coll, f, v) => store.findByField(coll, f, v));
    live.clearOnInput();

    host.openModal({
      title: addr ? I18n.t("ipam.addr.titleEdit") : I18n.t("ipam.addr.titleNew"),
      subtitle: addr ? Html.escape(addr.address) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId);
        if (!net) { Notify.toast(I18n.t("ipam.common.pickIpNetwork"), "err"); return false; }
        const address = ipI.value.trim();
        // `id` inclus → la validation de PORTÉE exclut l'adresse en cours d'édition (« sauf moi-même »).
        // vm_id : valeur du sélecteur si présent, sinon on PRÉSERVE l'existant (le sélecteur peut être masqué faute de VMs).
        const vmId = vmSel ? (vmSel.value || null) : (addr ? (addr.vm_id || null) : null);
        const payload = { id: addr ? addr.id : undefined, network_id: networkId, address, hostname: hostI.value.trim(), equipment_id: eqSel.value || null, vm_id: vmId, description: descI.value.trim() };
        // surlignés par la validation live : format + IP ∈ CIDR + unicité (V6a) + pas dans une plage DHCP (V6b).
        if (live.check(payload).length) return false;
        if (addr) await store.update("ipAddresses", addr.id, payload); else await store.create("ipAddresses", payload);
        host.setDirty?.(true); Notify.toast(addr ? I18n.t("ipam.addr.updated") : I18n.t("ipam.addr.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!addr) netSel.focus(); else ipI.focus(); }, 30);
  }

  /** Plage DHCP réservée. */
  static dhcpRange(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const rng: any = id ? store.get("dhcpRanges", id) : null;
    if (!rng && !store.all("ipNetworks").length) { Notify.toast(I18n.t("ipam.common.needIpNetwork"), "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(FormUi.ipNetOptions(store), rng ? rng.network_id : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.ipNetwork"), netSel));
    const startI = FormControls.text(rng ? rng.start_ip : "", I18n.t("ipam.range.startPlaceholder")); startI.style.fontFamily = "var(--mono)";
    const endI = FormControls.text(rng ? rng.end_ip : "", I18n.t("ipam.range.endPlaceholder")); endI.style.fontFamily = "var(--mono)";
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? I18n.t("ipam.range.bounds", { network: c.networkStr, broadcast: c.broadcastStr }) : I18n.t("ipam.common.chooseCidrNet"); };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.range.startField"), startI));
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.range.endField"), endI)); root.appendChild(hint);
    const srvSel = FormControls.select(FormUi.eqOptions(store, I18n.t("ipam.common.noneDesignated")), rng ? (rng.server_id || "") : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.dhcpServer"), srvSel, I18n.t("ipam.common.optional")));
    const descI = FormControls.textArea(rng ? rng.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.description"), descI));
    // validation live : format, fin ≥ début, bornes ∈ CIDR (cross-entité), chevauchement + IP statique (portée V6b).
    const live = new LiveValidation("dhcpRanges", { start_ip: startI, end_ip: endI, network_id: netSel, server_id: srvSel },
      (coll, i) => store.get(coll, i) || null, (coll, f, v) => store.findByField(coll, f, v));
    live.clearOnInput();

    host.openModal({
      title: rng ? I18n.t("ipam.range.titleEdit") : I18n.t("ipam.range.titleNew"),
      subtitle: rng ? Html.escape(rng.start_ip + " → " + rng.end_ip) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId);
        if (!net) { Notify.toast(I18n.t("ipam.common.pickIpNetwork"), "err"); return false; }
        // « sauf moi-même » : on passe l'id à la validation de portée pour exclure la plage en cours d'édition.
        const record = { id: rng ? rng.id : undefined, network_id: networkId, start_ip: startI.value.trim(), end_ip: endI.value.trim(), server_id: srvSel.value || null };
        // surlignés : format, fin≥début, bornes ∈ CIDR, chevauchement de plage, IP statique dans la plage (V6b).
        if (live.check(record).length) return false;
        const s = Ip.toInt(record.start_ip)!, e = Ip.toInt(record.end_ip)!;   // valides après la validation live
        const payload = { network_id: networkId, start_ip: Ip.toStr(s), end_ip: Ip.toStr(e), server_id: srvSel.value || null, description: descI.value.trim() };
        if (rng) await store.update("dhcpRanges", rng.id, payload); else await store.create("dhcpRanges", payload);
        host.setDirty?.(true); Notify.toast(rng ? I18n.t("ipam.range.updated") : I18n.t("ipam.range.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!rng) netSel.focus(); else startI.focus(); }, 30);
  }

  /* =============================================================================
     Assignation d'un EMPLACEMENT LIBRE (clic 3D sur un slot d'une baie). Réplique OO des
     fonctions assignSlot/assignSideSlot/assignWallSlot/assignCapSlot du monolithe.
     ============================================================================= */
}
