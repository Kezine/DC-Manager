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
}

/** L'élément rendu expose la valeur choisie (`file`), son effacement et le focus (parité avec les autres
    contrôles de formulaire, qui exposent `.value`/`focus()`). */
export interface FilePickerElement extends HTMLDivElement {
  /** Fichier VALIDE actuellement choisi, ou null (rien de choisi, ou dernière sélection rejetée). */
  file: File | null;
  /** Réinitialise le contrôle (aucun fichier, message effacé). */
  clear(): void;
}

export class FilePicker {
  static build(opts: FilePickerOptions): FilePickerElement {
    const accept = opts.accept || [];
    const isValid = opts.isValidMime || ((type: string) => accept.includes(String(type || "")));

    const wrap = document.createElement("div") as FilePickerElement;
    wrap.className = "file-picker";
    wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";

    // Input RÉEL, masqué mais présent dans le DOM (activation utilisateur préservée — cf. en-tête).
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept.join(",");
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

    const setFile = (file: File | null): void => {
      current = file;
      render();
    };

    // Validation à la SÉLECTION : type d'abord (anti-XSS stocké, cf. liste blanche), puis taille.
    input.onchange = () => {
      const chosen = input.files && input.files[0] ? input.files[0] : null;
      if (!chosen) return;   // dialogue annulé : on garde l'état précédent
      if (!isValid(chosen.type)) {
        setFile(null);
        showError(I18n.t("ui.filePicker.badType"));
        input.value = "";   // permet de re-choisir le MÊME fichier après correction
        return;
      }
      if (opts.maxBytes != null && chosen.size > opts.maxBytes) {
        setFile(null);
        showError(I18n.t("ui.filePicker.tooBig", { max: Format.bytes(opts.maxBytes) }));
        input.value = "";
        return;
      }
      clearError();
      setFile(chosen);
    };

    // Clic sur la zone → ouverture du dialogue, DANS le geste utilisateur (activation préservée).
    zone.onclick = () => input.click();
    clearBtn.onclick = () => { input.value = ""; clearError(); setFile(null); };

    render();

    Object.defineProperty(wrap, "file", { get() { return current; }, configurable: true });
    wrap.clear = () => { input.value = ""; clearError(); setFile(null); };
    // `focus()` porte sur la zone cliquable (parité avec les contrôles qui exposent focus()).
    wrap.focus = () => zone.focus();
    return wrap;
  }
}
