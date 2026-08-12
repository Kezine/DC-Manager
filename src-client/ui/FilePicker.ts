import { Html } from "../core/Html";
import { Icons } from "./Icons";
import { Format } from "../core/Format";
import { I18n } from "../i18n/I18n";

/* =============================================================================
   FilePicker — sélecteur de FICHIER réutilisable et thématisé (principe n°14).

   Le trou identifié par le cadrage des pièces jointes (D10) : le seul sélecteur
   de fichier de l'app était `FormBase.promptImageFile`, ENFERMÉ dans la chaîne
   des formulaires et SPÉCIFIQUE aux images. Toute nouvelle fonctionnalité qui a
   besoin d'un `<input type=file>` le réécrivait — la dette exacte que le principe
   n°14 interdit. Cette primitive vit dans `ui/`, autonome, au même titre que les
   contrôles de `ui/FormControls` (elle N'EN dépend PAS et n'en est pas dépendue).

   Ce qu'elle apporte, qu'un `<input type=file>` nu n'a pas :
     - `accept` PARAMÉTRÉ (pour les pièces jointes : `Schema.ATTACHMENT_MIME_TYPES`),
       posé sur l'input ET revérifié à la sélection (l'attribut `accept` n'est
       qu'un filtre de dialogue — le navigateur laisse choisir « tous les
       fichiers », donc on REVALIDE le type reçu) ;
     - un plafond de TAILLE paramétré, vérifié AVANT tout upload — une erreur
       immédiate et lisible plutôt qu'un rejet 413 du serveur après un transfert ;
     - un rendu THÉMATISÉ : zone cliquable affichant le fichier choisi (nom +
       taille formatée) avec un bouton d'effacement, un message d'erreur inline.

   ⚠ ACTIVATION UTILISATEUR (le piège documenté de `promptImageFile`) : le
   `<input type=file>` est PERMANENT dans le DOM (masqué), et son `.click()` est
   déclenché SYNCHRONEMENT dans le gestionnaire de clic de la zone — donc dans le
   geste utilisateur. On n'enchaîne JAMAIS deux ouvertures : un seul input, un
   seul dialogue. (Le piège de `promptImageFile` était l'enchaînement de DEUX
   `input.click()` programmatiques, le premier consommant l'activation.)
   ============================================================================= */
export interface FilePickerOptions {
  /** Types MIME acceptés (LISTE BLANCHE) — posés en `accept` du dialogue ET revérifiés à la sélection. */
  accept: readonly string[];
  /** Plafond de taille en octets (absent = aucun). Vérifié à la sélection → message immédiat. */
  maxBytes?: number;
  /** Validation FINE du type (défaut : appartenance à `accept`). Permet de partager la règle du domaine
      (`Schema.isAttachmentMime`) plutôt que de la redire — le `accept` ne sert alors qu'au dialogue. */
  isValidMime?: (type: string) => boolean;
  /** Table de REPLI extension → MIME. `File.type` est instable pour certains formats texte (un `.md` arrive
      souvent VIDE sous Windows/Firefox, un `.csv` parfois en `application/vnd.ms-excel`) : quand le type fourni
      par le navigateur est vide OU inconnu de la validation, on le RÉSOUT par l'extension AVANT de valider (cf.
      D-B2). Les extensions y figurant sont AUSSI ajoutées à l'attribut `accept` (l'attribut HTML accepte les
      formes MIME et « .ext »). Absent = aucun repli (comportement historique, ex. images de façade). */
  extensionMime?: Record<string, string>;
}

/** L'élément rendu expose la valeur choisie (`file`), le MIME RÉSOLU, son effacement et le focus (parité avec
    les autres contrôles de formulaire, qui exposent `.value`/`focus()`). */
export interface FilePickerElement extends HTMLDivElement {
  /** Fichier VALIDE actuellement choisi, ou null (rien de choisi, ou dernière sélection rejetée). */
  file: File | null;
  /** MIME RÉSOLU du fichier choisi (repli extension appliqué) — à consommer À LA PLACE de `file.type`, qui
      peut être vide/faux. `null` quand aucun fichier n'est choisi. */
  mime: string | null;
  /** Réinitialise le contrôle (aucun fichier, message effacé). */
  clear(): void;
}

export class FilePicker {
  /** Résout le MIME EFFECTIF d'un fichier (pur, testable) : le type du navigateur s'il est reconnu par la
      validation, sinon le MIME associé à l'EXTENSION (repli), sinon le type d'origine tel quel (qui échouera
      alors à la validation). Ordre voulu — on ne remplace le type du navigateur QUE s'il ne classe pas :
      un `application/pdf` reconnu n'est jamais réécrit par une extension trompeuse. */
  static resolveMime(fileName: string, fileType: string, extensionMime: Record<string, string>, isValid: (type: string) => boolean): string {
    const type = String(fileType || "");
    if (type && isValid(type)) return type;   // le navigateur a fourni un type RECONNU → il fait foi
    const name = String(fileName || "");
    const dot = name.lastIndexOf(".");
    const ext = (dot >= 0 && dot < name.length - 1) ? name.slice(dot).toLowerCase() : "";
    if (ext && extensionMime && Object.prototype.hasOwnProperty.call(extensionMime, ext)) return extensionMime[ext];
    return type;   // ni type reconnu ni extension connue → type d'origine (refusé par la validation en aval)
  }

