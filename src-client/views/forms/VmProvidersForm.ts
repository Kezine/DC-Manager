import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { VmSyncError } from "./VmSyncClient";
import type { VmSyncClient, VmProviderSummary, VmProviderInfo, VmProviderInput } from "./VmSyncClient";
import type { FormHost } from "./shared";

/* =============================================================================
   MODALE DE GESTION DES PROVIDERS VM — feature AMOVIBLE (mode API, non-viewer).

   Classe DÉDIÉE et AUTONOME (hors chaîne d'héritage `Forms`, à CÔTÉ de VmForms) :
   la retirer = supprimer ce fichier + l'action « Providers… » de l'en-tête du
   sous-onglet Clusters (main.ts), sans cicatrice ailleurs. N'a besoin QUE de
   `FormHost.openModal` (modale partagée) et du `VmSyncClient` (routes CRUD/test) —
   aucun accès au store : ce que la vue Clusters doit rafraîchir après une écriture
   passe par le callback `onChanged` (le pattern `onDone` du « Synchroniser »).

   Ergonomie : UNE seule modale (instance partagée), à pied de page MASQUÉ
   (`hideFooter`) — les actions sont PROPRES à chaque écran (enregistrer/tester/
   supprimer un provider ne se réduit pas à un unique « Enregistrer » de modale).
   Le corps bascule entre DEUX écrans re-rendus en place dans `panel` :
   - LISTE : un provider par ligne (id, kind, nb d'endpoints, intervalle, timeout)
     + « Ajouter » ;
   - FORMULAIRE (création/édition) : id (immuable en édition), ÉDITEUR DE POOL
     (url + empreinte PAR nœud, ordonné = priorité de bascule, monter/descendre/
     supprimer), CA du cluster (PEM) optionnelle (niveau 2 de la hiérarchie de
     confiance — l'empreinte par nœud prime), jeton en champ password (« inchangé
     si vide » en édition, requis en création), include_lxc, interval_sec,
     timeout_sec ; « Tester la connexion », « Enregistrer », « Supprimer ».

   INVARIANTS DE SÉCURITÉ : le champ jeton n'est JAMAIS pré-rempli (l'API ne relit
   pas un jeton) ; il ne part EN CLAIR qu'à l'envoi et seulement s'il est (re)saisi.
   Clé de chiffrement absente / config invalide (503) → BANDEAU explicite au lieu
   des contrôles d'édition (on reprend le `detail` du serveur, actionnable).
   ============================================================================= */

/** État d'édition d'UNE ligne du pool : chaînes brutes des `<input>` (l'empreinte vide devient
    `null` à l'envoi, cf. `collectInput`). L'ORDRE du tableau = priorité de bascule des nœuds. */
interface PoolRow { url: string; fingerprint: string }

export class VmProvidersForm {
  /** Conteneur re-rendu en place (bascule liste ↔ formulaire). */
  private panel!: HTMLElement;

  private constructor(
    private readonly host: FormHost,
    private readonly client: VmSyncClient,
    /** Appelé après TOUTE écriture réussie (enregistrement / suppression) — la vue Clusters s'en
        sert pour se rafraîchir (son état vit en mémoire serveur, sans push SSE). */
    private readonly onChanged: () => void,
  ) {}

  /** Ouvre la modale de gestion (en-tête du sous-onglet Clusters, mode API + non-viewer). */
  static open(host: FormHost, client: VmSyncClient, onChanged: () => void): void {
    const form = new VmProvidersForm(host, client, onChanged);
    const root = document.createElement("div");
    form.panel = document.createElement("div");
    root.appendChild(form.panel);
    form.host.openModal({
      title: "Providers",
      subtitle: "Gestion des providers de synchronisation VM (Proxmox)",
      body: root, wide: true, hideFooter: true,
    });
    void form.loadList();
  }

  /* --------------------------------------------------------------------------
     ÉCRAN LISTE
     -------------------------------------------------------------------------- */

