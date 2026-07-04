import type { Response } from "express";
import { Logger } from "./logger.js";

/* Canal LIVE (Server-Sent Events) par document : notifie les autres clients
   d'un changement (nouvelle révision) pour qu'ils rechargent. */
export class LiveBus {
  private readonly subs = new Map<string, Set<Response>>();

  constructor(private readonly log: Logger) {}

  /** Abonne une réponse SSE aux événements d'un document (désabonnement à la fermeture). */
  subscribe(docId: string, res: Response): void {
    let set = this.subs.get(docId);
    if (!set) { set = new Set(); this.subs.set(docId, set); }
    set.add(res);
    // HEARTBEAT : un commentaire SSE périodique (ligne « : … », ignorée par EventSource). Sans trafic, les
    // proxys/keep-alive coupent les connexions muettes, et un socket mort côté client resterait compté ici
    // jusqu'au timeout TCP ; le ping maintient le flux vivant ET fait détecter la fermeture (write → close).
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* le close() qui suit désabonne */ } }, 30_000);
    const drop = () => { clearInterval(ping); const s = this.subs.get(docId); if (s) { s.delete(res); if (!s.size) this.subs.delete(docId); } };
    res.on("close", drop);
    this.log.debug("SSE abonné", docId, "(" + set.size + ")");
  }

  /** Diffuse un événement JSON à tous les abonnés d'un document. */
  publish(docId: string, data: unknown): void {
    const set = this.subs.get(docId);
    if (!set || !set.size) return;
    const payload = "data: " + JSON.stringify(data) + "\n\n";
    for (const res of set) { try { res.write(payload); } catch { /* client déconnecté */ } }
    this.log.debug("SSE publish", docId, data, "→ " + set.size + " client(s)");
  }
}
