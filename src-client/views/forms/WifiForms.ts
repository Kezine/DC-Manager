import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { WifiClient } from "../../models/WifiClient";
import { WifiSyncError } from "./WifiSyncClient";
import type { WifiSyncClient, WifiProviderStatus } from "./WifiSyncClient";
import type { FormHost } from "./shared";
import { I18n } from "../../i18n/I18n";

/* =============================================================================
   FORMULAIRES DE LA FEATURE « CLIENTS WIFI » (AMOVIBLE) — édition des champs
   LOCAUX + action de synchronisation.

   Classe DÉDIÉE et AUTONOME (hors chaîne d'héritage `Forms`, à côté de
   `WifiProvidersForm`) : la retirer = supprimer ce fichier + le branchement
   `extraActions` de l'onglet Wifi, sans cicatrice dans les autres formulaires
   (exigence transverse « feature amovible »).

   AGNOSTIQUE DE MARQUE (décision D9) : rien ici ne nomme un constructeur — ni les
   libellés, ni les messages. La marque ne vit que dans l'adaptateur serveur.
   ============================================================================= */
export class WifiForms {
  /** Formulaire d'ÉDITION d'un client wifi — n'expose QUE les enrichissements LOCAUX réellement
      éditables : `description` et `notes` (frontière source/locaux, cf. src-shared/WifiSync).
      Le POINT D'ACCÈS (`ap_equipment_id`) est un champ DÉRIVÉ, re-résolu à chaque synchro depuis
      `ap_name` → NON éditable ici (l'éditer serait écrasé à la passe suivante, ce qui est pire
      qu'un champ absent). Les champs SOURCE (nom, MAC, IP, SSID, type…) viennent de la synchro.
      PAS de groupes : la collection n'en porte pas en v1 (décision D1).

      À l'enregistrement, le payload ne contient QUE description + notes : `store.update` FUSIONNE
      le patch dans l'existant, donc les champs source ET dérivés restent INTACTS. */
  static edit(store: Store, host: FormHost, id: string, onSaved?: () => void): void {
    const client: any = store.get("wifiClients", id);
    if (!client) { Notify.toast(I18n.t("wifi.edit.notFound"), "err"); return; }
    const root = document.createElement("div");

    // Bandeau explicite : SEULS les enrichissements locaux sont modifiables ici.
    const note = document.createElement("div"); note.className = "form-hint";
    note.textContent = I18n.t("wifi.edit.localOnly");
    root.appendChild(note);

    const descriptionInput = FormControls.textArea(client.description || "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descriptionInput, I18n.t("wifi.edit.descriptionHint")));
    const notesInput = FormControls.textArea(client.notes || "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.notes"), notesInput, I18n.t("wifi.edit.notesHint")));

    host.openModal({
      title: I18n.t("wifi.edit.title"),
      subtitle: Html.escape(WifiClient.displayName(client)),
      body: root, wide: true,
      onSave: async () => {
        // PAYLOAD = description + notes SEULEMENT → les champs source et dérivés ne figurent pas,
        // donc ne sont pas écrasés (fusion par store.update : un champ absent du patch reste intact).
        const ok = await store.update("wifiClients", id, {
          description: descriptionInput.value.trim(),
          notes: notesInput.value.trim(),
        });
        if (!ok) { Notify.toast(I18n.t("wifi.edit.saveRefused"), "err"); return false; }   // validation partagée → modale conservée
        host.setDirty?.(true); Notify.toast(I18n.t("wifi.edit.saved")); onSaved?.(); return true;
      },
    });
    setTimeout(() => descriptionInput.focus(), 30);
  }

  /* ============================================================================
     SYNCHRONISATION (mode API uniquement) — bouton « Synchroniser » de la barre
     d'outils de l'onglet Wifi, câblé depuis main.ts derrière la garde REST_MODE
     (masqué en mode fichier). Le RECHARGEMENT de la collection `wifiClients` n'est
     PAS géré ici : après une synchro qui écrit, le serveur émet son événement SSE
     (origin « wifi-sync ») → tous les clients rechargent en granulaire.
     ============================================================================ */

  /** Lance une synchro de TOUS les providers du document et notifie le résultat PAR provider.
      `btn` = le bouton de la barre d'outils : désactivé + libellé « Synchronisation… » le temps
      de l'appel (retour à l'état initial en `finally`, même en cas d'erreur). */
  static async sync(client: WifiSyncClient, btn: HTMLButtonElement): Promise<void> {
    const originalLabel = btn.textContent || I18n.t("wifi.sync.syncLabel");
    btn.disabled = true;
    btn.textContent = I18n.t("wifi.sync.syncing");
    try {
      const providers = await client.sync();
      if (!providers.length) {
        Notify.toast(I18n.t("wifi.common.noProvider"));
        return;
      }
      // Un toast PAR provider : succès = résumé des compteurs (message serveur) ; échec = erreur.
      providers.forEach((p) => Notify.toast(WifiForms.providerLine(p) + " : " + p.message, p.ok ? "ok" : "err"));
    } catch (e) {
      // 404 (document inconnu), 503 (feature désactivée + detail), panne réseau → toast détaillé.
      Notify.toast(I18n.t("wifi.sync.syncImpossible", { detail: WifiForms.errText(e) }), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  /* -------------------------------------------------------------------------- */

  /** Ligne d'identité d'un provider pour un toast : « id (kind) ». */
  private static providerLine(p: WifiProviderStatus): string {
    return p.provider_id + " (" + p.kind + ")";
  }

  /** Message d'erreur lisible : `WifiSyncError` porte code HTTP + `detail` serveur ; toute autre
      erreur (panne réseau…) remonte son `message` brut. */
  private static errText(e: unknown): string {
    if (e instanceof WifiSyncError) return e.message + (e.detail ? " — " + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
