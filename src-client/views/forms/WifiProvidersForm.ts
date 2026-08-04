import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { WifiSyncError } from "./WifiSyncClient";
import type { WifiSyncClient, WifiProviderSummary, WifiProviderInfo, WifiProviderInput, WifiProviderOptions } from "./WifiSyncClient";
import type { FormHost } from "./shared";
import { I18n } from "../../i18n/I18n";

/* =============================================================================
   MODALE DE GESTION DES PROVIDERS WIFI — feature AMOVIBLE (mode API, non-viewer).

   Classe DÉDIÉE et AUTONOME (hors chaîne d'héritage `Forms`, à CÔTÉ de WifiForms) :
   la retirer = supprimer ce fichier + l'action « Providers… » de l'en-tête de
   l'onglet Wifi (main.ts), sans cicatrice ailleurs. N'a besoin QUE de
   `FormHost.openModal` (modale partagée) et du `WifiSyncClient` (routes CRUD/test) —
   aucun accès au store.

   Ergonomie (calquée sur `VmProvidersForm`) : UNE seule modale, pied de page MASQUÉ
   (`hideFooter`) — les actions sont PROPRES à chaque écran. Le corps bascule entre
   DEUX écrans re-rendus en place :
   - LISTE : un provider par ligne (id, type, URL, intervalle, timeout) + « Ajouter » ;
   - FORMULAIRE : id (immuable en édition), TYPE, URL de console, empreinte TLS, CA,
     jeton en champ password (« inchangé si vide »), intervalle, timeout, PLUS les
     champs PROPRES AU TYPE choisi ; « Tester la connexion », « Enregistrer », « Supprimer ».

   ── AGNOSTICISME DE MARQUE CÔTÉ UI (décision D9) ──────────────────────────────
   Les champs propres à une marque ne sont PAS écrits en dur dans le formulaire : ils
   sont DÉCLARÉS dans `KIND_FIELDS` (une entrée par `kind`) et rendus dynamiquement,
   en MIROIR de `WifiProviderConfigValidate.KIND_OPTION_SPECS` côté serveur. Ajouter
   une marque = ajouter une entrée ici (+ ses libellés i18n), rien d'autre dans ce
   fichier. C'est ce qui rend vraie la quatrième moitié du critère d'acceptation
   (« 1 option du <select> kind + sa branche de validation »).
   ⚠ Les deux tables doivent rester en phase : un champ affiché mais non déclaré côté
   serveur serait silencieusement ignoré (les options inconnues sont écartées), et un
   champ déclaré côté serveur mais non affiché resterait figé sur son défaut.

   INVARIANTS DE SÉCURITÉ : le champ jeton n'est JAMAIS pré-rempli (l'API ne relit pas
   un jeton) ; il ne part EN CLAIR qu'à l'envoi et seulement s'il est (re)saisi.
   Clé de chiffrement absente / config invalide (503) → BANDEAU explicite au lieu des
   contrôles d'édition (on reprend le `detail` du serveur, actionnable).
   ============================================================================= */

/** Déclaration d'UN champ d'option propre à une marque (miroir client de `WifiOptionSpec`). */
interface KindFieldSpec {
  /** Nom de l'option — DOIT correspondre au `name` déclaré côté serveur. */
  name: string;
  type: "text" | "toggle";
  /** Valeur posée quand le provider n'a pas encore cette option (création, ou marque changée). */
  fallback: string | boolean;
  /** Clés i18n du libellé et de l'aide — dans le domaine `wifi.providers.opt`. */
  labelKey: string;
  hintKey: string;
  /** Placeholder du champ texte (clé i18n), facultatif. */
  placeholderKey?: string;
}

export class WifiProvidersForm {
  /** TYPES de contrôleur proposés — miroir de la fabrique `WifiSyncService.adapterFor` et de
      `WifiProviderConfigValidate.KIND_OPTION_SPECS`. Un seul aujourd'hui, comme le « proxmox »
      des VMs : le `<select>` existe quand même, parce que c'est LUI qui rend l'ajout d'une
      marque non structurant (cf. en-tête). Le LIBELLÉ est une marque commerciale, donc écrit
      tel quel et NON traduit (comme « Proxmox » côté VM). */
  private static readonly KINDS: readonly { value: string; label: string }[] = [
    { value: "unifi", label: "UniFi" },
  ];

