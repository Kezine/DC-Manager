import type { WifiClientRecord } from "./WifiProvider.js";
import { WifiSync, WIFI_SOURCE_FIELDS } from "../../../src-shared/WifiSync.js";
import type { WifiSourceFields } from "../../../src-shared/WifiSync.js";

/* =============================================================================
   RÉCONCILIATION DES CLIENTS WIFI — module `wifi/` amovible. Fonction PURE :
   (inventaire pivot, clients existants du document) → opérations {créations,
   mises à jour, orphelins} à appliquer par le chemin d'écriture transactionnel.

   AGNOSTIQUE DE MARQUE (décision D9) : ce module ne connaît QUE le pivot
   `WifiClientRecord` et la frontière partagée `src-shared/WifiSync` — jamais un
   adaptateur, jamais UniFi. Ajouter une marque ne le touche pas.

   Sémantique (calquée sur `VmReconcile`, décisions de cadrage) :
   - clé de réconciliation = `ext_id`, PÉRIMÈTRE = une instance de provider :
     seuls les clients du document portant CE `provider_id` participent (un
     document multi-contrôleurs ne marque pas « déconnectés » ceux des AUTRES) ;
   - la synchro n'écrase QUE les champs SOURCE (liste partagée `WIFI_SOURCE_FIELDS`,
     src-shared/WifiSync.ts) — les enrichissements locaux (`notes`, `description`)
     ne sont JAMAIS touchés ;
   - `ap_equipment_id` est un champ DÉRIVÉ par la synchro (décision D4) : re-résolu
     à CHAQUE passe par correspondance de NOM du point d'accès — un client qui
     change d'AP suit son AP, un AP sans équipement homonyme donne null (on
     n'invente pas) ; la résolution est INJECTÉE (aucun accès au document ici) ;
   - disparu de l'inventaire → `orphan: true` (JAMAIS de suppression auto :
     l'utilisateur a pu enrichir l'enregistrement). ⚠ Côté wifi ce drapeau signifie
     « DÉCONNECTÉ » (décision D2) : l'API ne liste que les clients CONNECTÉS, un
     départ est quotidien. Réapparition → `orphan: false`, et `connected_since`
     distingue un vrai retour d'une présence continue ;
   - IDEMPOTENCE : patchs MINIMAUX (champ à champ sur valeurs normalisées) ;
     `last_sync` n'est posé QUE sur une écriture réelle — re-synchroniser un
     inventaire inchangé ne produit AUCUNE op (pas de bruit de rev/SSE/undo).
   ============================================================================= */

/** Enregistrement générique du document (le serveur manipule du JSON brut). */
type Rec = { [k: string]: any };

export interface WifiReconcileInput {
  /** Instance de provider réconciliée (`WifiProviderConfig.id`) — délimite le périmètre. */
  providerId: string;
  /** Inventaire NORMALISÉ remonté par l'adaptateur (`inventory().clients`). */
  records: WifiClientRecord[];
  /** Clients ACTUELS du document (toutes instances confondues — le plan filtre). */
  existingClients: Rec[];
  /** Résolution nom d'AP → id d'équipement DC Manager (injectée : correspondance par nom,
      insensibilité à la casse et arbitrage d'ambiguïté au choix de l'appelant). null = pas trouvé. */
  resolveApEquipmentId: (apName: string) => string | null;
  /** Générateur d'id pour les créations (injecté : uuid côté serveur, séquence en test). */
  newId: () => string;
  /** Horodatage ISO de CETTE synchro (injecté : Date côté serveur, fixe en test). */
  nowIso: string;
}

export interface WifiReconcileOps {
  /** Enregistrements COMPLETS à créer (champs source + locaux par défaut). */
  creates: Rec[];
  /** Patchs MINIMAUX (champs source modifiés uniquement) sur des clients existants. */
  updates: { id: string; patch: Rec }[];
  /** Clients disparus de l'inventaire à marquer « déconnectés » (patch dédié — jamais delete). */
  orphans: { id: string; patch: Rec }[];
  /** Clients de l'inventaire déjà à jour (observabilité : endpoint de statut). */
  unchanged: number;
}

