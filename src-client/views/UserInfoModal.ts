/* ============================================================================
   USER INFO MODAL — la fiche « qui suis-je ? » ouverte depuis la pastille
   utilisateur de la topbar (mode API).

   POURQUOI. En responsive, la pastille se réduit à une ICÔNE : le nom complet
   ne tient plus dans la topbar. Le clic sur la pastille (icône seule OU nom en
   grand écran — même geste partout) ouvre donc cette modale, qui redonne les
   informations de session DÉJÀ connues du client : nom affiché, identifiant,
   e-mail, et un résumé SOBRE des droits de lecture. AUCUN appel serveur — tout
   vient de la réponse `/me` déjà reçue (`user`) et de l'état d'autorisation
   courant (`core/AccessState`, reconstruit des grants de `/me`).

   Modale d'INFO (pile standard, `hideFooter` → niveau `info`, pas d'édition,
   principe n°11) : elle n'a ni « Enregistrer » ni « Annuler », juste ← / ✕.

   Le nom affiché passe par `core/UserIdentity` — la MÊME règle que la pastille,
   dite une seule fois. Le résumé de droits passe par
   `AccessState.documentAccessSummary()` — décision PURE et testée : « accès
   complet » ou la liste des DOMAINES lisibles (jamais un inventaire de collections).
   ============================================================================ */
import type { AccessState } from "../core/AccessState";
import { UserIdentity, type UserLike } from "../core/UserIdentity";
import type { FormHost } from "./forms/shared";
import { Html } from "../core/Html";
import { Icons } from "../ui/Icons";
import { I18n } from "../i18n/I18n";

export class UserInfoModal {
  /** Domaines de donnée (carte partagée `Permissions.DATA_DOMAINS`) → clé i18n de leur libellé
      COURT. ⚠ Les noms de domaine portent un POINT (`dc.equipment`), or i18next traite le point comme
      séparateur de niveaux : on le remplace par `_` pour viser une clé PLATE (`shell.user.domain.dc_equipment`).
      Une entrée par domaine possible ; un domaine inconnu retomberait sur sa clé brute (jamais le cas, la
      carte est verrouillée par invariant côté serveur). */
  private static domainLabel(domain: string): string {
    return I18n.t("shell.user.domain." + domain.replace(/\./g, "_"));
  }

  /** Ouvre la modale d'infos. `user` = objet de session `/me` (ou null : non connecté) ;
      `access` = état d'autorisation courant du client (jamais un appel réseau ici). */
  static open(host: FormHost, user: UserLike | null | undefined, access: AccessState): void {
    const body = document.createElement("div");
    body.className = "user-info";

    const who = UserIdentity.displayName(user, I18n.t("shell.user.anonymous"));

    // -- Bandeau : grande icône + nom affiché --
    const head = document.createElement("div"); head.className = "user-info-head";
    const avatar = document.createElement("span"); avatar.className = "user-info-avatar"; avatar.setAttribute("aria-hidden", "true"); avatar.innerHTML = Icons.USER;
    const name = document.createElement("div"); name.className = "user-info-name"; name.textContent = who;
    head.append(avatar, name);
    body.appendChild(head);

    // -- Champs disponibles (uniquement ceux réellement présents) : identifiant, e-mail --
    const rows: Array<[string, string]> = [];
    const login = (user && user.login) ? String(user.login).trim() : "";
    if (login && login !== who) rows.push([I18n.t("shell.user.fieldLogin"), login]);
    const email = (user && (user.eMail || user.email)) ? String(user.eMail || user.email).trim() : "";
    if (email) rows.push([I18n.t("shell.user.fieldEmail"), email]);
    if (!(user && user.login)) rows.push([I18n.t("shell.user.status"), I18n.t("shell.user.notConnected")]);

    if (rows.length) {
      const dl = document.createElement("dl"); dl.className = "user-info-fields";
      for (const [label, value] of rows) {
        const dt = document.createElement("dt"); dt.textContent = label;
        const dd = document.createElement("dd"); dd.textContent = value;
        dl.append(dt, dd);
      }
      body.appendChild(dl);
    }

    // -- Résumé SOBRE des droits (décision PURE) : « accès complet » ou la liste des domaines lisibles --
    const rights = document.createElement("div"); rights.className = "user-info-rights";
    const rightsTitle = document.createElement("div"); rightsTitle.className = "user-info-rights-title"; rightsTitle.textContent = I18n.t("shell.user.rights");
    rights.appendChild(rightsTitle);
    const summary = access.documentAccessSummary();
    if (summary.full) {
      const p = document.createElement("div"); p.className = "user-info-rights-full"; p.textContent = I18n.t("shell.user.rightsFull");
      rights.appendChild(p);
    } else if (summary.domains.length) {
      const chips = document.createElement("div"); chips.className = "user-info-domains";
      chips.innerHTML = summary.domains.map((d) => `<span class="user-info-domain">${Html.escape(UserInfoModal.domainLabel(d))}</span>`).join("");
      rights.appendChild(chips);
    } else {
      const p = document.createElement("div"); p.className = "user-info-rights-none"; p.textContent = I18n.t("shell.user.rightsNone");
      rights.appendChild(p);
    }
    body.appendChild(rights);

    host.openModal({ title: I18n.t("shell.user.infoTitle"), body, hideFooter: true, stackKey: "user-info" });
  }
}
