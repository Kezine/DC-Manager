import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { TrackerSyncError } from "./TrackerSyncClient";
import type { TrackerSyncClient, TrackerProviderSummary, TrackerProviderInfo, TrackerProviderInput, TrackerProviderOptions } from "./TrackerSyncClient";
import type { FormHost } from "./shared";
import { I18n } from "../../i18n/I18n";

/* =============================================================================
   MODALE DE GESTION DES PROVIDERS DE RÉPLICATION — feature AMOVIBLE (mode API, non-viewer).

   Classe DÉDIÉE et AUTONOME (hors chaîne d'héritage `Forms`, à CÔTÉ de `TrackerTicketBlock`) :
   la retirer = supprimer ce fichier + l'action « Providers… » de l'en-tête de la vue
   Interventions, sans cicatrice ailleurs. N'a besoin QUE de `FormHost.openModal`
   (modale partagée) et du `TrackerSyncClient` (routes CRUD/test) — aucun accès au store.

   Ergonomie (calquée sur `WifiProvidersForm`) : UNE seule modale, pied de page MASQUÉ
   (`hideFooter`) — les actions sont PROPRES à chaque écran. Le corps bascule entre
   DEUX écrans re-rendus en place :
   - LISTE : un provider par ligne (id, type, URL, compte, intervalle, timeout) + « Ajouter » ;
   - FORMULAIRE : id (immuable en édition), TYPE, URL de l'instance, COMPTE de service,
     jeton en champ password (« inchangé si vide »), intervalle, timeout, PLUS les champs
     PROPRES AU TYPE choisi ; « Tester la connexion », « Enregistrer », « Supprimer ».

   ── DEUX ÉCARTS ASSUMÉS avec le formulaire des providers WIFI ─────────────────
   1. PAS d'empreinte TLS ni de CA : un tracker SaaS est un service public à certificat
      VALIDE. Ce matériel de confiance existe côté VM/wifi parce que les consoles
      Proxmox/UniFi sont massivement auto-signées ; le demander ici ferait saisir un
      réglage sans emploi, et laisserait croire que ce transport sait s'en servir — il
      ne sait pas (le serveur est bâti sur `fetch`, pas sur `node:https`).
   2. UN champ `account` EN PLUS : l'identification d'un tracker est un COUPLE (qui, avec
      quel secret). `account` en est la moitié PUBLIQUE — il est RELU et réaffiché à
      l'édition, contrairement au jeton. C'est exactement ce que garantit l'API : elle
      renvoie `account` et jamais `token`.

   ── AGNOSTICISME DE MARQUE (exigence n°1 du chantier) ─────────────────────────
   Les champs propres à une marque ne sont PAS écrits en dur dans le formulaire : ils
   sont DÉCLARÉS dans `KIND_FIELDS` (une entrée par `kind`) et rendus dynamiquement,
   en MIROIR de `TrackerProviderConfigValidate.KIND_OPTION_SPECS` côté serveur. Ajouter
   une marque = ajouter une entrée ici (+ ses libellés i18n) et une option du `<select>`,
   rien d'autre dans ce fichier.
   ⚠ Les deux tables doivent rester en phase — un champ affiché mais non déclaré côté
   serveur serait silencieusement ignoré (les options inconnues sont écartées), et un
   champ déclaré côté serveur mais non affiché resterait figé sur son défaut. C'est
   pourquoi `KIND_FIELDS` est PUBLIC : un test compare mécaniquement les deux tables
   (noms, ordre, types, défauts). Un miroir que personne ne vérifie finit par diverger.

   INVARIANTS DE SÉCURITÉ : le champ jeton n'est JAMAIS pré-rempli (l'API ne relit pas
   un jeton) ; il ne part EN CLAIR qu'à l'envoi et seulement s'il est (re)saisi.
   Clé de chiffrement absente / config invalide (503) → BANDEAU explicite au lieu des
   contrôles d'édition (on reprend le `detail` du serveur, actionnable) : tant que la
   clé n'est pas là, il n'y a tout simplement rien à configurer.
   ============================================================================= */