  /** Champs d'option PAR TYPE — le point d'extension « marque » côté UI (cf. en-tête). */
  private static readonly KIND_FIELDS: Readonly<Record<string, readonly KindFieldSpec[]>> = {
    unifi: [
      { name: "site", type: "text", fallback: "default", labelKey: "wifi.providers.opt.siteField", hintKey: "wifi.providers.opt.siteHint", placeholderKey: "wifi.providers.opt.sitePlaceholder" },
      { name: "include_wired", type: "toggle", fallback: false, labelKey: "wifi.providers.opt.wiredField", hintKey: "wifi.providers.opt.wiredHint" },
    ],
  };

  /** Conteneur re-rendu en place (bascule liste ↔ formulaire). */
  private panel!: HTMLElement;

  private constructor(
    private readonly host: FormHost,
    private readonly client: WifiSyncClient,
    /** Appelé après TOUTE écriture réussie (enregistrement / suppression) — l'appelant s'en sert
        pour rafraîchir ce qui doit l'être (la config vit côté serveur, sans push SSE). */
    private readonly onChanged: () => void,
  ) {}

  /** Ouvre la modale de gestion (en-tête de l'onglet Wifi, mode API + non-viewer). */
  static open(host: FormHost, client: WifiSyncClient, onChanged: () => void): void {
    const form = new WifiProvidersForm(host, client, onChanged);
    const root = document.createElement("div");
    form.panel = document.createElement("div");
    root.appendChild(form.panel);
    form.host.openModal({
      title: I18n.t("wifi.providers.title"),
      subtitle: I18n.t("wifi.providers.subtitle"),
      body: root, wide: true, hideFooter: true,
    });
    void form.loadList();
  }

  /* --------------------------------------------------------------------------
     ÉCRAN LISTE
     -------------------------------------------------------------------------- */

  /** Charge `GET /wifi/providers` puis rend la liste. 503 (clé absente / config invalide) → bandeau. */
  private async loadList(): Promise<void> {
    this.message(I18n.t("wifi.providers.loading"));
    try {
      this.renderList(await this.client.providers());
    } catch (e) {
      // 503 = gestion désactivée (clé de chiffrement absente) OU module en erreur : on montre le
      // détail actionnable du serveur AU LIEU des contrôles d'édition (rien à configurer sans clé).
      if (e instanceof WifiSyncError && e.status === 503) { this.renderDisabled(e); return; }
      this.message(I18n.t("wifi.providers.loadError", { detail: WifiProvidersForm.errText(e) }), true);
    }
  }

  /** Liste des providers (id, type, URL, intervalle, timeout) + bouton « Ajouter ». */
  private renderList(providers: WifiProviderSummary[]): void {
    this.panel.innerHTML = "";
    const intro = document.createElement("div"); intro.className = "form-hint";
    intro.textContent = I18n.t("wifi.providers.intro");
    this.panel.appendChild(intro);

    if (!providers.length) {
      const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic"; empty.style.marginTop = "8px";
      empty.textContent = I18n.t("wifi.providers.empty");
      this.panel.appendChild(empty);
    } else {
      const rows = providers.map((p) => [
        `<span style="font-family:var(--mono)">${Html.escape(p.id)}</span>`,
        Html.escape(WifiProvidersForm.kindLabel(p.kind)),
        `<span style="font-family:var(--mono)">${Html.escape(p.url)}</span>`,
        p.interval_sec > 0 ? (p.interval_sec + " s") : I18n.t("wifi.providers.intervalManual"),
        p.timeout_sec + " s",
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(p.id)}">${Html.escape(I18n.t("lists.chrome.rowEdit"))}</button>`,
      ]);
      const tw = this.table([I18n.t("wifi.providers.colProvider"), I18n.t("wifi.providers.colType"), I18n.t("wifi.providers.colUrl"), I18n.t("wifi.providers.colInterval"), I18n.t("wifi.providers.colTimeout"), ""], rows);
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
    add.textContent = I18n.t("wifi.providers.add"); add.style.marginTop = "12px";
    add.onclick = () => this.renderForm(null);
    this.panel.appendChild(add);
  }

  /* --------------------------------------------------------------------------
     ÉCRAN FORMULAIRE (création / édition)
     -------------------------------------------------------------------------- */