export class WifiReconcile {
  /** Calcule le plan d'opérations — PUR : ne touche ni document, ni réseau, ni horloge. */
  static plan(input: WifiReconcileInput): WifiReconcileOps {
    const ops: WifiReconcileOps = { creates: [], updates: [], orphans: [], unchanged: 0 };

    // Périmètre : les clients de CETTE instance uniquement (multi-contrôleurs par document).
    const mine = input.existingClients.filter((c) => c && c.provider_id === input.providerId);
    const byExtId = new Map<string, Rec>();
    for (const client of mine) {
      // Doublon d'ext_id (ne devrait pas exister — la réconciliation n'en crée jamais) :
      // le premier gagne, le doublon reste inerte (ni mis à jour, ni orphelin) — tolérance.
      if (typeof client.ext_id === "string" && client.ext_id !== "" && !byExtId.has(client.ext_id)) byExtId.set(client.ext_id, client);
    }

    const seen = new Set<string>();
    for (const record of input.records) {
      // Garde-fou : l'adaptateur estampille provider_id — un record d'une autre instance
      // (bug d'appelant) est écarté plutôt que de polluer le périmètre.
      if (record.provider_id !== input.providerId) continue;
      const desired = WifiReconcile.sourceFromRecord(record, input.nowIso);
      if (desired.ext_id === "") continue;      // sans clé de réconciliation → inexploitable
      if (seen.has(desired.ext_id)) continue;   // doublon d'inventaire (défensif) → premier gagne
      seen.add(desired.ext_id);

      const existing = byExtId.get(desired.ext_id);
      if (!existing) {
        ops.creates.push(WifiReconcile.buildCreate(desired, input));
        continue;
      }

      // Diff champ à champ sur états NORMALISÉS des deux côtés : élimine les faux écarts
      // (champ absent du doc vs défaut, null vs ""…). `last_sync` est exclu du diff — il ne
      // constitue jamais À LUI SEUL une raison d'écrire (idempotence).
      const current = WifiSync.normalizeSource(existing);
      const patch: Rec = {};
      for (const field of WIFI_SOURCE_FIELDS) {
        if (field === "last_sync") continue;
        if (!WifiSync.sourceEquals(current, desired, field)) patch[field] = desired[field];
      }
      // (`orphan` est un champ source : un client REVENU — orphan true → false — est couvert
      // par la boucle ci-dessus, sans cas particulier.)

      // POINT D'ACCÈS DÉRIVÉ (décision D4) : re-résolu à chaque passe depuis le nom d'AP, diffé
      // comme un champ source (idempotence : même résolution → pas d'op). Client qui migre d'un
      // AP à l'autre → le rattachement suit ; AP inconnu des équipements → null (jamais inventé).
      const currentAp = existing.ap_equipment_id || null;
      const desiredAp = desired.ap_name !== "" ? input.resolveApEquipmentId(desired.ap_name) : null;
      if (currentAp !== desiredAp) patch.ap_equipment_id = desiredAp;

      if (Object.keys(patch).length === 0) { ops.unchanged++; continue; }
      patch.last_sync = input.nowIso;   // écriture réelle → le client est « touché par la synchro »
      ops.updates.push({ id: existing.id, patch });
    }

    // Disparus : dans le document (ce provider) mais absents de l'inventaire → DÉCONNECTÉS.
    for (const client of mine) {
      if (typeof client.ext_id === "string" && seen.has(client.ext_id)) continue;
      if (client.orphan === true) { ops.unchanged++; continue; }   // déjà marqué — idempotence
      ops.orphans.push({ id: client.id, patch: { orphan: true, last_sync: input.nowIso } });
    }

    return ops;
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Pivot d'adaptateur → champs SOURCE du document. Aucun mappage de NOM ici (contrairement
      aux VMs, dont `description`/`tags` deviennent `description_src`/`tags_src` : le document y
      réserve `description` à l'enrichissement local) — le pivot wifi ne remonte AUCUN champ dont
      le nom entre en collision avec un champ local. Le tout normalisé par la définition PARTAGÉE
      (mêmes valeurs que produirait le modèle client — sinon : faux deltas à chaque passe). */
  private static sourceFromRecord(record: WifiClientRecord, nowIso: string): WifiSourceFields {
    return WifiSync.normalizeSource({
      ext_id: record.ext_id,
      provider_id: record.provider_id,
      name: record.name,
      mac: record.mac,
      ip: record.ip,
      client_type: record.client_type,
      ssid: record.ssid,
      ap_mac: record.ap_mac,
      ap_name: record.ap_name,
      connected_since: record.connected_since,
      orphan: false,   // présent à l'inventaire par définition = CONNECTÉ
      last_sync: nowIso,
    });
  }

  /** Enregistrement COMPLET d'un client neuf : champs source + LOCAUX par défaut (dont l'AP
      DÉRIVÉ du nom remonté — même résolution qu'à chaque passe de synchro). */
  private static buildCreate(desired: WifiSourceFields, input: WifiReconcileInput): Rec {
    return {
      id: input.newId(),
      created_date: input.nowIso,
      updated_date: input.nowIso,
      ...desired,
      /* locaux — défauts du modèle (enrichis ensuite par l'utilisateur, jamais par la synchro) */
      notes: "",
      description: "",
      ap_equipment_id: desired.ap_name !== "" ? input.resolveApEquipmentId(desired.ap_name) : null,
    };
  }
}