/** Déclaration d'UN champ d'option propre à une marque (miroir client de `TrackerOptionSpec`). */
export interface TrackerKindFieldSpec {
  /** Nom de l'option — DOIT correspondre au `name` déclaré côté serveur. */
  name: string;
  /** Contrôle rendu. `text` ⇄ spec serveur `string`, `toggle` ⇄ `boolean`. */
  type: "text" | "toggle";
  /** Valeur posée quand le provider n'a pas encore cette option (création, ou marque changée).
      DOIT être le `default` de la spec serveur : autrement le formulaire proposerait autre chose
      que ce que le serveur applique en l'absence de saisie. */
  fallback: string | boolean;
  /** Clés i18n du libellé et de l'aide — dans le domaine `tracker.providers.opt`. */
  labelKey: string;
  hintKey: string;
  /** Placeholder du champ texte (clé i18n), facultatif. */
  placeholderKey?: string;
}

export class TrackerProvidersForm {
  /** TYPES de tracker proposés — miroir de la fabrique `TrackerSyncService.adapterFor` et de
      `TrackerProviderConfigValidate.KIND_OPTION_SPECS`. Un seul aujourd'hui : le `<select>` existe
      quand même, parce que c'est LUI qui rend l'ajout d'une marque non structurant (cf. en-tête).
      Le LIBELLÉ est une marque commerciale, donc écrit tel quel et NON traduit (comme « Proxmox »
      côté VM et « UniFi » côté wifi). */
  private static readonly KINDS: readonly { value: string; label: string }[] = [
    { value: "jira", label: "Jira" },
  ];

  /** Champs d'option PAR TYPE — le point d'extension « marque » côté UI (cf. en-tête). PUBLIC parce
      qu'un test le confronte à `KIND_OPTION_SPECS` (serveur) : le miroir est VÉRIFIÉ, pas affirmé. */
  static readonly KIND_FIELDS: Readonly<Record<string, readonly TrackerKindFieldSpec[]>> = {
    jira: [
      { name: "project_key", type: "text", fallback: "", labelKey: "tracker.providers.opt.projectField", hintKey: "tracker.providers.opt.projectHint", placeholderKey: "tracker.providers.opt.projectPlaceholder" },
      // Un type de ticket PAR NATURE d'objet DC Manager : les incidents et les interventions ne se
      // traitent pas de la même façon côté tracker, et le projet leur a souvent deux types distincts.
      { name: "type_incident", type: "text", fallback: "Incident", labelKey: "tracker.providers.opt.typeIncidentField", hintKey: "tracker.providers.opt.typeIncidentHint", placeholderKey: "tracker.providers.opt.typeIncidentPlaceholder" },
      { name: "type_intervention", type: "text", fallback: "Infrastructure", labelKey: "tracker.providers.opt.typeInterventionField", hintKey: "tracker.providers.opt.typeInterventionHint", placeholderKey: "tracker.providers.opt.typeInterventionPlaceholder" },
      { name: "auto_replicate", type: "toggle", fallback: true, labelKey: "tracker.providers.opt.autoReplicateField", hintKey: "tracker.providers.opt.autoReplicateHint" },
    ],
  };

  /** Conteneur re-rendu en place (bascule liste ↔ formulaire). */
  private panel!: HTMLElement;

  private constructor(
    private readonly host: FormHost,
    private readonly client: TrackerSyncClient,
    /** Appelé après TOUTE écriture réussie (enregistrement / suppression) — l'appelant s'en sert
        pour rafraîchir ce qui doit l'être (la config vit côté serveur, sans push SSE). */
    private readonly onChanged: () => void,
  ) {}

  /** Ouvre la modale de gestion (en-tête de la vue Interventions, mode API + non-viewer). */
  static open(host: FormHost, client: TrackerSyncClient, onChanged: () => void): void {
    const form = new TrackerProvidersForm(host, client, onChanged);
    const root = document.createElement("div");
    form.panel = document.createElement("div");
    root.appendChild(form.panel);
    form.host.openModal({
      title: I18n.t("tracker.providers.title"),
      subtitle: I18n.t("tracker.providers.subtitle"),
      body: root, wide: true, hideFooter: true,
    });
    void form.loadList();
  }

  /* --------------------------------------------------------------------------
     ÉCRAN LISTE
     -------------------------------------------------------------------------- */

  /** Charge `GET …/tracker/providers` puis rend la liste. 503 (clé absente / config invalide) → bandeau. */
  private async loadList(): Promise<void> {
    this.message(I18n.t("tracker.providers.loading"));
    try {
      this.renderList(await this.client.providers());
    } catch (e) {
      // 503 = gestion désactivée (clé de chiffrement absente) OU module en erreur : on montre le
      // détail actionnable du serveur AU LIEU des contrôles d'édition (rien à configurer sans clé).
      if (e instanceof TrackerSyncError && e.status === 503) { this.renderDisabled(e); return; }
      this.message(I18n.t("tracker.providers.loadError", { detail: TrackerProvidersForm.errText(e) }), true);
    }
  }

