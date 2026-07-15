import type { VmRecord } from "./VmProvider.js";
import { VmSync, VM_SOURCE_FIELDS } from "../../../src-shared/VmSync.js";
import type { VmSourceFields } from "../../../src-shared/VmSync.js";

/* =============================================================================
   RÉCONCILIATION VM — module `vm/` amovible. Fonction PURE : (inventaire pivot,
   vms existantes du document) → opérations {créations, mises à jour, orphelines}
   à appliquer par le chemin d'écriture transactionnel du serveur (T2.2).

   Sémantique (décisions de cadrage) :
   - clé de réconciliation = `ext_id`, PÉRIMÈTRE = une instance de provider :
     seules les vms du document portant CE provider_id participent (un document
     multi-clusters ne marque pas orphelines les vms des AUTRES instances) ;
   - la synchro n'écrase QUE les champs SOURCE (liste partagée VM_SOURCE_FIELDS,
     src-shared/VmSync.ts) — les enrichissements locaux (notes, groupes,
     description) ne sont JAMAIS touchés ;
   - `host_equipment_id` est un champ DÉRIVÉ par la synchro (décision 2026-07-13 :
     la synchro est la SOURCE DE VÉRITÉ de l'hôte, plus d'édition utilisateur) :
     re-résolu à CHAQUE passe par correspondance de NOM du nœud — une VM migrée
     suit son nœud, un nœud sans équipement homonyme donne null (on n'invente
     pas) ; la résolution est INJECTÉE (aucun accès au document ici) ;
   - disparue de l'inventaire → `orphan: true` (JAMAIS de suppression auto :
     l'utilisateur a pu enrichir la vm) ; réapparue → `orphan: false` ;
   - IDEMPOTENCE : patchs MINIMAUX (champ à champ sur valeurs normalisées) ;
     `last_sync` n'est posé QUE sur une écriture réelle — re-synchroniser un
     inventaire inchangé ne produit AUCUNE op (pas de bruit de rev/SSE/undo).
   ============================================================================= */

/** Enregistrement générique du document (le serveur manipule du JSON brut). */
type Rec = { [k: string]: any };

export interface VmReconcileInput {
  /** Instance de provider réconciliée (ProviderConfig.id) — délimite le périmètre. */
  providerId: string;
  /** Inventaire NORMALISÉ remonté par l'adaptateur (inventory().vms). */
  records: VmRecord[];
  /** Vms ACTUELLES du document (toutes instances confondues — le plan filtre). */
  existingVms: Rec[];
  /** Résolution nom de nœud → id d'équipement DC Manager (injectée : correspondance par
      nom, insensibilité à la casse et repli au choix de l'appelant). null = pas trouvé. */
  resolveHostEquipmentId: (nodeName: string) => string | null;
  /** Générateur d'id pour les créations (injecté : uuid côté serveur, séquence en test). */
  newId: () => string;
  /** Horodatage ISO de CETTE synchro (injecté : Date côté serveur, fixe en test). */
  nowIso: string;
}

export interface VmReconcileOps {
  /** Enregistrements COMPLETS à créer (champs source + locaux par défaut). */
  creates: Rec[];
  /** Patchs MINIMAUX (champs source modifiés uniquement) sur des vms existantes. */
  updates: { id: string; patch: Rec }[];
  /** Vms disparues de l'inventaire à marquer orphelines (patch dédié — jamais delete). */
  orphans: { id: string; patch: Rec }[];
  /** Vms de l'inventaire déjà à jour (observabilité : endpoint de statut T2.2). */
  unchanged: number;
}

