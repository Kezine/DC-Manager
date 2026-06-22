import type { Store } from "../store";
import type { ModalOptions } from "../ui/Modal";
import { FormControls } from "../ui/FormControls";
import { ColorPalette } from "../ui/ColorPalette";
import { Notify } from "../ui/Notify";
import { Html } from "../core/Html";
import { Ip } from "../core/Ip";
import { GroupTypes } from "../domain/GroupTypes";
import { POWER_SOURCES } from "../domain/constants";

const ipNetOptions = (store: Store) => store.all("ipNetworks").slice()
  .sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || ""))
  .map((n: any) => ({ value: n.id, label: Ip.short(n) }));
const eqOptions = (store: Store, none: string) => [{ value: "", label: none }].concat(
  store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })));

/** Services applicatifs des formulaires (câblés par le shell). */
export interface FormHost {
  openModal(opts: ModalOptions): void;
  setDirty?(v: boolean): void;
}

/* =============================================================================
   Formulaires d'édition (création + modification) montés dans la modale partagée.
   Réplique OO des fonctions open*Form du monolithe. `onSaved` rafraîchit l'appelant.
   ============================================================================= */
export class Forms {
  /** Réseau logique (data/power). */
  static network(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("networks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", "ex. VLAN-Prod, Stockage…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    let color: string | null = net ? net.color : null;
    root.appendChild(FormControls.fieldRow("Couleur", ColorPalette.build(color, (c) => { color = c; }), "Colore les liens dans la topologie."));
    const kindSel = FormControls.select([{ value: "data", label: "Data" }, { value: "power", label: "Power (alimentation)" }], net ? (net.kind === "power" ? "power" : "data") : "data");
    root.appendChild(FormControls.fieldRow("Type", kindSel, "Data = réseau logique (VLAN…) · Power = circuit d'alimentation."));

    const voltI = FormControls.number((net && net.voltage != null) ? net.voltage : "", { min: 0, step: 1, placeholder: "ex. 230" });
    const ampI = FormControls.number((net && net.max_amp != null) ? net.max_amp : "", { min: 0, step: 1, placeholder: "ex. 16" });
    const srcSel = FormControls.select([{ value: "", label: "— non précisé —" }].concat(POWER_SOURCES.map((s) => ({ value: s.id, label: s.label }))), net ? (net.power_source || "") : "");
    const powerBox = document.createElement("div");
    const rowP = document.createElement("div"); rowP.className = "form-row";
    rowP.appendChild(FormControls.fieldRow("Tension (V)", voltI)); rowP.appendChild(FormControls.fieldRow("Capacité max (A)", ampI));
    powerBox.appendChild(rowP);
    powerBox.appendChild(FormControls.fieldRow("Alimentation", srcSel, "UPS, UPS + groupe, ou réseau seul."));
    root.appendChild(powerBox);

    const ipOpts = [{ value: "", label: "— aucun (réseau purement logique) —" }].concat(
      store.all("ipNetworks").slice().sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || "")).map((n: any) => ({ value: n.id, label: n.label || n.cidr || "(réseau IP)" })));
    const ipSel = FormControls.select(ipOpts, net ? (net.ip_network_id || "") : "");
    const ipField = FormControls.fieldRow("Réseau IP (réel)", ipSel, "Associe ce réseau logique à un sous-réseau de l'IPAM.");
    root.appendChild(ipField);