  /** Liste des providers (id, type, URL, compte, intervalle, timeout) + bouton « Ajouter ». */
  private renderList(providers: TrackerProviderSummary[]): void {
    this.panel.innerHTML = "";
    const intro = document.createElement("div"); intro.className = "form-hint";
    intro.textContent = I18n.t("tracker.providers.intro");
    this.panel.appendChild(intro);

    if (!providers.length) {
      const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic"; empty.style.marginTop = "8px";
      empty.textContent = I18n.t("tracker.providers.empty");
      this.panel.appendChild(empty);
    } else {
      const rows = providers.map((p) => [
        `<span style="font-family:var(--mono)">${Html.escape(p.id)}</span>`,
        Html.escape(TrackerProvidersForm.kindLabel(p.kind)),
        `<span style="font-family:var(--mono)">${Html.escape(p.url)}</span>`,
        Html.escape(p.account || ""),
        p.interval_sec > 0 ? (p.interval_sec + " s") : I18n.t("tracker.providers.intervalManual"),
        p.timeout_sec + " s",
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(p.id)}">${Html.escape(I18n.t("lists.chrome.rowEdit"))}</button>`,
      ]);
      const tw = this.table([
        I18n.t("tracker.providers.colProvider"), I18n.t("tracker.providers.colType"), I18n.t("tracker.providers.colUrl"),
        I18n.t("tracker.providers.colAccount"), I18n.t("tracker.providers.colInterval"), I18n.t("tracker.providers.colTimeout"), "",
      ], rows);
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
    add.textContent = I18n.t("tracker.providers.add"); add.style.marginTop = "12px";
    add.onclick = () => this.renderForm(null);
    this.panel.appendChild(add);
  }

  /* --------------------------------------------------------------------------
     ÉCRAN FORMULAIRE (création / édition)
     -------------------------------------------------------------------------- */

