import { Id } from "../core/Id";

/* =============================================================================
   OUVERTURE EXCLUSIVE multi-onglets via BroadcastChannel.
   Chaque document porte un `fileId` durable (meta.fileId). À l'ouverture d'un
   fichier, on diffuse un « claim » sur le canal et on attend brièvement un
   « claimed » : si un AUTRE onglet détient déjà ce fileId, l'ouverture est
   refusée (édition concurrente du même fichier interdite). À la fermeture (ou au
   remplacement du document), l'onglet « libère » ses fileIds (« bye »).
   Dégradable : sans BroadcastChannel (vieux navigateur) ou en mode download,
   tout est considéré « libre » (aucun verrou).
   ============================================================================= */
const CHANNEL_NAME = "dc-manager-tabs";
const CLAIM_TIMEOUT_MS = 300;

interface ClaimMsg { type: "claim" | "claimed" | "bye"; from: string; to?: string; fileId?: string; fileIds?: string[]; }

export class TabChannel {
  private chan: BroadcastChannel | null = null;
  private readonly instanceId = Id.uid();
  private readonly claimed = new Set<string>();
  private pendingResolve: ((occupied: boolean) => void) | null = null;
  private pendingFileId: string | null = null;
  private onConflict?: (fileId: string) => void;

  /** `enabled:false` (ex. mode download / lecture seule) → verrou inactif. */
  constructor(opts: { enabled?: boolean; onConflict?: (fileId: string) => void } = {}) {
    this.onConflict = opts.onConflict;
    if (opts.enabled === false) return;
    if (typeof BroadcastChannel === "undefined") return;
    this.chan = new BroadcastChannel(CHANNEL_NAME);
    this.chan.addEventListener("message", (e) => this.onMessage(e as MessageEvent));
    window.addEventListener("beforeunload", () => {
      if (this.chan && this.claimed.size) { try { this.send({ type: "bye", from: this.instanceId, fileIds: [...this.claimed] }); } catch (_) { /* noop */ } }
    });
  }

  private send(msg: ClaimMsg): void { if (this.chan) { try { this.chan.postMessage(msg); } catch (e) { console.warn("TabChannel send", e); } } }

  private onMessage(e: MessageEvent): void {
    const msg = e && (e.data as ClaimMsg);
    if (!msg || typeof msg !== "object" || msg.from === this.instanceId) return;
    if (msg.type === "claim") this.handleClaim(msg);
    else if (msg.type === "claimed") this.handleClaimed(msg);
    // "bye" : chaque onglet ne suit que SES fileIds → rien à faire.
  }
  private handleClaim(msg: ClaimMsg): void {
    if (!msg.fileId) return;
    if (this.claimed.has(msg.fileId)) { this.send({ type: "claimed", from: this.instanceId, to: msg.from, fileId: msg.fileId }); this.onConflict?.(msg.fileId); }
  }
  private handleClaimed(msg: ClaimMsg): void {
    if (msg.to !== this.instanceId || msg.fileId !== this.pendingFileId) return;
    if (this.pendingResolve) { const r = this.pendingResolve; this.pendingResolve = null; this.pendingFileId = null; r(true); }
  }

  /** Diffuse un claim et attend CLAIM_TIMEOUT_MS un claimed. true = occupé (autre onglet) · false = libre. */
  private tryClaim(fileId: string): Promise<boolean> {
    if (!this.chan) return Promise.resolve(false);
    if (this.pendingResolve) { const r = this.pendingResolve; this.pendingResolve = null; this.pendingFileId = null; r(false); }
    this.pendingFileId = fileId;
    const p = new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve;
      setTimeout(() => { if (this.pendingResolve === resolve) { this.pendingResolve = null; this.pendingFileId = null; resolve(false); } }, CLAIM_TIMEOUT_MS);
    });
    this.send({ type: "claim", from: this.instanceId, fileId });
    return p;
  }

  /** Revendique le fileId d'un document entrant AVANT toute mutation. Lance une erreur
      `code:"FILE_ALREADY_OPEN"` s'il est détenu ailleurs. Libère l'ancien document détenu. */
  async claimIncoming(incomingFileId: string | null, currentFileId: string | null): Promise<void> {
    if (incomingFileId) {
      const occupied = await this.tryClaim(incomingFileId);
      if (occupied) { const err: any = new Error("Ce fichier est déjà en cours d'édition dans un autre onglet."); err.code = "FILE_ALREADY_OPEN"; throw err; }
    }
    if (currentFileId && this.claimed.has(currentFileId) && currentFileId !== incomingFileId) this.release(currentFileId);
  }

  /** Marque le document courant comme détenu par cet onglet (après ouverture/enregistrement réussi). */
  claim(fileId: string | null): void { if (fileId) this.claimed.add(fileId); }

  /** Libère un fileId (et l'annonce aux autres onglets). */
  release(fileId: string | null): void {
    if (!fileId || !this.claimed.has(fileId)) return;
    this.claimed.delete(fileId);
    this.send({ type: "bye", from: this.instanceId, fileIds: [fileId] });
  }
}
