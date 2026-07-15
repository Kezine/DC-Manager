import { PveHttp, PveHttpError } from "./PveHttp.js";
import type { ProviderConfig } from "./VmProvider.js";

/* =============================================================================
   POOL DE NŒUDS PROXMOX — bascule sur défaillance (module `vm/` amovible).
   L'API Proxmox répond sur CHAQUE nœud du cluster : ce pool essaie les
   endpoints DANS L'ORDRE de la config et bascule quand un nœud est en panne
   (exigence 2026-07-13 : palier à la défaillance d'un nœud).

   Règles de bascule (portées par PveHttpError.retryable) :
   - erreurs de JOIGNABILITÉ (réseau, DNS, délai, TLS/épinglage) → nœud suivant ;
   - erreurs APPLICATIVES (auth refusée, statut HTTP, non-JSON) → REJET IMMÉDIAT :
     elles sont cluster-wide (même jeton partout), basculer masquerait le
     vrai problème sans jamais réussir.

   PRÉFÉRENCE COLLANTE : l'indice du dernier nœud AYANT RÉPONDU devient le point
   de départ des appels suivants. Sans elle, une synchro (2 appels cluster-wide
   + 1–2 par VM) repaierait le DÉLAI COMPLET du nœud mort à CHAQUE requête ;
   avec elle, la panne coûte au plus `timeout_sec` une fois par passe.

   Ce pool satisfait STRUCTURELLEMENT l'interface `PveJsonClient` de
   ProxmoxAdapter (aucun import croisé — le consommateur définit son besoin).
   ============================================================================= */

/** Le strict nécessaire d'un client de nœud (PveHttp le satisfait ; stub en test). */
export interface PveNodeClient {
  getJson(path: string): Promise<any>;
}

export class PveHttpPool {
  /** Indice du dernier nœud ayant répondu — point de départ du prochain appel. */
  private preferred = 0;

  /** @param clients Un client par endpoint, DANS L'ORDRE de la config (≥ 1). */
  constructor(private readonly clients: PveNodeClient[]) {
    if (clients.length === 0) throw new Error("PveHttpPool : au moins un endpoint requis");
  }

  /** Construction standard depuis la config : un PveHttp par endpoint (empreinte TLS PAR NŒUD —
      chaque nœud Proxmox porte son propre certificat), délai commun, et CA du cluster COMMUNE
      (`ca_pem` : niveau 2 de la hiérarchie de confiance, valable pour tout le pool ; l'empreinte
      de l'endpoint reste prioritaire — cf. PveHttp.trustOptions). */
  static fromConfig(config: ProviderConfig): PveHttpPool {
    return new PveHttpPool(config.endpoints.map((endpoint) =>
      new PveHttp(endpoint.url, config.token, endpoint.fingerprint, config.timeout_sec * 1000, config.ca_pem)));
  }

  /** GET JSON avec bascule : essaie à partir du nœud préféré, passe au suivant sur
      défaillance de joignabilité, rejette immédiatement sur erreur applicative.
      Tous les nœuds injoignables → erreur agrégée (dernier échec cité). */
  async getJson(path: string): Promise<any> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.clients.length; attempt++) {
      const index = (this.preferred + attempt) % this.clients.length;
      try {
        const result = await this.clients[index].getJson(path);
        this.preferred = index; // ce nœud répond → les appels suivants commencent ici
        return result;
      } catch (e) {
        if (e instanceof PveHttpError && !e.retryable) throw e; // applicatif → bascule inutile
        lastError = e; // joignabilité (ou erreur non typée d'un stub) → nœud suivant
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    // La CAUSE (dernier échec, pile d'origine comprise) est transportée : sans elle le log
    // ne montrerait que la pile du pool — inutilisable pour un bug interne de Node.
    throw new PveHttpError("Proxmox : aucun nœud joignable (" + this.clients.length + " essayé(s)) — dernier échec : " + detail, true, lastError);
  }
}