  static build(opts: FilePickerOptions): FilePickerElement {
    const accept = opts.accept || [];
    const extensionMime = opts.extensionMime || {};
    const isValid = opts.isValidMime || ((type: string) => accept.includes(String(type || "")));

    const wrap = document.createElement("div") as FilePickerElement;
    wrap.className = "file-picker";
    wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";

    // Input RÉEL, masqué mais présent dans le DOM (activation utilisateur préservée — cf. en-tête).
    const input = document.createElement("input");
    input.type = "file";
    // `accept` du dialogue : les MIME de la liste blanche PLUS les extensions du repli (un `.md` a souvent un
    // type vide — sans l'extension dans `accept`, le dialogue le grise ; l'attribut accepte les deux formes).
    input.accept = accept.concat(Object.keys(extensionMime)).join(",");
    input.style.display = "none";

    // Zone cliquable thématisée (mêmes tokens de thème que les contrôles de formulaire).
    const zone = document.createElement("button");
    zone.type = "button";   // JAMAIS submit : ce contrôle vit dans une modale à bouton Enregistrer distinct
    zone.className = "file-picker-zone";
    zone.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 12px;border:1px dashed var(--line-2);border-radius:8px;background:var(--bg-2);color:var(--fg);cursor:pointer;";

    const icon = document.createElement("span");
    icon.className = "gi"; icon.setAttribute("aria-hidden", "true");
    icon.style.cssText = "flex:0 0 auto;display:inline-flex;width:18px;height:18px;color:var(--fg-dim);";
    icon.innerHTML = Icons.ATTACHMENT;

    const label = document.createElement("span");
    label.className = "grow"; label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

    // Bouton d'effacement — visible SEULEMENT quand un fichier est choisi (bouton-icône, principe n°14).
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-ghost btn-sm icon-action";
    clearBtn.style.cssText = "flex:0 0 auto;display:none;";
    clearBtn.title = I18n.t("ui.filePicker.clear");
    clearBtn.setAttribute("aria-label", I18n.t("ui.filePicker.clear"));
    clearBtn.innerHTML = Icons.CLOSE;

    zone.append(icon, label);

    const err = document.createElement("div");
    err.className = "form-hint"; err.style.cssText = "color:var(--err);display:none;";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:stretch;gap:6px;";
    row.append(zone, clearBtn);
    wrap.append(input, row, err);

    let current: File | null = null;
    let currentMime: string | null = null;   // MIME RÉSOLU (repli extension) du fichier courant — exposé via `.mime`

    const showError = (message: string): void => { err.textContent = message; err.style.display = ""; };
    const clearError = (): void => { err.textContent = ""; err.style.display = "none"; };

    const render = (): void => {
      if (current) {
        // Nom + taille formatée (Format.bytes, unités francophones) — l'identité visible du fichier choisi.
        label.innerHTML = `${Html.escape(current.name)} <span style="color:var(--fg-dimmer)">· ${Html.escape(Format.bytes(current.size))}</span>`;
        clearBtn.style.display = "";
      } else {
        label.innerHTML = `<span style="color:var(--fg-dimmer)">${Html.escape(I18n.t("ui.filePicker.placeholder"))}</span>`;
        clearBtn.style.display = "none";
      }
    };

    const setFile = (file: File | null, mime: string | null): void => {
      current = file;
      currentMime = file ? mime : null;
      render();
    };

    // Validation à la SÉLECTION : type d'abord (anti-XSS stocké, cf. liste blanche), puis taille. Le type validé
    // est le MIME RÉSOLU (repli extension → MIME appliqué AVANT la validation, cf. resolveMime/D-B2).
    input.onchange = () => {
      const chosen = input.files && input.files[0] ? input.files[0] : null;
      if (!chosen) return;   // dialogue annulé : on garde l'état précédent
      const resolvedMime = FilePicker.resolveMime(chosen.name, chosen.type, extensionMime, isValid);
      if (!isValid(resolvedMime)) {
        setFile(null, null);
        showError(I18n.t("ui.filePicker.badType"));
        input.value = "";   // permet de re-choisir le MÊME fichier après correction
        return;
      }
      if (opts.maxBytes != null && chosen.size > opts.maxBytes) {
        setFile(null, null);
        showError(I18n.t("ui.filePicker.tooBig", { max: Format.bytes(opts.maxBytes) }));
        input.value = "";
        return;
      }
      clearError();
      setFile(chosen, resolvedMime);
    };

    // Clic sur la zone → ouverture du dialogue, DANS le geste utilisateur (activation préservée).
    zone.onclick = () => input.click();
    clearBtn.onclick = () => { input.value = ""; clearError(); setFile(null, null); };

    render();

    Object.defineProperty(wrap, "file", { get() { return current; }, configurable: true });
    Object.defineProperty(wrap, "mime", { get() { return currentMime; }, configurable: true });
    wrap.clear = () => { input.value = ""; clearError(); setFile(null, null); };
    // `focus()` porte sur la zone cliquable (parité avec les contrôles qui exposent focus()).
    wrap.focus = () => zone.focus();
    return wrap;
  }
}