  /** Formulaire de création (`existing === null`) ou d'édition. `id` immuable en édition. */
  private renderForm(existing: TrackerProviderSummary | null): void {
    this.panel.innerHTML = "";
    const editing = existing !== null;

    // -- Fil d'Ariane : retour à la liste. --
    const back = document.createElement("button"); back.type = "button"; back.className = "btn btn-ghost btn-sm";
    back.textContent = I18n.t("tracker.providers.back"); back.onclick = () => void this.loadList();
    this.panel.appendChild(back);

    const heading = document.createElement("div"); heading.className = "section-divider";
    heading.textContent = editing ? I18n.t("tracker.providers.headingEdit", { id: existing!.id }) : I18n.t("tracker.providers.headingNew");
    this.panel.appendChild(heading);

    // -- id (immuable en édition — c'est la clé référencée par `provider_id` des tickets suivis). --
    const idInput = FormControls.text(existing ? existing.id : "", I18n.t("tracker.providers.idPlaceholder"));
    if (editing) { idInput.readOnly = true; idInput.style.opacity = "0.7"; }
    this.panel.appendChild(FormControls.fieldRow(I18n.t("tracker.providers.idField"), idInput,
      editing ? I18n.t("tracker.providers.idHintEdit") : I18n.t("tracker.providers.idHintNew")));

    // -- TYPE de tracker : c'est LUI qui décide des champs d'option affichés plus bas. --
    const kindSel = FormControls.select(TrackerProvidersForm.KINDS.map((k) => ({ value: k.value, label: k.label })), existing ? existing.kind : TrackerProvidersForm.KINDS[0].value);
    this.panel.appendChild(FormControls.fieldRow(I18n.t("tracker.providers.typeField"), kindSel, I18n.t("tracker.providers.typeHint")));

    // -- URL de l'instance (https obligatoire côté serveur : le jeton voyage en en-tête). --
    const urlInput = FormControls.text(existing ? existing.url : "", I18n.t("tracker.providers.urlPlaceholder"));
    this.panel.appendChild(FormControls.fieldRow(I18n.t("tracker.providers.urlField"), urlInput, I18n.t("tracker.providers.urlHint")));

    // -- COMPTE de service : moitié PUBLIQUE de l'identification → PRÉ-REMPLI en édition. --
    const accountInput = FormControls.text(existing ? existing.account : "", I18n.t("tracker.providers.accountPlaceholder"));
    this.panel.appendChild(FormControls.fieldRow(I18n.t("tracker.providers.accountField"), accountInput, I18n.t("tracker.providers.accountHint")));

    // -- Jeton : champ password JAMAIS pré-rempli. En édition, vide = conserver le jeton stocké. --
    const tokenInput = FormControls.text("", editing ? I18n.t("tracker.providers.tokenPlaceholderEdit") : I18n.t("tracker.providers.tokenPlaceholderNew"));
    tokenInput.type = "password"; tokenInput.autocomplete = "new-password";   // empêche l'autofill du navigateur
    this.panel.appendChild(FormControls.fieldRow(I18n.t("tracker.providers.tokenField"), tokenInput,
      editing ? I18n.t("tracker.providers.tokenHintEdit") : I18n.t("tracker.providers.tokenHintNew")));

    // -- CHAMPS PROPRES AU TYPE : re-rendus quand le type change (cf. en-tête). L'état des valeurs
    //    vit dans `optionValues`, hors du DOM, pour SURVIVRE au changement de type (revenir au type
    //    précédent ne doit pas avoir effacé ce qui y était saisi). --
    const optionValues: Record<string, string | boolean> = {};
    for (const [kind, fields] of Object.entries(TrackerProvidersForm.KIND_FIELDS)) {
      for (const field of fields) {
        const stored = existing && existing.kind === kind ? existing.options[field.name] : undefined;
        optionValues[kind + "." + field.name] = (typeof stored === "string" || typeof stored === "boolean") ? stored : field.fallback;
      }
    }
    const optionsWrap = document.createElement("div");
    const renderOptions = (): void => {
      optionsWrap.innerHTML = "";
      const fields = TrackerProvidersForm.KIND_FIELDS[kindSel.value] || [];
      if (!fields.length) return;
      const title = document.createElement("div"); title.className = "section-divider";
      title.textContent = I18n.t("tracker.providers.opt.section", { kind: TrackerProvidersForm.kindLabel(kindSel.value) });
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

    // -- interval_sec / timeout_sec. L'intervalle est à régler HAUT : la passe coûte une requête par
    //    centaine de tickets suivis, et l'état d'un ticket n'a pas la volatilité d'un client wifi. --
    const intervalInput = FormControls.number(existing ? existing.interval_sec : 0, { min: 0, step: 1, placeholder: "0" });
    this.panel.appendChild(FormControls.fieldRow(I18n.t("tracker.providers.intervalField"), intervalInput, I18n.t("tracker.providers.intervalHint")));
    const timeoutInput = FormControls.number(existing ? existing.timeout_sec : TrackerProvidersForm.DEFAULT_TIMEOUT_SEC, { min: 1, step: 1, placeholder: String(TrackerProvidersForm.DEFAULT_TIMEOUT_SEC) });
    this.panel.appendChild(FormControls.fieldRow(I18n.t("tracker.providers.timeoutField"), timeoutInput, I18n.t("tracker.providers.timeoutHint")));

    // -- Zone de RÉSULTAT du test + zone d'ERREUR (messages français du serveur). --
    const testBox = document.createElement("div"); testBox.style.marginTop = "10px";
    const errBox = document.createElement("div"); errBox.className = "form-hint err"; errBox.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    const showError = (e: unknown): void => {
      errBox.style.display = "block"; testBox.innerHTML = "";
      errBox.textContent = TrackerProvidersForm.errText(e);
    };

    const collectInput = (): TrackerProviderInput => {
      const intervalStr = intervalInput.value.trim();
      const timeoutStr = timeoutInput.value.trim();
      // Seules les options DU TYPE COURANT partent : envoyer celles d'un autre type serait au
      // mieux ignoré côté serveur (les options inconnues sont écartées), au pire trompeur en relecture.
      const options: TrackerProviderOptions = {};
      for (const field of TrackerProvidersForm.KIND_FIELDS[kindSel.value] || []) {
        const value = optionValues[kindSel.value + "." + field.name];
        options[field.name] = typeof value === "boolean" ? value : String(value ?? "");
      }
      const input: TrackerProviderInput = {
        id: (editing ? existing!.id : idInput.value.trim()),
        kind: kindSel.value,
        url: urlInput.value.trim(),
        account: accountInput.value.trim(),
        interval_sec: intervalStr === "" ? 0 : Number(intervalStr),
        timeout_sec: timeoutStr === "" ? TrackerProvidersForm.DEFAULT_TIMEOUT_SEC : Number(timeoutStr),
        options,
      };
      // Le jeton ne part QUE s'il est (re)saisi (écriture seule) — vide = conserver côté serveur.
      const token = tokenInput.value;
      if (token.trim() !== "") input.token = token;
      return input;
    };

    const actions = document.createElement("div"); actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:14px";

    const testBtn = document.createElement("button"); testBtn.type = "button"; testBtn.className = "btn btn-ghost";
    testBtn.textContent = I18n.t("tracker.providers.test");
    testBtn.onclick = async () => {
      errBox.style.display = "none";
      testBox.innerHTML = ""; testBox.appendChild(TrackerProvidersForm.hint(I18n.t("tracker.providers.testing")));
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
      if (!editing && input.id === "") { showError(new TrackerSyncError(I18n.t("tracker.providers.idRequired"), 0, null)); return; }
      saveBtn.disabled = true;
      try {
        await this.client.saveProvider(input.id, input);
        Notify.toast(editing ? I18n.t("tracker.providers.savedUpdated") : I18n.t("tracker.providers.savedCreated"), "ok");
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
          title: I18n.t("tracker.providers.deleteTitle"),
          message: I18n.t("tracker.providers.deleteMessage", { id: existing!.id }),
          confirmLabel: I18n.t("ui.action.delete"), danger: true,
        });
        if (!ok) return;
        delBtn.disabled = true;
        try {
          await this.client.deleteProvider(existing!.id);
          Notify.toast(I18n.t("tracker.providers.deleted"), "ok");
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

  /** Rend le résultat d'un test (`TrackerProviderInfo`) : pastilles + message serveur. */
  private renderTestResult(box: HTMLElement, info: TrackerProviderInfo): void {
    box.innerHTML = "";
    const pills = document.createElement("div"); pills.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
    pills.innerHTML = [
      TrackerProvidersForm.pill(info.ok ? I18n.t("tracker.providers.testConnOk") : I18n.t("tracker.providers.testConnFail"), info.ok ? "ok" : "err"),
      // `supported` = « l'API attendue répond bien ». On le rend en clair plutôt qu'en jargon : c'est
      // le seul indicateur qui distingue « ça s'authentifie » de « ça va vraiment savoir résoudre ».
      TrackerProvidersForm.pill(info.supported ? I18n.t("tracker.providers.testApiOk") : I18n.t("tracker.providers.testApiWarn"), info.supported ? "ok" : "warn"),
      info.version ? TrackerProvidersForm.pill(info.version, "neutral") : "",
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
  private renderDisabled(err: TrackerSyncError): void {
    this.panel.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--warn);border-radius:6px;padding:14px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--warn);margin-bottom:6px";
    title.textContent = err.message || I18n.t("tracker.providers.disabledTitle");
    box.appendChild(title);
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line";
    detail.textContent = err.detail || I18n.t("tracker.providers.disabledDetail");
    box.appendChild(detail);
    this.panel.appendChild(box);
  }

  /* --------------------------------------------------------------------------
     Primitives DOM (répliquées pour rester AUTONOME — mêmes classes CSS que les fiches)
     -------------------------------------------------------------------------- */

  /** Délai par requête proposé à la création — MÊME valeur que le défaut serveur
      (`TrackerProviderConfigValidate.DEFAULT_TIMEOUT_SEC`), plus généreux que les 15 s des modules
      VM/wifi : une requête est ici une RECHERCHE côté SaaS traversant Internet, pas une lecture LAN. */
  private static readonly DEFAULT_TIMEOUT_SEC = 20;

  /** Libellé lisible d'un type de tracker (repli : l'identifiant brut — une base peut porter un
      `kind` d'une version future que cette UI ne connaît pas encore). */
  private static kindLabel(kind: string): string {
    const known = TrackerProvidersForm.KINDS.find((k) => k.value === kind);
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

  /** Pastille sémantique (mêmes couleurs que VmProvidersForm/WifiProvidersForm). */
  private static pill(text: string, kind: "ok" | "err" | "warn" | "neutral"): string {
    const style = kind === "ok" ? ` style="border-color:var(--ok);color:var(--ok)"`
      : kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  /** Message d'erreur lisible — DÉLÉGUÉ au transport (`TrackerSyncError.text`), qui sait ce que
      portent ses codes (issues 400 / config 503) : une seule formulation pour toute la feature. */
  private static errText(e: unknown): string {
    return TrackerSyncError.text(e);
  }
}
