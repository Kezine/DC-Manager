import { createHash } from "node:crypto";
import type { Request } from "express";
import { Logger } from "./logger.js";

/* Authentification déléguée au SSO (SSO externe). L'app NE gère PAS l'auth :
   on proxifie le JETON (cookie nommé `cookieName`) au SSO `ssoUrl` qui répond
   avec l'utilisateur. On met en cache le résultat (clé = hash du jeton) tant
   que le cookie ne change pas ET que `expireDate` n'est pas dépassée.
   Accès autorisé uniquement si `logged && adminRight === "SUPER_ADMIN"`
   (la gestion fine des rôles viendra plus tard). */
export interface SsoUser { id?: number; login?: string; nom?: string; prenom?: string; eMail?: string; domain?: string; [k: string]: any }
export interface SsoResult { user?: SsoUser; logged: boolean; adminRight?: string; expireDate?: number; dev?: boolean; [k: string]: any }

const ANON: SsoResult = { user: { login: "anonymous", domain: "anonymous" }, logged: false, adminRight: "NONE" };

export interface AuthOptions { ssoUrl?: string; cookieName?: string; devUser?: string | null }

export class Auth {
  private readonly cache = new Map<string, { result: SsoResult; expireAt: number }>();
  private readonly ssoUrl: string;
  private readonly cookieName: string;
  private readonly devUser: string | null;

  constructor(private readonly log: Logger, opts: AuthOptions = {}) {
    this.ssoUrl = (opts.ssoUrl || "").trim();
    this.cookieName = (opts.cookieName || "").trim();
    this.devUser = opts.devUser ?? null;
    this.log.info("auth", this.ssoUrl ? ("SSO " + this.ssoUrl + (this.cookieName ? " (cookie " + this.cookieName + ")" : " (Cookie complet)")) : "mode DEV (pas de SSO_URL)");
  }

  /** Validation de la session (cache par hash de jeton + expireDate). */
  async validate(req: Request): Promise<SsoResult> {
    if (!this.ssoUrl) return this.devResult();                 // pas de SSO configuré → mode dev
    const token = this.tokenOf(req);
    if (!token) return ANON;                                   // aucun cookie → anonyme
    const key = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now < hit.expireAt) return hit.result;          // même cookie, non expiré → cache
    const result = await this.fetchSso(token);
    const expireAt = this.expiryOf(result, now);
    this.cache.set(key, { result, expireAt });
    this.prune(now);
    this.log.debug("SSO validé", (result.user && result.user.login) || "?", "logged=" + result.logged, "right=" + result.adminRight);
    return result;
  }

  /** Accès autorisé ? (connecté ET SUPER_ADMIN). */
  isAuthorized(r: SsoResult): boolean { return !!r.logged && r.adminRight === "SUPER_ADMIN"; }

  /** Jeton = valeur du cookie `cookieName` (sinon tout l'en-tête Cookie, proxifié tel quel). */
  private tokenOf(req: Request): string | null {
    const raw = req.headers.cookie || "";
    if (!this.cookieName) return raw || null;
    const m = raw.match(new RegExp("(?:^|;\\s*)" + this.cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  private async fetchSso(token: string): Promise<SsoResult> {
    const cookie = this.cookieName ? (this.cookieName + "=" + token) : token;   // on renvoie au SSO le cookie attendu
    try {
      const r = await fetch(this.ssoUrl, { headers: { cookie, accept: "application/json" } });
      if (!r.ok) { this.log.warn("SSO HTTP", r.status); return ANON; }
      const data = await r.json();
      return (data && typeof data === "object") ? (data as SsoResult) : ANON;
    } catch (e: any) { this.log.error("SSO injoignable", this.ssoUrl, e && e.message); return ANON; }
  }
  private expiryOf(r: SsoResult, now: number): number {
    const exp = Number(r.expireDate);
    if (r.logged && exp && exp > now) return exp;     // authentifié → jusqu'à expireDate
    return now + 60_000;                              // sinon mise en cache courte (1 min) pour limiter les appels
  }
  private prune(now: number): void { for (const [k, v] of this.cache) if (now >= v.expireAt) this.cache.delete(k); }
  private devResult(): SsoResult { return { user: { login: this.devUser || "dev", nom: "Dev", prenom: "" }, logged: true, adminRight: "SUPER_ADMIN", dev: true }; }
}