  /** Charge `GET /vm/providers` puis rend la liste. 503 (clé absente / config invalide) → bandeau. */
  private async loadList(): Promise<void> {
    this.message("Chargement des providers…");
    try {
      const providers = await this.client.providers();
      this.renderList(providers);
    } catch (e) {
      // 503 = gestion désactivée (clé de chiffrement absente) OU module en erreur : on montre le
      // détail actionnable du serveur AU LIEU des contrôles d'édition (rien à configurer sans clé).
      if (e instanceof VmSyncError && e.status === 503) { this.renderDisabled(e); return; }
      this.message("Chargement des providers impossible — " + VmProvidersForm.errText(e), true);
    }
  }

  /** Liste des providers (id, kind, nb d'endpoints, intervalle, timeout) + bouton « Ajouter ». */
  private renderList(providers: VmProviderSummary[]): void {
    this.panel.innerHTML = "";
    const intro = document.createElement("div"); intro.className = "form-hint";
    intro.textContent = "Providers de synchronisation configurés pour ce document. Les jetons d'API sont chiffrés côté serveur et ne sont jamais réaffichés.";
    this.panel.appendChild(intro);

    if (!providers.length) {
      const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic"; empty.style.marginTop = "8px";
      empty.textContent = "Aucun provider configuré pour ce document. Ajoutez-en un pour synchroniser l'inventaire d'un cluster.";
      this.panel.appendChild(empty);
    } else {
      const rows = providers.map((p) => [
        `<span style="font-family:var(--mono)">${Html.escape(p.id)}</span>`,
        Html.escape(p.kind),
        String(p.endpoints.length),
        p.interval_sec > 0 ? (p.interval_sec + " s") : "manuelle",
        p.timeout_sec + " s",
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(p.id)}">Modifier</button>`,
      ]);
      const tw = this.table(["Provider", "Type", "Nœuds", "Intervalle", "Timeout", ""], rows);
      // Liaison des boutons « Modifier » après injection du HTML (l'id est la clé, pas l'index).
      tw.querySelectorAll("[data-edit]").forEach((el) => {
        (el as HTMLElement).onclick = () => {
          const id = (el as HTMLElement).dataset.edit!;
          const provider = providers.find((p) => p.id === id);
          if (provider) this.renderForm(provider);
        };
      });
    }

    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary btn-sm";
    add.textContent = "+ Ajouter un provider"; add.style.marginTop = "12px";
    add.onclick = () => this.renderForm(null);
    this.panel.appendChild(add);
  }

  /* --------------------------------------------------------------------------
     ÉCRAN FORMULAIRE (création / édition)
     -------------------------------------------------------------------------- */

  /** Formulaire de création (`existing === null`) ou d'édition. `id` immuable en édition. */
  private renderForm(existing: VmProviderSummary | null): void {
    this.panel.innerHTML = "";
    const editing = existing !== null;

    // -- Fil d'Ariane : retour à la liste. --
    const back = document.createElement("button"); back.type = "button"; back.className = "btn btn-ghost btn-sm";
    back.textContent = "← Retour à la liste"; back.onclick = () => void this.loadList();
    this.panel.appendChild(back);

    const heading = document.createElement("div"); heading.className = "section-divider";
    heading.textContent = editing ? ("Modifier « " + existing!.id + " »") : "Nouveau provider";
    this.panel.appendChild(heading);

    // -- id (immuable en édition — c'est la clé de réconciliation des VMs). --
    const idInput = FormControls.text(existing ? existing.id : "", "ex. pve-prod");
    if (editing) { idInput.readOnly = true; idInput.style.opacity = "0.7"; }
    this.panel.appendChild(FormControls.fieldRow("Identifiant du provider", idInput,
      editing ? "Immuable — c'est la clé de réconciliation des VMs de ce provider." : "Unique par document (référencé par les VMs synchronisées)."));

    // -- kind : seul « proxmox » est supporté par la fabrique d'adaptateurs (VmSyncService.adapterFor). --
    const kindSel = FormControls.select([{ value: "proxmox", label: "Proxmox" }], existing ? existing.kind : "proxmox");
    this.panel.appendChild(FormControls.fieldRow("Type", kindSel, "Type d'adaptateur (seul Proxmox est supporté pour l'instant)."));

    // -- POOL D'ENDPOINTS : l'ORDRE = priorité de bascule (le 1er joignable sert). Empreinte PAR nœud. --
    const pool: PoolRow[] = existing && existing.endpoints.length
      ? existing.endpoints.map((e) => ({ url: e.url, fingerprint: e.fingerprint || "" }))
      : [{ url: "", fingerprint: "" }];
    const poolWrap = document.createElement("div"); poolWrap.style.marginTop = "4px";
    const renderPool = (): void => {
      poolWrap.innerHTML = "";
      pool.forEach((row, i) => {
        const line = document.createElement("div"); line.className = "form-row"; line.style.alignItems = "flex-end";

        const urlI = FormControls.text(row.url, "https://pve1.example.lan:8006");
        urlI.oninput = () => { row.url = urlI.value; };
        const fpI = FormControls.text(row.fingerprint, "empreinte SHA-256 (optionnelle)");
        fpI.oninput = () => { row.fingerprint = fpI.value; };

        // Réordonnancement (monter/descendre) + suppression — l'ordre pilote la bascule de nœud.
        const up = VmProvidersForm.iconBtn("↑", "Monter (priorité de bascule)", i === 0);
        up.onclick = () => { if (i > 0) { [pool[i - 1], pool[i]] = [pool[i], pool[i - 1]]; renderPool(); } };
        const down = VmProvidersForm.iconBtn("↓", "Descendre (priorité de bascule)", i === pool.length - 1);
        down.onclick = () => { if (i < pool.length - 1) { [pool[i + 1], pool[i]] = [pool[i], pool[i + 1]]; renderPool(); } };
        const del = VmProvidersForm.iconBtn("✕", "Supprimer ce nœud", pool.length <= 1);
        del.onclick = () => { if (pool.length > 1) { pool.splice(i, 1); renderPool(); } };
        const ctrls = document.createElement("div"); ctrls.className = "form-field"; ctrls.style.flex = "0 0 auto";
        const spacer = document.createElement("label"); spacer.innerHTML = "&nbsp;"; // aligne les boutons sur le bas des champs
        const btns = document.createElement("div"); btns.style.cssText = "display:flex;gap:4px"; btns.append(up, down, del);
        ctrls.append(spacer, btns);

        const urlField = FormControls.fieldRow("Nœud " + (i + 1) + " — URL", urlI); urlField.style.flex = "1 1 260px";
        const fpField = FormControls.fieldRow("Empreinte TLS", fpI); fpField.style.flex = "1 1 220px";
        line.append(urlField, fpField, ctrls);
        poolWrap.appendChild(line);
      });
    };
    renderPool();
    this.panel.appendChild(VmProvidersForm.sectionHint("Pool de nœuds", "Essayés dans l'ordre : le pool bascule sur le suivant quand un nœud est injoignable. L'empreinte est PAR nœud (chaque nœud Proxmox porte son propre certificat) ; vide = validation CA système."));
    this.panel.appendChild(poolWrap);
    const addNode = document.createElement("button"); addNode.type = "button"; addNode.className = "btn btn-ghost btn-sm";
    addNode.textContent = "+ Ajouter un nœud"; addNode.style.marginTop = "4px";
    addNode.onclick = () => { pool.push({ url: "", fingerprint: "" }); renderPool(); };
    this.panel.appendChild(addNode);

    // -- CA du cluster (PEM) : niveau 2 de la hiérarchie de confiance — la CA émet le certificat de
    //    CHAQUE nœud, donc UNE valeur pour tout le pool, qui survit aux régénérations de certificats.
    //    PUBLIC (pas un secret) : renvoyée en lecture, envoyée telle quelle (vide → null). L'empreinte
    //    PAR nœud (ci-dessus) reste prioritaire. --
    const caInput = FormControls.textArea(existing && existing.ca_pem ? existing.ca_pem : "");
    caInput.placeholder = "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----";
    caInput.rows = 4; caInput.style.fontFamily = "var(--mono)";
    this.panel.appendChild(FormControls.fieldRow("CA du cluster (PEM)", caInput,
      "Optionnel — collez pve-root-ca.pem (/etc/pve/pve-root-ca.pem, ou UI Proxmox) : une seule valeur pour tout le pool ; l'empreinte par nœud reste prioritaire. Vide = validation par les CA système."));

    // -- URL de management (Proxmox Datacenter Manager) : optionnelle, NON déductible de l'API (le PDM
    //    est un service distinct des nœuds) → saisie ici. Ouvre le bouton « Management » de la carte
    //    cluster (les liens PAR nœud, eux, sont générés par le serveur). Accepte http OU https. --
    const mgmtInput = FormControls.text(existing && existing.management_url ? existing.management_url : "", "https://pdm.exemple.com:8443");
    this.panel.appendChild(FormControls.fieldRow("URL de management (Proxmox Datacenter Manager)", mgmtInput,
      "Optionnel — non déductible de l'API. Ouvre le bouton « Management » de la carte cluster. Vide = pas de bouton."));

    // -- Jeton : champ password JAMAIS pré-rempli. En édition, vide = conserver le jeton stocké. --
    const tokenInput = FormControls.text("", editing ? "inchangé si vide" : "jeton d'API Proxmox (requis)");
    tokenInput.type = "password"; tokenInput.autocomplete = "new-password"; // empêche l'autofill du navigateur
    this.panel.appendChild(FormControls.fieldRow("Jeton d'API", tokenInput,
      editing ? "Laissez vide pour conserver le jeton actuel. Le jeton n'est jamais réaffiché."
        : "Jeton Proxmox « USER@REALM!TOKENID=UUID » (rôle lecture seule PVEAuditor suffisant)."));

    // -- include_lxc / interval_sec / timeout_sec. --
    const lxcToggle = FormControls.toggle("Inclure les conteneurs LXC", existing ? existing.include_lxc : true, () => { /* état lu à l'envoi */ });
    const lxcField = document.createElement("div"); lxcField.className = "form-field";
    const lxcLabel = document.createElement("label"); lxcLabel.textContent = "Conteneurs LXC"; lxcField.append(lxcLabel, lxcToggle);
    this.panel.appendChild(lxcField);

    const intervalInput = FormControls.number(existing ? existing.interval_sec : 0, { min: 0, step: 1, placeholder: "0" });
    this.panel.appendChild(FormControls.fieldRow("Intervalle de synchro (s)", intervalInput, "0 = synchronisation manuelle uniquement."));
    const timeoutInput = FormControls.number(existing ? existing.timeout_sec : 15, { min: 1, step: 1, placeholder: "15" });
    this.panel.appendChild(FormControls.fieldRow("Timeout d'une requête (s)", timeoutInput, "Délai maximal d'une requête HTTP ; borne aussi le coût d'une bascule de nœud."));

    // -- Zone de RÉSULTAT du test + zone d'ERREUR d'enregistrement (messages français du serveur). --
    const testBox = document.createElement("div"); testBox.style.marginTop = "10px";
    const errBox = document.createElement("div"); errBox.className = "form-hint err"; errBox.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    const showError = (e: unknown): void => {
      errBox.style.display = "block"; testBox.innerHTML = "";
      errBox.textContent = VmProvidersForm.errText(e);
    };

    // -- Barre d'actions : Tester / Enregistrer / (Supprimer si édition). --
    const collectInput = (): VmProviderInput => {
      const urls = pool.map((r) => ({ url: r.url.trim(), fingerprint: r.fingerprint.trim() || null }));
      const intervalStr = intervalInput.value.trim();
      const timeoutStr = timeoutInput.value.trim();
      const input: VmProviderInput = {
        id: (editing ? existing!.id : idInput.value.trim()),
        kind: kindSel.value,
        urls,
        include_lxc: (lxcToggle as any).checked,
        interval_sec: intervalStr === "" ? 0 : Number(intervalStr),
        timeout_sec: timeoutStr === "" ? 15 : Number(timeoutStr),
        // CA du cluster PUBLIQUE, envoyée telle quelle (vide → null) : elle n'a pas la réserve du jeton.
        ca_pem: caInput.value.trim() || null,
        // URL de management PUBLIQUE (PDM), envoyée telle quelle (vide → null).
        management_url: mgmtInput.value.trim() || null,
      };
      // Le jeton ne part QUE s'il est (re)saisi (écriture seule) — vide = conserver côté serveur.
      const token = tokenInput.value;
      if (token.trim() !== "") input.token = token;
      return input;
    };

    const actions = document.createElement("div"); actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:14px";

    const testBtn = document.createElement("button"); testBtn.type = "button"; testBtn.className = "btn btn-ghost";
    testBtn.textContent = "Tester la connexion";
    testBtn.onclick = async () => {
      errBox.style.display = "none";
      testBox.innerHTML = ""; testBox.appendChild(VmProvidersForm.hint("Test en cours…"));
      testBtn.disabled = true;
      try {
        const info = await this.client.testProvider(collectInput());
        this.renderTestResult(testBox, info);
      } catch (e) {
        showError(e);
      } finally {
        testBtn.disabled = false;
      }
    };

    const saveBtn = document.createElement("button"); saveBtn.type = "button"; saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "Enregistrer";
    saveBtn.onclick = async () => {
      errBox.style.display = "none";
      const input = collectInput();
      if (!editing && input.id === "") { showError(new VmSyncError("Identifiant du provider requis", 0, null)); return; }
      saveBtn.disabled = true;
      try {
        await this.client.saveProvider(input.id, input);
        Notify.toast(editing ? "Provider mis à jour" : "Provider créé", "ok");
        this.onChanged();          // la config a changé à chaud → rafraîchir la vue Clusters
        await this.loadList();     // retour à la liste, rechargée
      } catch (e) {
        // 400 = config invalide (issues → detail, messages français) affichée TELLE QUELLE.
        showError(e);
        saveBtn.disabled = false;
      }
    };

    actions.append(testBtn, saveBtn);

    if (editing) {
      const delBtn = document.createElement("button"); delBtn.type = "button"; delBtn.className = "btn btn-danger";
      delBtn.textContent = "Supprimer"; delBtn.style.marginLeft = "auto";
      delBtn.onclick = async () => {
        const ok = await Dialog.confirm({
          title: "Supprimer ce provider ?",
          message: "Supprimer le provider « " + existing!.id + " » ? Les VMs déjà synchronisées restent dans le document (elles deviendront orphelines).",
          confirmLabel: "Supprimer", danger: true,
        });
        if (!ok) return;
        delBtn.disabled = true;
        try {
          await this.client.deleteProvider(existing!.id);
          Notify.toast("Provider supprimé", "ok");
          this.onChanged();
          await this.loadList();
        } catch (e) {
          showError(e);
          delBtn.disabled = false;
        }
      };
      actions.append(delBtn);
    }

    this.panel.append(actions, testBox, errBox);
    setTimeout(() => { if (!editing) idInput.focus(); else (poolWrap.querySelector("input") as HTMLInputElement | undefined)?.focus(); }, 30);
  }

  /** Rend le résultat d'un test (ProviderInfo) : pastilles ok/gamme + version + message. */
  private renderTestResult(box: HTMLElement, info: VmProviderInfo): void {
    box.innerHTML = "";
    const pills = document.createElement("div"); pills.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
    pills.innerHTML = [
      VmProvidersForm.pill(info.ok ? "Connexion OK" : "Connexion en échec", info.ok ? "ok" : "err"),
      info.version ? VmProvidersForm.pill("PVE " + info.version, "neutral") : VmProvidersForm.pill("Version inconnue", "dim"),
      VmProvidersForm.pill(info.supported ? "Gamme supportée" : "Hors gamme", info.supported ? "ok" : "warn"),
    ].join(" ");
    box.appendChild(pills);
    if (info.message) {
      const msg = document.createElement("div"); msg.className = "form-hint"; msg.style.marginTop = "6px"; msg.textContent = info.message;
      box.appendChild(msg);
    }
  }

  /* --------------------------------------------------------------------------
     Bandeau « gestion désactivée » (clé absente / config invalide, 503)
     -------------------------------------------------------------------------- */

  /** 503 : la gestion est indisponible côté serveur → on montre le détail actionnable, pas les
      contrôles d'édition (clé de chiffrement `DCMANAGER_SECRETS_KEY` absente, ou config en erreur). */
  private renderDisabled(err: VmSyncError): void {
    this.panel.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--warn);border-radius:6px;padding:14px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--warn);margin-bottom:6px";
    title.textContent = err.message || "Gestion des providers indisponible";
    box.appendChild(title);
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line";
    detail.textContent = err.detail
      || "La gestion des providers par l'UI est désactivée côté serveur. Définissez la clé de chiffrement des secrets (DCMANAGER_SECRETS_KEY) dans l'environnement du serveur pour l'activer.";
    box.appendChild(detail);
    this.panel.appendChild(box);
  }

  /* --------------------------------------------------------------------------
     Primitives DOM (répliquées pour rester AUTONOME — mêmes classes CSS que les fiches)
     -------------------------------------------------------------------------- */

  /** Message pleine largeur (chargement / erreur) — remplace le contenu du panneau. */
  private message(text: string, isError = false): void {
    this.panel.innerHTML = "";
    const n = document.createElement("div"); n.className = isError ? "form-hint err" : "form-hint";
    n.textContent = text; this.panel.appendChild(n);
  }

  /** Table compacte (cellules = HTML déjà échappé par l'appelant). Renvoie le conteneur (liaison d'événements). */
  private table(headers: string[], rows: string[][]): HTMLElement {
    const tw = document.createElement("div"); tw.className = "table-wrap"; tw.style.marginTop = "10px";
    const head = headers.map((h) => `<th>${Html.escape(h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    tw.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    this.panel.appendChild(tw); return tw;
  }

  /** Petit bouton icône (monter/descendre/supprimer un nœud du pool). */
  private static iconBtn(glyph: string, title: string, disabled: boolean): HTMLButtonElement {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm";
    b.textContent = glyph; b.title = title; b.disabled = disabled;
    return b;
  }

  /** Note libre (form-hint). */
  private static hint(text: string): HTMLElement {
    const n = document.createElement("div"); n.className = "form-hint"; n.textContent = text; return n;
  }

  /** Intitulé de section + hint (pour l'éditeur de pool, hors `fieldRow` qui attend un contrôle). */
  private static sectionHint(label: string, hint: string): HTMLElement {
    const wrap = document.createElement("div"); wrap.className = "form-field";
    const l = document.createElement("label"); l.textContent = label;
    const h = document.createElement("div"); h.className = "form-hint"; h.textContent = hint;
    wrap.append(l, h); return wrap;
  }

  /** Pastille sémantique (mêmes couleurs que VmClustersView/VmForms). */
  private static pill(text: string, kind: "ok" | "err" | "warn" | "dim" | "neutral"): string {
    const style = kind === "ok" ? ` style="border-color:var(--ok);color:var(--ok)"`
      : kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : kind === "dim" ? ` style="border-color:var(--fg-dimmer);color:var(--fg-dim)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  /** Message d'erreur lisible : `VmSyncError` porte code HTTP + `detail` (issues 400 / config 503). */
  private static errText(e: unknown): string {
    if (e instanceof VmSyncError) return e.message + (e.detail ? "\n" + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
