/* ============================================================================
   Cœur PUR du protocole REST client — extrait de RestAdapter pour être TESTABLE
   sans réseau (Tests/modules/run.js) : RestAdapter garde le transport (fetch,
   URLs, en-têtes de session), cette classe porte l'INTERPRÉTATION des réponses :
     - suivi de la révision document (en-tête X-Doc-Rev) ;
     - verrou optimiste : 409 → onConflict, SANS throw ni rejeu (le hôte recharge,
       ce qui resynchronise l'état optimiste local) ;
     - validation serveur (autorité) : 400 structuré → onValidationError ;
     - authentification/autorisation : 401 → onAuthExpired (retour au login),
       403 → onForbidden (l'appelant EST authentifié : jamais de retour au login) ;
     - 404 tolérés (allow404), 204 sans corps, corps JSON sinon.
   La réponse est reçue via l'interface minimale `RestResponse` (injectée) —
   un `fetch` Response réel s'y adapte trivialement, un test la simule.
   ============================================================================ */

/** Surface minimale d'une réponse HTTP (adaptée depuis `fetch`, simulée en test). */
export interface RestResponse {
  status: number;
  ok: boolean;
  header(name: string): string | null;
  text(): Promise<string>;
}

export class RestProtocol {
  /** Révision connue du document (synchronisée sur chaque réponse via X-Doc-Rev). */
  docRev = 0;
  /** Conflit de version (HTTP 409, verrou optimiste serveur) : une écriture a été refusée car une entité visée a
      changé depuis notre `docRev`. Le hôte (main.ts) recharge le document et notifie — l'écriture n'est PAS rejouée. */
  onConflict: ((info: { conflicts?: Array<{ collection: string; id: string; rev: number }> } | null) => void) | null = null;
  /** Données refusées par le serveur (HTTP 400, validation PARTAGÉE) : le serveur fait autorité et a rejeté
      l'écriture. Le hôte (main.ts) notifie l'utilisateur. `errors` = liste `{ collection, path, code, message }`. */
  onValidationError: ((errors: Array<{ collection: string; path: string; code: string; message: string }>) => void) | null = null;
  /** Session SSO absente/EXPIRÉE (HTTP 401, garde serveur `AccessControl.requireAuth`) : notre requête a été
      refusée faute d'authentification (le SSO a expiré en cours de session). Le hôte (main.ts → SessionExpiry)
      coupe la session locale et RENVOIE au login. ⚠ On notifie PUIS on `throw` (JAMAIS de retour null,
      contrairement aux 409/400) : un `load()` nullifié produirait un snapshot VIDE qui ÉCRASERAIT le store par
      du vide. Le throw préserve la sémantique des appelants (leurs catch locaux jouent ; l'écran bascule au
      login de toute façon). */
  onAuthExpired: (() => void) | null = null;
  /** Refus d'AUTORISATION (HTTP 403 — authentifié, mais sans le droit ; garde globale « 0 permission » ou garde
      de route). ⚠ RIEN À VOIR avec le 401 : l'utilisateur EST authentifié, se reconnecter n'y changerait rien →
      JAMAIS de retour au login. Le hôte notifie de façon NON BLOQUANTE et relit `GET /me` (les droits ont pu
      changer à chaud : la politique serveur est rechargée par sondage). Le corps du 403 porte le champ
      `permission` nommant ce qui manque (cf. docs/auth.md § 9) — un refus muet est indiagnostiquable.
      On notifie PUIS on laisse le `throw` générique partir, exactement comme avant : le flux de contrôle des
      appelants (leurs `catch` locaux, leurs replis) est INCHANGÉ. */
  onForbidden: ((info: { permission?: string; error?: string } | null) => void) | null = null;

  /** En-têtes d'une ÉCRITURE : la révision de base que le serveur compare aux entités visées (verrou optimiste). */
  writeHeaders(): Record<string, string> { return { "X-Base-Rev": String(this.docRev) }; }

  /** Interprète une réponse : synchronise `docRev`, route 409/400 vers les callbacks, renvoie le corps JSON
      (ou null : 204, 404 toléré, 409, 400 structuré). Throw sur les autres statuts d'erreur. */
  async interpret(res: RestResponse, method: string, path: string, { allow404 = false }: { allow404?: boolean } = {}): Promise<any> {
    const rev = res.header("X-Doc-Rev"); if (rev != null && rev !== "") this.docRev = Number(rev);   // synchronise la révision connue
    if (res.status === 409) {   // verrou optimiste : une autre écriture a précédé la nôtre sur ces entités
      let info: any = null; try { info = JSON.parse(await res.text()); } catch (_) { /* corps absent/illisible */ }
      this.onConflict?.(info);   // le hôte recharge + notifie ; on NE throw PAS → le reload resynchronise l'état optimiste local
      return null;
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 400) {   // validation serveur (autorité) : données refusées
      let info: any = null; try { info = JSON.parse(await res.text()); } catch (_) { /* corps absent/illisible */ }
      if (info && Array.isArray(info.errors)) { this.onValidationError?.(info.errors); return null; }   // erreurs structurées → notifiées, pas de throw
      throw new Error("HTTP 400 sur " + method + " " + path + (info && info.error ? " : " + info.error : ""));
    }
    if (res.status === 401) {   // session absente/expirée : on notifie le hôte (retour au login) PUIS on throw (jamais null → n'écrase pas le store)
      this.onAuthExpired?.();
      throw new Error("HTTP 401 sur " + method + " " + path);
    }
    if (res.status === 403) {   // authentifié SANS le droit : on notifie (toast + relecture de /me) et on laisse le throw partir
      let info: any = null; try { info = JSON.parse(await res.text()); } catch (_) { /* corps absent/illisible */ }
      this.onForbidden?.(info);
      throw new Error("HTTP 403 sur " + method + " " + path + (info && info.permission ? " (" + info.permission + ")" : ""));
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " sur " + method + " " + path);
    if (res.status === 204) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
}
