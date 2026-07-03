import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { Ip } from "../../core/Ip";
import { FormUi } from "./shared";
import type { FormHost } from "./shared";
import { RackForms } from "./RackForms";
import { LiveValidation } from "./LiveValidation";

export class IpamForms extends RackForms {

  static ipNetwork(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("ipNetworks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", "ex. LAN Prod, DMZ…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    const cidrI = FormControls.text(net ? net.cidr : "", "ex. 10.0.0.0/24");
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => {
      const c = Ip.parseCidr(cidrI.value);
      if (!cidrI.value.trim()) { hint.textContent = "Sous-réseau IPv4 « adresse/préfixe »."; hint.style.color = ""; return; }
      if (!c) { hint.textContent = "⚠ CIDR IPv4 invalide."; hint.style.color = "var(--err)"; return; }
      hint.style.color = "";
      hint.innerHTML = `Réseau <strong>${c.networkStr}</strong> · diffusion <strong>${c.broadcastStr}</strong> · ${c.hostCount} hôte(s)`;
    };
    cidrI.addEventListener("input", refresh); refresh();
    root.appendChild(FormControls.fieldRow("CIDR", cidrI)); root.appendChild(hint);
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    const live = new LiveValidation("ipNetworks", { label: labelI, cidr: cidrI });
    live.clearOnInput();

    host.openModal({
      title: net ? "Modifier le réseau IP" : "Nouveau réseau IP",
      subtitle: net ? Html.escape(Ip.short(net)) : "",
      body: root,
      onSave: async () => {
        const c = Ip.parseCidr(cidrI.value);
        if (live.check({ label: labelI.value.trim(), cidr: cidrI.value.trim() }).length || !c) return false;   // CIDR/label surlignés
        const cidr = c.networkStr + "/" + c.prefix;
        if (net) {
          const bad = store.ipAddressesOfNetwork(net.id).find((a: any) => !Ip.inCidr(Ip.toInt(a.address), c));
          if (bad) { Notify.toast(`L'adresse ${bad.address} ne serait plus dans ${cidr}.`, "err"); return false; }
          const badR = store.dhcpRangesOfNetwork(net.id).find((r: any) => !Ip.inCidr(Ip.toInt(r.start_ip), c) || !Ip.inCidr(Ip.toInt(r.end_ip), c));
          if (badR) { Notify.toast(`La plage DHCP ${badR.start_ip}→${badR.end_ip} ne serait plus dans ${cidr}.`, "err"); return false; }
        }
        const payload = { label: labelI.value.trim(), cidr, description: descI.value.trim() };
        if (net) await store.update("ipNetworks", net.id, payload); else await store.create("ipNetworks", payload);
        host.setDirty?.(true); Notify.toast(net ? "Réseau IP mis à jour" : "Réseau IP créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Adresse IP statique. */
  static ipAddress(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const addr: any = id ? store.get("ipAddresses", id) : null;
    if (!addr && !store.all("ipNetworks").length) { Notify.toast("Créez d'abord un réseau IP.", "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(FormUi.ipNetOptions(store), addr ? addr.network_id : "");
    root.appendChild(FormControls.fieldRow("Réseau IP", netSel));
    const ipWrap = document.createElement("div"); ipWrap.style.display = "flex"; ipWrap.style.gap = "8px";
    const ipI = FormControls.text(addr ? addr.address : "", "ex. 10.0.0.10"); ipI.style.flex = "1"; ipI.style.fontFamily = "var(--mono)";
    const freeBtn = document.createElement("button"); freeBtn.type = "button"; freeBtn.className = "btn btn-ghost btn-sm"; freeBtn.textContent = "Proposer libre";
    freeBtn.onclick = () => { const f = Ip.nextFree(store, netSel.value); if (f) ipI.value = f; else Notify.toast("Aucune adresse libre.", "err"); };
    ipWrap.appendChild(ipI); ipWrap.appendChild(freeBtn);
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? `Plage assignable : <strong>${Ip.toStr(c.firstHost)}</strong> → <strong>${Ip.toStr(c.lastHost)}</strong>` : "Choisissez un réseau au CIDR valide."; };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow("Adresse IP", ipWrap)); root.appendChild(hint);
    const hostI = FormControls.text(addr ? addr.hostname : "", "ex. srv-web-01.lan"); hostI.style.fontFamily = "var(--mono)";
    root.appendChild(FormControls.fieldRow("Hostname", hostI, "Facultatif."));
    const eqSel = FormControls.select(FormUi.eqOptions(store, "— aucun —"), addr ? (addr.equipment_id || "") : "");
    root.appendChild(FormControls.fieldRow("Équipement", eqSel, "Facultatif."));
    const descI = FormControls.textArea(addr ? addr.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    // validation live : adresse (format) + IP ∈ CIDR du réseau (cross-entité) + adresse UNIQUE (portée V6).
    const live = new LiveValidation("ipAddresses", { address: ipI, network_id: netSel, equipment_id: eqSel },
      (coll, i) => store.get(coll, i) || null, (coll, f, v) => store.findByField(coll, f, v));
    live.clearOnInput();

    host.openModal({
      title: addr ? "Modifier l'adresse IP" : "Nouvelle adresse IP",
      subtitle: addr ? Html.escape(addr.address) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        const address = ipI.value.trim();
        // `id` inclus → la validation de PORTÉE exclut l'adresse en cours d'édition (« sauf moi-même »).
        const payload = { id: addr ? addr.id : undefined, network_id: networkId, address, hostname: hostI.value.trim(), equipment_id: eqSel.value || null, description: descI.value.trim() };
        // surlignés par la validation live : format + IP ∈ CIDR + unicité (V6a) + pas dans une plage DHCP (V6b).
        if (live.check(payload).length) return false;
        if (addr) await store.update("ipAddresses", addr.id, payload); else await store.create("ipAddresses", payload);
        host.setDirty?.(true); Notify.toast(addr ? "Adresse mise à jour" : "Adresse attribuée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!addr) netSel.focus(); else ipI.focus(); }, 30);
  }

  /** Plage DHCP réservée. */
  static dhcpRange(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const rng: any = id ? store.get("dhcpRanges", id) : null;
    if (!rng && !store.all("ipNetworks").length) { Notify.toast("Créez d'abord un réseau IP.", "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(FormUi.ipNetOptions(store), rng ? rng.network_id : "");
    root.appendChild(FormControls.fieldRow("Réseau IP", netSel));
    const startI = FormControls.text(rng ? rng.start_ip : "", "ex. 10.0.0.100"); startI.style.fontFamily = "var(--mono)";
    const endI = FormControls.text(rng ? rng.end_ip : "", "ex. 10.0.0.200"); endI.style.fontFamily = "var(--mono)";
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? `Bornes dans : <strong>${c.networkStr}</strong> → <strong>${c.broadcastStr}</strong>` : "Choisissez un réseau au CIDR valide."; };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow("Début de plage", startI));
    root.appendChild(FormControls.fieldRow("Fin de plage", endI)); root.appendChild(hint);
    const srvSel = FormControls.select(FormUi.eqOptions(store, "— non désigné —"), rng ? (rng.server_id || "") : "");
    root.appendChild(FormControls.fieldRow("Serveur DHCP", srvSel, "Facultatif."));
    const descI = FormControls.textArea(rng ? rng.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    // validation live : format, fin ≥ début, bornes ∈ CIDR (cross-entité), chevauchement + IP statique (portée V6b).
    const live = new LiveValidation("dhcpRanges", { start_ip: startI, end_ip: endI, network_id: netSel, server_id: srvSel },
      (coll, i) => store.get(coll, i) || null, (coll, f, v) => store.findByField(coll, f, v));
    live.clearOnInput();

    host.openModal({
      title: rng ? "Modifier la plage DHCP" : "Nouvelle plage DHCP",
      subtitle: rng ? Html.escape(rng.start_ip + " → " + rng.end_ip) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        // « sauf moi-même » : on passe l'id à la validation de portée pour exclure la plage en cours d'édition.
        const record = { id: rng ? rng.id : undefined, network_id: networkId, start_ip: startI.value.trim(), end_ip: endI.value.trim(), server_id: srvSel.value || null };
        // surlignés : format, fin≥début, bornes ∈ CIDR, chevauchement de plage, IP statique dans la plage (V6b).
        if (live.check(record).length) return false;
        const s = Ip.toInt(record.start_ip)!, e = Ip.toInt(record.end_ip)!;   // valides après la validation live
        const payload = { network_id: networkId, start_ip: Ip.toStr(s), end_ip: Ip.toStr(e), server_id: srvSel.value || null, description: descI.value.trim() };
        if (rng) await store.update("dhcpRanges", rng.id, payload); else await store.create("dhcpRanges", payload);
        host.setDirty?.(true); Notify.toast(rng ? "Plage DHCP mise à jour" : "Plage DHCP réservée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!rng) netSel.focus(); else startI.focus(); }, 30);
  }

  /* =============================================================================
     Assignation d'un EMPLACEMENT LIBRE (clic 3D sur un slot d'une baie). Réplique OO des
     fonctions assignSlot/assignSideSlot/assignWallSlot/assignCapSlot du monolithe.
     ============================================================================= */
}