  /** Formulaire de création (`existing === null`) ou d'édition. `id` immuable en édition. */
  private renderForm(existing: WifiProviderSummary | null): void {
    this.panel.innerHTML = "";
    const editing = existing !== null;

    // -- Fil d'Ariane : retour à la liste. --
    const back = document.createElement("button"); back.type = "button"; back.className = "btn btn-ghost btn-sm";
    back.textContent = I18n.t("wifi.providers.back"); back.onclick = () => void this.loadList();
    this.panel.appendChild(back);

    const heading = document.createElement("div"); heading.className = "section-divider";
    heading.textContent = editing ? I18n.t("wifi.providers.headingEdit", { id: existing!.id }) : I18n.t("wifi.providers.headingNew");
    this.panel.appendChild(heading);

    // -- id (immuable en édition — c'est la clé de réconciliation des clients de ce provider). --
    const idInput = FormControls.text(existing ? existing.id : "", I18n.t("wifi.providers.idPlaceholder"));
    if (editing) { idInput.readOnly = true; idInput.style.opacity = "0.7"; }
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.idField"), idInput,
      editing ? I18n.t("wifi.providers.idHintEdit") : I18n.t("wifi.providers.idHintNew")));

    // -- TYPE de contrôleur : c'est LUI qui décide des champs d'option affichés plus bas. --
    const kindSel = FormControls.select(WifiProvidersForm.KINDS.map((k) => ({ value: k.value, label: k.label })), existing ? existing.kind : WifiProvidersForm.KINDS[0].value);
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.typeField"), kindSel, I18n.t("wifi.providers.typeHint")));

    // -- URL de la console (UNE seule — un contrôleur wifi n'a pas de pool de nœuds, cf. D3). --
    const urlInput = FormControls.text(existing ? existing.url : "", "https://unifi.exemple.lan");
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.urlField"), urlInput, I18n.t("wifi.providers.urlHint")));

    // -- Empreinte TLS (épinglage) : niveau 1 de la hiérarchie de confiance. --
    const fpInput = FormControls.text(existing && existing.fingerprint ? existing.fingerprint : "", I18n.t("wifi.providers.fpPlaceholder"));
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.tlsField"), fpInput, I18n.t("wifi.providers.tlsHint")));

    // -- CA (PEM) : niveau 2 — PUBLIQUE (renvoyée en lecture), l'empreinte reste prioritaire. --
    const caInput = FormControls.textArea(existing && existing.ca_pem ? existing.ca_pem : "");
    caInput.placeholder = "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----";
    caInput.rows = 4; caInput.style.fontFamily = "var(--mono)";
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.caField"), caInput, I18n.t("wifi.providers.caHint")));

    // -- Jeton : champ password JAMAIS pré-rempli. En édition, vide = conserver le jeton stocké. --
    const tokenInput = FormControls.text("", editing ? I18n.t("wifi.providers.tokenPlaceholderEdit") : I18n.t("wifi.providers.tokenPlaceholderNew"));
    tokenInput.type = "password"; tokenInput.autocomplete = "new-password";   // empêche l'autofill du navigateur
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.tokenField"), tokenInput,
      editing ? I18n.t("wifi.providers.tokenHintEdit") : I18n.t("wifi.providers.tokenHintNew")));

    // -- CHAMPS PROPRES AU TYPE : re-rendus quand le type change (cf. en-tête, D9). L'état des
    //    valeurs vit dans `optionValues`, hors du DOM, pour SURVIVRE au changement de type (revenir
    //    au type précédent ne doit pas avoir effacé ce qui y était saisi). --
    const optionValues: Record<string, string | boolean> = {};
    for (const [kind, fields] of Object.entries(WifiProvidersForm.KIND_FIELDS)) {
      for (const field of fields) {
        const stored = existing && existing.kind === kind ? existing.options[field.name] : undefined;
        optionValues[kind + "." + field.name] = (typeof stored === "string" || typeof stored === "boolean") ? stored : field.fallback;
      }
    }
    const optionsWrap = document.createElement("div");
    const renderOptions = (): void => {
      optionsWrap.innerHTML = "";
      const fields = WifiProvidersForm.KIND_FIELDS[kindSel.value] || [];
      if (!fields.length) return;
      const title = document.createElement("div"); title.className = "section-divider";
      title.textContent = I18n.t("wifi.providers.opt.section", { kind: WifiProvidersForm.kindLabel(kindSel.value) });
      optionsWrap.appendChild(title);
      for (const field of fields) {
        const key = kindSel.value + "." + field.name;
        if (field.type === "toggle") {
          const toggle = FormControls.toggle(I18n.t(field.labelKey), optionValues[key] === true, (checked: boolean) => { optionValues[key] = checked; });
          const wrap = document.createElement("div"); wrap.className = "form-field";
          const lbl = document.createElement("label"); lbl.textContent = I18n.t(field.labelKey);
          const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = I18n.t(field.hintKey);
          wrap.append(lbl, toggle, hint);
          optionsWrap.appendChild(wrap);
        } else {
          const input = FormControls.text(String(optionValues[key] ?? ""), field.placeholderKey ? I18n.t(field.placeholderKey) : "");
          input.oninput = () => { optionValues[key] = input.value; };
          optionsWrap.appendChild(FormControls.fieldRow(I18n.t(field.labelKey), input, I18n.t(field.hintKey)));
        }
      }
    };
    renderOptions();
    kindSel.onchange = () => renderOptions();
    this.panel.appendChild(optionsWrap);

    // -- interval_sec / timeout_sec. --
    const intervalInput = FormControls.number(existing ? existing.interval_sec : 0, { min: 0, step: 1, placeholder: "0" });
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.intervalField"), intervalInput, I18n.t("wifi.providers.intervalHint")));
    const timeoutInput = FormControls.number(existing ? existing.timeout_sec : 15, { min: 1, step: 1, placeholder: "15" });
    this.panel.appendChild(FormControls.fieldRow(I18n.t("wifi.providers.timeoutField"), timeoutInput, I18n.t("wifi.providers.timeoutHint")));

    // -- Zone de RÉSULTAT du test + zone d'ERREUR (messages français du serveur). --
    const testBox = document.createElement("div"); testBox.style.marginTop = "10px";
    const errBox = document.createElement("div"); errBox.className = "form-hint err"; errBox.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    const showError = (e: unknown): void => {
      errBox.style.display = "block"; testBox.innerHTML = "";
      errBox.textContent = WifiProvidersForm.errText(e);
    };

    const collectInput = (): WifiProviderInput => {
      const intervalStr = intervalInput.value.trim();
      const timeoutStr = timeoutInput.value.trim();
      // Seules les options DU TYPE COURANT partent : envoyer celles d'un autre type serait au
      // mieux ignoré côté serveur (les options inconnues sont écartées), au pire trompeur en relecture.
      const options: WifiProviderOptions = {};
      for (const field of WifiProvidersForm.KIND_FIELDS[kindSel.value] || []) {
        const value = optionValues[kindSel.value + "." + field.name];
        options[field.name] = typeof value === "boolean" ? value : String(value ?? "");
      }
      const input: WifiProviderInput = {
        id: (editing ? existing!.id : idInput.value.trim()),
        kind: kindSel.value,
        url: urlInput.value.trim(),
        fingerprint: fpInput.value.trim() || null,
        // CA PUBLIQUE, envoyée telle quelle (vide → null) : elle n'a pas la réserve du jeton.
        ca_pem: caInput.value.trim() || null,
        interval_sec: intervalStr === "" ? 0 : Number(intervalStr),
        timeout_sec: timeoutStr === "" ? 15 : Number(timeoutStr),
        options,
      };
      // Le jeton ne part QUE s'il est (re)saisi (écriture seule) — vide = conserver côté serveur.
      const token = tokenInput.value;
      if (token.trim() !== "") input.token = token;
      return input;
    };

    const actions = document.createElement("div"); actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:14px";

    const testBtn = document.createElement("button"); testBtn.type = "button"; testBtn.className = "btn btn-ghost";
    testBtn.textContent = I18n.t("wifi.providers.test");
    testBtn.onclick = async () => {
      errBox.style.display = "none";
      testBox.innerHTML = ""; testBox.appendChild(WifiProvidersForm.hint(I18n.t("wifi.providers.testing")));
      testBtn.disabled = true;
      try {
        this.renderTestResult(testBox, await this.client.testProvider(collectInput()));
      } catch (e) {
        showError(e);
      } finally {
        testBtn.disabled = false;
      }
    };

    const saveBtn = document.createElement("button"); saveBtn.type = "button"; saveBtn.className = "btn btn-primary";
    saveBtn.textContent = I18n.t("ui.action.save");
    saveBtn.onclick = async () => {
      errBox.style.display = "none";
      const input = collectInput();
      if (!editing && input.id === "") { showError(new WifiSyncError(I18n.t("wifi.providers.idRequired"), 0, null)); return; }
      saveBtn.disabled = true;
      try {
        await this.client.saveProvider(input.id, input);
        Notify.toast(editing ? I18n.t("wifi.providers.savedUpdated") : I18n.t("wifi.providers.savedCreated"), "ok");
        this.onChanged();          // la config a changé à chaud
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
      delBtn.textContent = I18n.t("ui.action.delete"); delBtn.style.marginLeft = "auto";
      delBtn.onclick = async () => {
        const ok = await Dialog.confirm({
          title: I18n.t("wifi.providers.deleteTitle"),
          message: I18n.t("wifi.providers.deleteMessage", { id: existing!.id }),
          confirmLabel: I18n.t("ui.action.delete"), danger: true,
        });
        if (!ok) return;
        delBtn.disabled = true;
        try {
          await this.client.deleteProvider(existing!.id);
          Notify.toast(I18n.t("wifi.providers.deleted"), "ok");
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
    setTimeout(() => { if (!editing) idInput.focus(); else urlInput.focus(); }, 30);
  }

  /** Rend le résultat d'un test (`WifiProviderInfo`) : pastilles + message serveur. */
  private renderTestResult(box: HTMLElement, info: WifiProviderInfo): void {
    box.innerHTML = "";
    const pills = document.createElement("div"); pills.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
    pills.innerHTML = [
      WifiProvidersForm.pill(info.ok ? I18n.t("wifi.providers.testConnOk") : I18n.t("wifi.providers.testConnFail"), info.ok ? "ok" : "err"),
      // `supported` = « l'API attendue répond ET la configuration (site…) est résolue ». On le rend
      // en clair plutôt qu'en jargon : c'est le seul indicateur qui distingue « ça se connecte »
      // de « ça va vraiment synchroniser quelque chose ».
      WifiProvidersForm.pill(info.supported ? I18n.t("wifi.providers.testApiOk") : I18n.t("wifi.providers.testApiWarn"), info.supported ? "ok" : "warn"),
      info.version ? WifiProvidersForm.pill(info.version, "neutral") : "",
    ].filter(Boolean).join(" ");
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
      contrôles d'édition (clé `DCMANAGER_SECRETS_KEY` absente, ou config en erreur). */
  private renderDisabled(err: WifiSyncError): void {
    this.panel.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--warn);border-radius:6px;padding:14px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--warn);margin-bottom:6px";
    title.textContent = err.message || I18n.t("wifi.providers.disabledTitle");
    box.appendChild(title);
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line";
    detail.textContent = err.detail || I18n.t("wifi.providers.disabledDetail");
    box.appendChild(detail);
    this.panel.appendChild(box);
  }

  /* --------------------------------------------------------------------------
     Primitives DOM (répliquées pour rester AUTONOME — mêmes classes CSS que les fiches)
     -------------------------------------------------------------------------- */

  /** Libellé lisible d'un type de contrôleur (repli : l'identifiant brut — une base peut porter
      un `kind` d'une version future que cette UI ne connaît pas encore). */
  private static kindLabel(kind: string): string {
    const known = WifiProvidersForm.KINDS.find((k) => k.value === kind);
    return known ? known.label : kind;
  }

  /** Message pleine largeur (chargement / erreur) — remplace le contenu du panneau. */
  private message(text: string, isError = false): void {
    this.panel.innerHTML = "";
    const n = document.createElement("div"); n.className = isError ? "form-hint err" : "form-hint";
    n.textContent = text; this.panel.appendChild(n);
  }

  /** Table compacte (cellules = HTML déjà échappé par l'appelant). Renvoie le conteneur. */
  private table(headers: string[], rows: string[][]): HTMLElement {
    const tw = document.createElement("div"); tw.className = "table-wrap"; tw.style.marginTop = "10px";
    const head = headers.map((h) => `<th>${Html.escape(h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    tw.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    this.panel.appendChild(tw); return tw;
  }

  /** Note libre (form-hint). */
  private static hint(text: string): HTMLElement {
    const n = document.createElement("div"); n.className = "form-hint"; n.textContent = text; return n;
  }

  /** Pastille sémantique (mêmes couleurs que VmProvidersForm). */
  private static pill(text: string, kind: "ok" | "err" | "warn" | "neutral"): string {
    const style = kind === "ok" ? ` style="border-color:var(--ok);color:var(--ok)"`
      : kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  /** Message d'erreur lisible : `WifiSyncError` porte code HTTP + `detail` (issues 400 / config 503). */
  private static errText(e: unknown): string {
    if (e instanceof WifiSyncError) return e.message + (e.detail ? "\n" + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
