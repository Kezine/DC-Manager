import { SecretCompare } from "./SecretCompare.js";   // comparaison à TEMPS CONSTANT — helper du dossier (2 consommateurs depuis le mode forward)
import type { AuthProvider, AuthRequestView, SsoResult } from "./AuthProvider.js";

/* =============================================================================
   MODE BASIC — challenge HTTP Basic sur un couple `user:pass` d'environnement
   (`BASIC_AUTH`). Mode de DÉPANNAGE : un seul compte, pas d'annuaire, pas de
   déconnexion — mais un contrôle réel, contrairement au mode dev.

   ⚠ DEUX rôles à ne pas confondre, et ils vivent à deux endroits :
   - le CHALLENGE (renvoyer `401 WWW-Authenticate: Basic` pour que le navigateur
     demande les identifiants) est un geste de TRANSPORT : il reste dans
     `server.ts` (`basicGate`), monté sur TOUT le serveur, y compris les pages ;
   - l'IDENTITÉ (« qui est cet appelant ? ») est ici.
   `Auth.checkBasic` est le point de contact entre les deux : le gate demande à ce
   provider si les identifiants présentés sont bons, sans rien savoir de plus.

   La session rendue porte `dev: true` : ce mode n'authentifie pas une PERSONNE
   (le mot de passe est dans l'environnement du serveur, partagé par tous ceux qui
   le connaissent) — la politique de rôles le traite comme le mode dev.
   ============================================================================= */
export class BasicAuthProvider implements AuthProvider {
  /** Login servi dans la session quand `BASIC_AUTH` ne nomme pas d'utilisateur (`":motdepasse"`). */
  static readonly FALLBACK_LOGIN = "dev";

  /** @param login     Utilisateur attendu (peut être vide — cf. `FALLBACK_LOGIN`).
      @param password  Mot de passe attendu. */
  constructor(readonly login: string, private readonly password: string) {}

  /** Analyse la valeur d'environnement `BASIC_AUTH` (`"user:pass"`). Rend `null` quand elle ne
      décrit PAS un couple — et c'est cette réponse qui fait l'INFÉRENCE de mode au boot : pas de
      deux-points, pas de mode basic. La règle de format vit donc chez celui qui connaît le format,
      jamais chez l'orchestrateur (principe n°2).

      Tolérant à l'espace autour (une variable d'environnement recopiée traîne souvent un blanc),
      mais PAS au contenu : le mot de passe est pris tel quel, deux-points compris. */
  static fromSpec(spec: string | null | undefined): BasicAuthProvider | null {
    const raw = (spec || "").trim();
    const cut = raw.indexOf(":");
    if (cut < 0) return null;
    return new BasicAuthProvider(raw.slice(0, cut), raw.slice(cut + 1));
  }

  /** Les identifiants présentés sont-ils les bons ? Lu AUSSI par le gate de transport
      (`server.ts`), d'où une méthode publique distincte d'`authenticate`. */
  accepts(req: AuthRequestView): boolean {
    const header = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
    if (!header) return false;
    let decoded = "";
    try { decoded = Buffer.from(header[1], "base64").toString("utf8"); } catch { return false; }
    const cut = decoded.indexOf(":");
    const user = cut >= 0 ? decoded.slice(0, cut) : decoded;
    const pass = cut >= 0 ? decoded.slice(cut + 1) : "";
    // Les DEUX comparaisons sont évaluées avant le `&&` (pas de court-circuit qui distinguerait
    // « login faux » de « mot de passe faux » au temps de réponse), chacune à temps constant.
    const okUser = SecretCompare.equals(user, this.login);
    const okPass = SecretCompare.equals(pass, this.password);
    return okUser && okPass;
  }

  /** Identifiants refusés → `null` (anonyme). Aucune trace, aucun compteur : c'est le gate de
      transport qui répond au navigateur, et un log par tentative n'apporterait qu'un bruit
      proportionnel au nombre d'onglets ouverts. */
  async authenticate(req: AuthRequestView): Promise<SsoResult | null> {
    if (!this.accepts(req)) return null;
    return { user: { login: this.login || BasicAuthProvider.FALLBACK_LOGIN }, logged: true, adminRight: "SUPER_ADMIN", dev: true };
  }
}
