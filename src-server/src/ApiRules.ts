/* ============================================================================
   RÈGLES PURES de la couche HTTP (api.ts) — extraites pour être TESTABLES sans
   Express ni SQLite (cf. Tests/modules/run.js) : api.ts ne garde que le câblage
   HTTP (req/res), ces méthodes portent la LOGIQUE.

   Couvre : le CIBLAGE du verrou optimiste (writeTargets), le PÉRIMÈTRE de
   rechargement granulaire (buildChangeset), la CRÉATION STRICTE d'un lot
   (createConflicts) et la CASCADE RÉSIDUELLE d'un /transact (residualCascade).
   Toutes les capacités d'accès aux données sont INJECTÉES (fetch/find), comme
   pour la validation et la cascade partagées.
   ============================================================================ */
import { Cascade } from "../../shared/Cascade.js";
import type { DocumentChangeset } from "../../shared/DocumentChangeset.js";
import type { EntityFetcher, ChildFinder } from "../../shared/DataValidation.js";

/** Entité visée par une écriture (verrou optimiste par entité). */
export interface WriteTarget { collection: string; id: string }
/** Cascade résiduelle d'un lot : suppressions et détachements MANQUANTS à fusionner au lot. */
export interface ResidualPlan { deletes: WriteTarget[]; updates: Array<{ collection: string; record: Record<string, any> }> }

export class ApiRules {
  /** Entités VISÉES par une écriture (pour le verrou optimiste) : lot `/transact` (updates + deletes) ou CRUD
      unitaire `/:collection/:id`. Les créations (id neuf) et les écritures globales (meta / snapshot / images)
      ne ciblent aucune ligne existante → liste vide → pas de garde. */
  static writeTargets(body: any, params: { collection?: string; id?: string }): WriteTarget[] {
    const out: WriteTarget[] = [];
    const b: any = body || {};
    if (Array.isArray(b.updates) || Array.isArray(b.deletes)) {
      for (const u of b.updates || []) if (u && u.collection && u.record && u.record.id) out.push({ collection: u.collection, id: u.record.id });
      for (const d of b.deletes || []) if (d && d.collection && d.id) out.push({ collection: d.collection, id: d.id });
      return out;
    }
    if (params && params.collection && params.id) out.push({ collection: params.collection, id: params.id });
    return out;
  }

  /** Périmètre d'une écriture, pour le rechargement granulaire des autres clients. Déduit du corps (`/transact`),
      de la collection de route (CRUD `/:collection/:id`) ou du chemin (`/meta`, `/snapshot`, `/images`). Périmètre
      non reconnu → `full` (repli sûr : le client recharge tout). */
  static buildChangeset(body: any, collection: string | undefined, path: string): DocumentChangeset {
    const b: any = body || {};
    // Lot atomique : union des collections de creates + updates + deletes.
    if (Array.isArray(b.creates) || Array.isArray(b.updates) || Array.isArray(b.deletes)) {
      const collections = new Set<string>();
      for (const entry of [...(b.creates || []), ...(b.updates || []), ...(b.deletes || [])]) {
        if (entry && entry.collection) collections.add(entry.collection);
      }
      return { full: false, collections: [...collections], meta: !!b.meta, images: false };
    }
    // CRUD unitaire : la collection est dans les paramètres de route.
    if (collection) return { full: false, collections: [collection], meta: false, images: false };
    // Routes globales (sans paramètre de collection) — reconnues par le chemin (relatif au sous-routeur du document).
    const p = path || "";
    if (p.startsWith("/snapshot")) return { full: true, collections: [], meta: true, images: true };
    if (p.startsWith("/meta")) return { full: false, collections: [], meta: true, images: false };
    if (p.startsWith("/images")) return { full: false, collections: [], meta: false, images: true };
    return { full: true, collections: [], meta: true, images: true };   // inconnu → repli sûr
  }

  /** CRÉATION STRICTE d'un lot : les `creates` dont l'id existe DÉJÀ (et que le lot ne supprime pas au préalable —
      transact applique deletes puis creates) écraseraient l'enregistrement HORS verrou optimiste (`writeTargets`
      ne cible pas les créations). Renvoie les collisions → l'appelant répond 409. `fetch` = état PERSISTÉ (pas le
      lecteur conscient du lot : il masquerait la ligne existante derrière le contenu du create). */
  static createConflicts(creates: any[], deletes: any[], fetch: EntityFetcher): WriteTarget[] {
    const deletedInBatch = new Set<string>((deletes || []).filter((d: any) => d && d.collection && d.id).map((d: any) => d.collection + " " + d.id));
    const out: WriteTarget[] = [];
    for (const entry of creates || []) {
      if (!entry || !entry.collection || !entry.record || !entry.record.id) continue;
      if (deletedInBatch.has(entry.collection + " " + entry.record.id)) continue;
      if (fetch(entry.collection, entry.record.id)) out.push({ collection: entry.collection, id: entry.record.id });
    }
    return out;
  }

  /** CASCADE RÉSIDUELLE d'un lot `/transact` (autorité serveur — même garantie que le DELETE unitaire) : le client
      packagé envoie la cascade calculée sur SON instantané ; si le document a bougé entre-temps (ex. un câble
      branché par un autre client sur un port que ce lot supprime), le lot laisserait des FK pendantes. Avec des
      lecteurs CONSCIENTS DU LOT (état post-lot), `Cascade.plan` ne renvoie que le travail MANQUANT.
      GARDE ANTI-RÉSURRECTION : transact applique deletes PUIS updates — un update sur un record supprimé par le
      lot (ou par la cascade résiduelle) le RECRÉERAIT ; tout détachement d'un record supprimé est donc écarté.
      Détachements FUSIONNÉS par enregistrement : un même record peut recevoir plusieurs clés (cf. Api.remove). */
  static residualCascade(deletes: any[], find: ChildFinder, fetch: EntityFetcher): ResidualPlan {
    const batchDeletes: WriteTarget[] = (deletes || []).filter((d: any) => d && d.collection && d.id);
    const extraDeletes: WriteTarget[] = [];
    const deleted = new Set<string>(batchDeletes.map((d) => d.collection + " " + d.id));
    const patched = new Map<string, { collection: string; record: Record<string, any> }>();
    for (const d of batchDeletes) {
      const plan = Cascade.plan(d.collection, d.id, find, fetch);
      for (const x of plan.deletes) {
        const key = x.c + " " + x.id;
        if (deleted.has(key)) continue;
        deleted.add(key);
        extraDeletes.push({ collection: x.c, id: x.id });
      }
      for (const det of plan.detaches) {
        const key = det.c + " " + det.id;
        let entry = patched.get(key);
        if (!entry) { const rec = fetch(det.c, det.id); if (!rec) continue; entry = { collection: det.c, record: { ...rec } }; patched.set(key, entry); }
        entry.record[det.key] = det.value;
      }
    }
    const updates = [...patched.entries()].filter(([key]) => !deleted.has(key)).map(([, entry]) => entry);
    return { deletes: extraDeletes, updates };
  }
}