export class VmReconcile {
  /** Calcule le plan d'opérations — PUR : ne touche ni document, ni réseau, ni horloge. */
  static plan(input: VmReconcileInput): VmReconcileOps {
    const ops: VmReconcileOps = { creates: [], updates: [], orphans: [], unchanged: 0 };

    // Périmètre : les vms de CETTE instance uniquement (multi-clusters par document).
    const mine = input.existingVms.filter((v) => v && v.provider_id === input.providerId);
    const byExtId = new Map<string, Rec>();
    for (const vm of mine) {
      // Doublon d'ext_id (ne devrait pas exister — la réconciliation n'en crée jamais) :
      // le premier gagne, le doublon reste inerte (ni mis à jour, ni orphelin) — tolérance.
      if (typeof vm.ext_id === "string" && vm.ext_id !== "" && !byExtId.has(vm.ext_id)) byExtId.set(vm.ext_id, vm);
    }

    const seen = new Set<string>();
    for (const record of input.records) {
      // Garde-fou : l'adaptateur estampille provider_id — un record d'une autre instance
      // (bug d'appelant) est écarté plutôt que de polluer le périmètre.
      if (record.provider_id !== input.providerId) continue;
      const desired = VmReconcile.sourceFromRecord(record, input.nowIso);
      if (desired.ext_id === "") continue; // sans clé de réconciliation → inexploitable
      if (seen.has(desired.ext_id)) continue; // doublon d'inventaire (défensif) → premier gagne
      seen.add(desired.ext_id);

      const existing = byExtId.get(desired.ext_id);
      if (!existing) {
        ops.creates.push(VmReconcile.buildCreate(desired, input));
        continue;
      }

      // Diff champ à champ sur états NORMALISÉS des deux côtés : élimine les faux écarts
      // (champ absent du doc vs défaut, "2" vs 2…). `last_sync` est exclu du diff — il ne
      // constitue jamais À LUI SEUL une raison d'écrire (idempotence).
      const current = VmSync.normalizeSource(existing);
      const patch: Rec = {};
      for (const field of VM_SOURCE_FIELDS) {
        if (field === "last_sync") continue;
        if (!VmSync.sourceEquals(current, desired, field)) patch[field] = desired[field];
      }
      // (`orphan` est un champ source : une vm réapparue — orphan true → false — est
      // couverte par la boucle ci-dessus, sans cas particulier.)

      // HÔTE DÉRIVÉ (décision 2026-07-13) : re-résolu à chaque passe depuis le nom du nœud,
      // diffé comme un champ source (idempotence : même résolution → pas d'op). Migration de
      // VM → l'hôte suit ; nœud inconnu des équipements → null (jamais de valeur inventée).
      const currentHost = existing.host_equipment_id || null;
      const desiredHost = desired.host_node !== "" ? input.resolveHostEquipmentId(desired.host_node) : null;
      if (currentHost !== desiredHost) patch.host_equipment_id = desiredHost;

      if (Object.keys(patch).length === 0) { ops.unchanged++; continue; }
      patch.last_sync = input.nowIso; // écriture réelle → la vm est « touchée par la synchro »
      ops.updates.push({ id: existing.id, patch });
    }

    // Disparues : dans le document (ce provider) mais absentes de l'inventaire.
    for (const vm of mine) {
      if (typeof vm.ext_id === "string" && seen.has(vm.ext_id)) continue;
      if (vm.orphan === true) { ops.unchanged++; continue; } // déjà marquée — idempotence
      ops.orphans.push({ id: vm.id, patch: { orphan: true, last_sync: input.nowIso } });
    }

    return ops;
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Pivot d'adaptateur → champs SOURCE du document. Seul point de MAPPAGE de noms :
      `description` (pivot) → `description_src` (le doc réserve `description`, héritée
      d'Entity, à l'enrichissement local) et `tags` → `tags_src`. Le tout normalisé
      par la définition partagée (mêmes valeurs que produirait le modèle client). */
  private static sourceFromRecord(record: VmRecord, nowIso: string): VmSourceFields {
    return VmSync.normalizeSource({
      ext_id: record.ext_id,
      provider_id: record.provider_id,
      vm_type: record.vm_type,
      name: record.name,
      description_src: record.description,
      status: record.status,
      host_node: record.host_node,
      cpu: record.cpu,
      ram_mb: record.ram_mb,
      disk_gb: record.disk_gb,
      tags_src: record.tags,
      nics: record.nics,
      orphan: false, // présente à l'inventaire par définition
      last_sync: nowIso,
    });
  }

  /** Enregistrement COMPLET d'une vm neuve : champs source + LOCAUX par défaut (dont
      l'hôte DÉRIVÉ du nom de nœud — même résolution qu'à chaque passe de synchro). */
  private static buildCreate(desired: VmSourceFields, input: VmReconcileInput): Rec {
    return {
      id: input.newId(),
      created_date: input.nowIso,
      updated_date: input.nowIso,
      ...desired,
      /* locaux — défauts du modèle (enrichis ensuite par l'utilisateur, jamais par la synchro) */
      description: "",
      notes: "",
      host_equipment_id: desired.host_node !== "" ? input.resolveHostEquipmentId(desired.host_node) : null,
      group_id: null,
      group_ids: [],
    };
  }
}