    const syncKind = () => { const power = kindSel.value === "power"; powerBox.style.display = power ? "" : "none"; ipField.style.display = power ? "none" : ""; };
    kindSel.addEventListener("change", syncKind); syncKind();
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: net ? "Modifier le réseau" : "Nouveau réseau",
      subtitle: net ? Html.escape(net.label) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        const power = kindSel.value === "power";
        const payload = {
          label, color: color || null, kind: power ? "power" : "data",
          ip_network_id: power ? null : (ipSel.value || null),
          voltage: power && voltI.value !== "" ? Math.max(0, parseInt(voltI.value, 10) || 0) : null,
          max_amp: power && ampI.value !== "" ? Math.max(0, parseInt(ampI.value, 10) || 0) : null,
          power_source: power ? (srcSel.value || null) : null,
          description: descI.value.trim(),
        };
        if (net) await store.update("networks", net.id, payload); else await store.create("networks", payload);
        host.setDirty?.(true); Notify.toast(net ? "Réseau mis à jour" : "Réseau créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Groupe d'équipements (stack/system/general). */
  static group(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const grp: any = id ? store.get("groups", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(grp ? grp.label : "", "ex. Cœur de réseau, Salle A…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    const typeI = FormControls.select(GroupTypes.ALL.map((t) => ({ value: t.id, label: t.label })), grp ? (grp.type || GroupTypes.DEFAULT) : GroupTypes.DEFAULT);
    root.appendChild(FormControls.fieldRow("Type", typeI, "Stack · System (ex. SAN) · General."));
    let color: string | null = grp ? grp.color : null;
    root.appendChild(FormControls.fieldRow("Couleur", ColorPalette.build(color, (c) => { color = c; }), "Identifie le groupe dans les listes et la topologie."));
    const descI = FormControls.textArea(grp ? grp.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: grp ? "Modifier le groupe" : "Nouveau groupe",
      subtitle: grp ? Html.escape(grp.label) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        const payload = { label, type: typeI.value || GroupTypes.DEFAULT, color: color || null, description: descI.value.trim() };
        if (grp) await store.update("groups", grp.id, payload); else await store.create("groups", payload);
        host.setDirty?.(true); Notify.toast(grp ? "Groupe mis à jour" : "Groupe créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Réseau IP (sous-réseau CIDR). */
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

    host.openModal({
      title: net ? "Modifier le réseau IP" : "Nouveau réseau IP",
      subtitle: net ? Html.escape(Ip.short(net)) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        const c = Ip.parseCidr(cidrI.value);
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        if (!c) { Notify.toast("CIDR IPv4 invalide (ex. 10.0.0.0/24)", "err"); return false; }
        const cidr = c.networkStr + "/" + c.prefix;
        if (net) {
          const bad = store.ipAddressesOfNetwork(net.id).find((a: any) => !Ip.inCidr(Ip.toInt(a.address), c));
          if (bad) { Notify.toast(`L'adresse ${bad.address} ne serait plus dans ${cidr}.`, "err"); return false; }
          const badR = store.dhcpRangesOfNetwork(net.id).find((r: any) => !Ip.inCidr(Ip.toInt(r.start_ip), c) || !Ip.inCidr(Ip.toInt(r.end_ip), c));
          if (badR) { Notify.toast(`La plage DHCP ${badR.start_ip}→${badR.end_ip} ne serait plus dans ${cidr}.`, "err"); return false; }
        }
        const payload = { label, cidr, description: descI.value.trim() };
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
    const netSel = FormControls.select(ipNetOptions(store), addr ? addr.network_id : "");
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
    const eqSel = FormControls.select(eqOptions(store, "— aucun —"), addr ? (addr.equipment_id || "") : "");
    root.appendChild(FormControls.fieldRow("Équipement", eqSel, "Facultatif."));
    const descI = FormControls.textArea(addr ? addr.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: addr ? "Modifier l'adresse IP" : "Nouvelle adresse IP",
      subtitle: addr ? Html.escape(addr.address) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId); const c = Ip.cidrOf(net);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        if (!c) { Notify.toast("Le réseau choisi a un CIDR invalide.", "err"); return false; }
        const address = ipI.value.trim();
        const ipInt = Ip.toInt(address);
        if (ipInt == null) { Notify.toast("Adresse IPv4 invalide.", "err"); return false; }
        if (!Ip.inCidr(ipInt, c)) { Notify.toast(`${address} n'appartient pas à ${net.cidr}.`, "err"); return false; }
        const dup = store.ipAddressByValue(address);
        if (dup && (!addr || dup.id !== addr.id)) { Notify.toast(`L'adresse ${address} est déjà attribuée.`, "err"); return false; }
        const conflict = Ip.dhcpRangeContaining(store, networkId, ipInt);
        if (conflict) { Notify.toast(`${address} est dans la plage DHCP ${conflict.start_ip}→${conflict.end_ip}.`, "err"); return false; }
        const payload = { network_id: networkId, address, hostname: hostI.value.trim(), equipment_id: eqSel.value || null, description: descI.value.trim() };
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
    const netSel = FormControls.select(ipNetOptions(store), rng ? rng.network_id : "");
    root.appendChild(FormControls.fieldRow("Réseau IP", netSel));
    const startI = FormControls.text(rng ? rng.start_ip : "", "ex. 10.0.0.100"); startI.style.fontFamily = "var(--mono)";
    const endI = FormControls.text(rng ? rng.end_ip : "", "ex. 10.0.0.200"); endI.style.fontFamily = "var(--mono)";
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? `Bornes dans : <strong>${c.networkStr}</strong> → <strong>${c.broadcastStr}</strong>` : "Choisissez un réseau au CIDR valide."; };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow("Début de plage", startI));
    root.appendChild(FormControls.fieldRow("Fin de plage", endI)); root.appendChild(hint);
    const srvSel = FormControls.select(eqOptions(store, "— non désigné —"), rng ? (rng.server_id || "") : "");
    root.appendChild(FormControls.fieldRow("Serveur DHCP", srvSel, "Facultatif."));
    const descI = FormControls.textArea(rng ? rng.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: rng ? "Modifier la plage DHCP" : "Nouvelle plage DHCP",
      subtitle: rng ? Html.escape(rng.start_ip + " → " + rng.end_ip) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId); const c = Ip.cidrOf(net);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        if (!c) { Notify.toast("Le réseau choisi a un CIDR invalide.", "err"); return false; }
        const s = Ip.toInt(startI.value.trim()), e = Ip.toInt(endI.value.trim());
        if (s == null) { Notify.toast("Adresse de début invalide.", "err"); return false; }
        if (e == null) { Notify.toast("Adresse de fin invalide.", "err"); return false; }
        if (e < s) { Notify.toast("La fin de plage doit être ≥ au début.", "err"); return false; }
        if (!Ip.inCidr(s, c) || !Ip.inCidr(e, c)) { Notify.toast(`Les bornes doivent appartenir à ${net.cidr}.`, "err"); return false; }
        const overlap = store.dhcpRangesOfNetwork(networkId).find((r: any) => {
          if (rng && r.id === rng.id) return false;
          const rs = Ip.toInt(r.start_ip), re = Ip.toInt(r.end_ip);
          return rs != null && re != null && s <= re && rs <= e;
        });
        if (overlap) { Notify.toast(`Chevauche la plage ${overlap.start_ip}→${overlap.end_ip}.`, "err"); return false; }
        const staticHit = store.ipAddressesOfNetwork(networkId).find((a: any) => { const n = Ip.toInt(a.address); return n != null && n >= s && n <= e; });
        if (staticHit) { Notify.toast(`L'IP statique ${staticHit.address} est dans cette plage.`, "err"); return false; }
        const payload = { network_id: networkId, start_ip: Ip.toStr(s), end_ip: Ip.toStr(e), server_id: srvSel.value || null, description: descI.value.trim() };
        if (rng) await store.update("dhcpRanges", rng.id, payload); else await store.create("dhcpRanges", payload);
        host.setDirty?.(true); Notify.toast(rng ? "Plage DHCP mise à jour" : "Plage DHCP réservée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!rng) netSel.focus(); else startI.focus(); }, 30);
  }
}
