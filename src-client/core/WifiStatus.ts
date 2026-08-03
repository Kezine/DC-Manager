/* =============================================================================
   WifiStatus — ÉTAT de présence d'un client wifi : classification, couleur, clé
   de tri et PASTILLE. Classe PURE : aucun DOM, aucun store, aucun réseau.

   POURQUOI CE MODULE (principes n°2/n°3) : la même règle est lue par le LISTING
   (`ListConfigs.wifiClients`), la FICHE (`DetailForms.wifiClientDetail`) et la
   PALETTE de recherche (`GlobalSearchSources`). C'est exactement la duplication
   que `core/VmStatus` a eu à résorber APRÈS coup, en trois exemplaires ; on ne la
   recrée pas ici.

   ── LE POINT DE VOCABULAIRE QUI COMPTE (décision D2 du cadrage) ───────────────
   Le champ persisté s'appelle `orphan` — MÊME mécanique que les VMs (patch, jamais
   de suppression, réapparition couverte), ce qui permet de partager toute la chaîne
   de synchro. Mais le SENS n'est pas le même : l'API d'un contrôleur wifi ne liste
   que les clients CONNECTÉS, donc disparaître de l'inventaire est un événement
   QUOTIDIEN, pas un incident. D'où : mécanique `orphan`, libellé « déconnecté »,
   et une couleur d'AVERTISSEMENT (var(--warn)) plutôt que d'ERREUR — un client
   parti n'est pas une anomalie à corriger. Ce module est le seul endroit où cette
   traduction mécanique → vocabulaire est écrite.

   ÉCHAPPEMENT : la pastille est posée en `innerHTML`. Tout ce qui sort d'ici est
   du HTML SÛR — le libellé vient d'I18n (échappé), les couleurs sont un ensemble
   FERMÉ de constantes internes : AUCUNE donnée du contrôleur n'entre dans un
   attribut `style`.

   FEATURE WIFI AMOVIBLE : supprimer l'inventaire des clients wifi = supprimer ce
   fichier avec `WifiLocate` et les blocs wifi de `ListConfigs`/`DetailForms`
   (cf. docs/wifi-unifi.md § « Suppression de la feature »).
   ============================================================================= */
import { Html } from "./Html";
import { I18n } from "../i18n/I18n";

/** Vue MINIMALE d'un client wifi — le module ne dépend NI du modèle `WifiClient`, NI du store.
    Forme TOLÉRANTE (champs optionnels) : les enregistrements arrivent d'une synchro tierce. */
export interface WifiStatusClient {
  /** Client absent du dernier inventaire = DÉCONNECTÉ (cf. en-tête, décision D2). */
  orphan?: boolean;
  /** Nature du raccordement telle que remontée (« wireless »/« wired »/valeur inconnue). */
  client_type?: string | null;
}

export class WifiStatus {
  /** Couleur du « déconnecté » : AVERTISSEMENT et non ERREUR — un client parti est normal
      (cf. en-tête). C'est la seule différence visuelle assumée avec l'orphelinat des VMs. */
  static readonly COLOR_DISCONNECTED = "var(--warn)";
  /** Rendu du « pas de valeur » — MÊME chaîne que le `dim("—")` des listings et que `DetailForms.MUTED`. */
  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  /** Le client est-il absent du dernier inventaire (= déconnecté) ? */
  static isDisconnected(client: WifiStatusClient | null | undefined): boolean {
    return !!(client && client.orphan);
  }

  /** Type de raccordement BRUT (rogné), "" si absent. Affiché TEL QUEL, jamais traduit : chaque
      marque a son vocabulaire (« WIRELESS », « wired », …) et le montrer vaut mieux que le masquer
      derrière une énumération que la prochaine release démentira. */
  static rawType(client: WifiStatusClient | null | undefined): string {
    return client && typeof client.client_type === "string" ? client.client_type.trim() : "";
  }

  /** Clé de tri de la colonne de présence : connectés d'abord, déconnectés groupés à part. */
  static sortKey(client: WifiStatusClient | null | undefined): string {
    return WifiStatus.isDisconnected(client) ? "1" : "0";
  }

  /** Pastille « déconnecté » seule, suivie d'une ESPACE séparatrice — "" si le client est connecté.
      `title` est l'infobulle facultative : la FICHE en pose une (elle a la place d'EXPLIQUER que
      le client reste enregistré et reviendra tout seul), le LISTING non (colonne étroite, pastille
      répétée à chaque ligne). Même partage des rôles que `VmStatus.orphanPill`. */
  static disconnectedPill(client: WifiStatusClient | null | undefined, title?: string): string {
    if (!WifiStatus.isDisconnected(client)) return "";
    const titleAttr = title ? ` title="${Html.escape(title)}"` : "";
    return `<span class="pill" style="border-color:${WifiStatus.COLOR_DISCONNECTED};color:${WifiStatus.COLOR_DISCONNECTED}"${titleAttr}>${Html.escape(I18n.t("lists.ph.disconnected"))}</span> `;
  }

  /** Pastille du TYPE de raccordement seule — HTML SÛR (valeur échappée). Sans type : le tiret
      discret, pas une pastille vide. */
  static typePill(client: WifiStatusClient | null | undefined): string {
    const type = WifiStatus.rawType(client);
    return type ? `<span class="pill">${Html.escape(type)}</span>` : WifiStatus.MUTED;
  }

  /** Rendu COMPLET de la colonne « Type » : présence EN TÊTE puis type de raccordement.
      Les deux sont rendus, jamais l'un À LA PLACE de l'autre : savoir qu'un client déconnecté
      était sans fil (et non filaire) est ce qui permet de le retrouver. */
  static pills(client: WifiStatusClient | null | undefined, disconnectedTitle?: string): string {
    return WifiStatus.disconnectedPill(client, disconnectedTitle) + WifiStatus.typePill(client);
  }
}
