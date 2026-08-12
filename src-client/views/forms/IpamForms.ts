import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { Ip } from "../../core/Ip";
import { FormUi } from "./shared";
import { FormSave } from "./FormSave";   // écriture + garde-fou « ne jamais annoncer un succès refusé »
import type { FormHost } from "./shared";
import { RackForms } from "./RackForms";
import { LiveValidation } from "./LiveValidation";
import { I18n } from "../../i18n/I18n";
import { TargetSearch } from "../../core/TargetSearch";   // convention composite « <kind>:<id> » du picker PORTEUR (équipement/VM) des adresses — MÊME encodage que le picker d'hôte des applications

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
    // Serveur DHCP = ENTITÉ (équipement, liste longue et croissante) → `entityPicker` (principe n°14).
    // La règle qui construit les options (`FormUi.eqOptions`, « non désigné » en tête) ne bouge PAS : on
    // remplace le contrôle, jamais la règle ; `.value` reste lu au save exactement comme un `<select>`.
    const dhcpSel = FormControls.entityPicker(FormUi.eqOptions(store, I18n.t("ipam.common.noneDesignated")), net ? (net.dhcp_server_id || "") : "");
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
        if (!await FormSave.record(store, "ipNetworks", net && net.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
        host.setDirty?.(true); Notify.toast(net ? I18n.t("ipam.net.updated") : I18n.t("ipam.net.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Adresse IP statique. Le RÉSEAU et le PORTEUR sont des ENTITÉS (principe n°14) → `entityPicker`.
      Le PORTEUR (équipement OU VM) est UN SEUL picker MULTI-FAMILLES calqué sur `Forms.application` :
      options équipements PUIS VMs, values re-préfixées à la convention composite « <kind>:<id> »
      (`TargetSearch.key`/`parse`) → l'exclusivité `equipment_id`/`vm_id` est garantie PAR CONSTRUCTION
      (un seul picker, une seule valeur) — plus DEUX `<select>` exclusifs à synchro croisée (dette du
      principe n°14 résorbée, cf. le commentaire de `Forms.application`). */
  static ipAddress(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const addr: any = id ? store.get("ipAddresses", id) : null;
    if (!addr && !store.all("ipNetworks").length) { Notify.toast(I18n.t("ipam.common.needIpNetwork"), "err"); return; }
    const root = document.createElement("div");
    // Réseau IP = ENTITÉ (liste longue/croissante) → `entityPicker` ; règle d'options (`FormUi.ipNetOptions`)
    // INCHANGÉE. `.value` et l'événement `change` restent ceux d'un `<select>` : le bouton « Proposer une IP
    // libre » lit `netSel.value` et le hint de plage assignable s'abonne à `change` sans rien changer.
    const netSel = FormControls.entityPicker(FormUi.ipNetOptions(store), addr ? addr.network_id : "");
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
    // PORTEUR de l'adresse — UN SEUL `entityPicker` MULTI-FAMILLES (équipement OU VM), calqué sur
    // `Forms.application`. Options : les MÊMES listes métier que partout (`FormUi.eqOptions`/`vmOptions`,
    // tri par nom), re-préfixées famille par famille — libellé « Équipement · SRV37 » / « VM · gitlab »
    // pour que deux homonymes de familles différentes restent discernables dans un picker UNIQUE. L'option
    // « aucun » de tête reste UNE seule (les deux vides = adresse non attribuée, état permis par la spec).
    // TRANSPOSITION du « le sélecteur VM n'apparaît que s'il y a des VMs » : sans VM (et sans `vm_id` déjà
    // posé), les options VM ne sont tout simplement PAS concaténées — le picker reste unique, seul
    // l'encombrement d'une famille vide disparaît (parité mode fichier / sans inventaire VM).
    const hasVms = store.all("vms").length > 0 || !!(addr && addr.vm_id);
    let carrierOptions = [{ value: "", label: I18n.t("forms.opt.none") }]
      .concat(FormUi.eqOptions(store, "").slice(1).map((o) => ({ value: TargetSearch.key("equipment", o.value), label: I18n.t("ipam.addr.familyEquipment") + " · " + o.label })));
    if (hasVms) carrierOptions = carrierOptions.concat(FormUi.vmOptions(store, "").slice(1).map((o) => ({ value: TargetSearch.key("vm", o.value), label: I18n.t("ipam.addr.familyVm") + " · " + o.label })));
    const initialCarrier = addr && addr.equipment_id ? TargetSearch.key("equipment", addr.equipment_id)
      : addr && addr.vm_id ? TargetSearch.key("vm", addr.vm_id) : "";
    const carrierI = FormControls.entityPicker(carrierOptions, initialCarrier);
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.addr.carrier"), carrierI, I18n.t("ipam.addr.carrierHint")));
    const descI = FormControls.textArea(addr ? addr.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.description"), descI));
    // validation live : adresse (format) + IP ∈ CIDR du réseau (cross-entité) + adresse UNIQUE (portée V6)
    // + exclusivité équipement/VM (invariant rattaché à `vm_id` par la spec). `equipment_id` ET `vm_id`
    // pointent tous deux sur le picker PORTEUR : le surlignage tombe au bon endroit quelle que soit la clé à
    // laquelle la spec rattache l'erreur (ici `vm_id`), et le câblage reste complet si elle évolue.
    const live = new LiveValidation("ipAddresses",
      { address: ipI, network_id: netSel, equipment_id: carrierI, vm_id: carrierI },
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
        // Décomposition de la valeur composite du picker PORTEUR vers les DEUX FK : l'une reçoit l'id, l'autre
        // est explicitement remise à null (changer de famille — ou vider le porteur — VIDE l'ancienne FK).
        // L'exclusivité equipment_id/vm_id est ainsi garantie PAR CONSTRUCTION (un seul picker, une valeur).
        // `id` inclus → la validation de PORTÉE exclut l'adresse en cours d'édition (« sauf moi-même »).
        const parsedCarrier = carrierI.value ? TargetSearch.parse(carrierI.value) : null;
        const payload = {
          id: addr ? addr.id : undefined, network_id: networkId, address, hostname: hostI.value.trim(),
          equipment_id: parsedCarrier && parsedCarrier.kind === "equipment" ? parsedCarrier.id : null,
          vm_id: parsedCarrier && parsedCarrier.kind === "vm" ? parsedCarrier.id : null,
          description: descI.value.trim(),
        };
        // surlignés par la validation live : format + IP ∈ CIDR + unicité (V6a) + pas dans une plage DHCP (V6b).
        if (live.check(payload).length) return false;
        if (!await FormSave.record(store, "ipAddresses", addr && addr.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
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
    // Réseau IP = ENTITÉ → `entityPicker` (règle d'options `FormUi.ipNetOptions` INCHANGÉE) ; le hint des
    // bornes s'abonne à `change` et le save lit `.value`, exactement comme l'ancien `<select>`.
    const netSel = FormControls.entityPicker(FormUi.ipNetOptions(store), rng ? rng.network_id : "");
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.common.ipNetwork"), netSel));
    const startI = FormControls.text(rng ? rng.start_ip : "", I18n.t("ipam.range.startPlaceholder")); startI.style.fontFamily = "var(--mono)";
    const endI = FormControls.text(rng ? rng.end_ip : "", I18n.t("ipam.range.endPlaceholder")); endI.style.fontFamily = "var(--mono)";
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? I18n.t("ipam.range.bounds", { network: c.networkStr, broadcast: c.broadcastStr }) : I18n.t("ipam.common.chooseCidrNet"); };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.range.startField"), startI));
    root.appendChild(FormControls.fieldRow(I18n.t("ipam.range.endField"), endI)); root.appendChild(hint);
    // Serveur DHCP = ENTITÉ (équipement) → `entityPicker` ; règle d'options (`FormUi.eqOptions`) INCHANGÉE.
    const srvSel = FormControls.entityPicker(FormUi.eqOptions(store, I18n.t("ipam.common.noneDesignated")), rng ? (rng.server_id || "") : "");
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
        if (!await FormSave.record(store, "dhcpRanges", rng && rng.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
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
