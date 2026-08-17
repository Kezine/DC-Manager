# Réplication des interventions vers un tracker (Jira) — configuration & exploitation

*Pour le technicien qui déploie/exploite — le partage des vérités, le cycle de poussée tolérante,
le mapping des champs et la procédure d'ajout d'une autre marque de tracker sont dans
[`docs/jira-interventions.md`](../docs/jira-interventions.md).*

Le module réplique les incidents et interventions de DC Manager vers un tracker distant. Atlassian
Jira Cloud est la première marque implémentée. C'est un **pont** : il ne crée aucune collection, et
les interventions restent pleinement fonctionnelles sans lui.

> 🚨 **Ce qu'il faut avoir compris avant de configurer.** DC Manager fait foi sur le **contenu** :
> quand il pousse, il **écrase** le titre et la description du ticket. Le tracker fait foi sur le
> **traitement** : statut et assigné sont lus, jamais écrits. Ne configurez donc pas ce pont sur un
> projet dont les tickets sont édités à la main côté tracker.

---

## 1. Prérequis : `DCMANAGER_SECRETS_KEY`

Le module chiffre au repos le jeton d'API de chaque tracker : sans la clé de chiffrement des secrets
serveur, le pont reste inactif. Contrainte, génération et portée :
[`configuration.md`](configuration.md) § 2.

> 🚨 **Modèle de menace élargi par rapport aux modules d'inventaire.** Le jeton stocké ici n'est
> **pas en lecture seule** : le module **crée** et **met à jour** des tickets. Un serveur compromis
> peut donc **écrire** chez le tracker. D'où une recommandation qui n'est pas une formalité : **un
> compte de service DÉDIÉ**, aux droits limités au **projet cible**, jamais un compte nominatif
> d'administrateur.

---

## 2. Configurer un provider (par document)

Un provider = **une instance de tracker + un projet de destination**. La configuration se fait par
l'interface et est stockée dans la base chiffrée `tracker-providers.db`, dans `DOCS_DIR`.

| Champ | Requis | Défaut | Notes |
|---|---|---|---|
| `id` | oui | — | **immuable** après création (référencé par chaque intervention répliquée) |
| `kind` | oui | — | doit être un type **connu** (`jira`) — sinon la validation refuse en listant les types supportés |
| `url` | oui | — | **https obligatoire** : le jeton voyage en en-tête d'autorisation à chaque requête |
| `account` | oui | — | moitié **publique** de l'identification (Jira Cloud : l'adresse e-mail du compte de service). **Relue et réaffichée** à l'édition, contrairement au jeton |
| `token` | oui à la création | — | jeton d'API, **chiffré au repos**, jamais relu ni renvoyé |
| `interval_sec` | non | `0` | `0` = synchro **manuelle** uniquement. ⚠ À régler **haut** en usage réel : l'état d'un ticket n'a pas la volatilité d'un client wifi |
| `timeout_sec` | non | `20` | délai d'**une** requête. Plus généreux que les 15 s des modules d'inventaire : ici une requête est une **recherche** SaaS qui traverse Internet |
| `options.project_key` *(Jira)* | **oui** | `""` | clé du **projet de destination**. **Requis** : sans projet, un provider de réplication n'a rien à faire |
| `options.type_incident` *(Jira)* | non | `"Incident"` | type de ticket des objets de nature « incident » |
| `options.type_intervention` *(Jira)* | non | `"Infrastructure"` | type de ticket des objets de nature « intervention » |
| `options.auto_replicate` *(Jira)* | non | `true` | réplication **automatique** à l'enregistrement |

⚠ **Les libellés de type dépendent de la configuration du projet et de sa langue** : ce sont des
**réglages**, pas des énumérations — ils ne sont donc contraints à aucune liste (seulement à « non
vide »). Un type inconnu du projet fait **refuser la création**, et le message du tracker remonte
intact.

⚠ **Plusieurs providers en `auto_replicate` sur le même document ⇒ AUCUNE réplication automatique**,
et le fait est journalisé. La réplication se fait alors par l'action manuelle, qui désigne le
provider.

Ce que la base ne rend jamais : le jeton n'est **pas** renvoyé par l'API (au plus `has_token: true`),
et n'apparaît dans aucun log ni message d'erreur. Un jeton indéchiffrable exclut **ce** provider de la
passe et mémorise une erreur consultable, sans jamais interrompre les autres.

> ⚠ **Le projet Jira peut être PARTAGÉ avec d'autres sources.** DC Manager gère ses propres
> étiquettes `DCM-*` par ajout et retrait ciblés : les étiquettes posées par d'autres outils, ou à la
> main, ne sont **jamais** touchées. C'est le point à vérifier explicitement en re-validation (§ 5,
> étape 3).

---

## 3. Clé absente ou configuration invalide → 503

- **Clé absente** — pont inactif : **toutes** les routes répondent **503** avec un détail actionnable
  (« définir `DCMANAGER_SECRETS_KEY`… »), et le déclenchement automatique à l'écriture devient inerte.
  Si une `tracker-providers.db` existe **déjà** sans clé, le message est enrichi.
- **Clé présente mais trop courte, ou base illisible** — module « démarré en erreur », routes en
  **503** avec le détail. Le serveur démarre normalement.

⚠ **Le module interventions reste PLEINEMENT fonctionnel** dans les deux cas : le pont est un
supplément, jamais une dépendance.

---

## 4. Dépannage — la clé a CHANGÉ (jetons indéchiffrables)

**Symptômes** : les providers concernés disparaissent des passes, le statut les **réaffiche en
erreur** avec « le secret doit être ressaisi » (ils sont réinjectés exprès, pour ne pas disparaître
silencieusement de l'interface), et « Tester » répond **422** avec le même message.

**Correctif** : rouvrir « Providers… », **ressaisir le jeton d'API** de chaque provider, enregistrer.
Rien d'autre n'est perdu : URL, compte, options et intervalles sont stockés en clair.

---

## 5. 🚨 Procédure de re-validation de l'API Jira

> ⚠ **À exécuter au premier déploiement.** Le module a été écrit **sans accès à une instance Jira
> réelle** : plusieurs points du contrat d'API sont des **hypothèses**, pas des constats. Cette
> procédure est ce qui les transforme en faits — et l'étape 3 couvre le risque n°1 du module.

Sur un **projet de test**, avec un **compte de service dédié** :

1. **Configurer un provider** (URL, compte, jeton, `project_key`, types) et cliquer **« Tester la
   connexion »** :
   - échec d'authentification → le message vient de Jira (compte, jeton, droits) ;
   - « l'API de recherche n'a pas répondu comme attendu » → à signaler ; le test le signale **sans
     bloquer**, l'authentification étant, elle, prouvée.
2. **Pousser une intervention de test** (« Répliquer »), puis **vérifier dans Jira** : le **type** de
   ticket est conforme à `type_intervention` (et à `type_incident` sur un incident) ; **résumé** et
   **description** sont présents ; la **priorité** correspond ; l'**échéance** vaut la date de fin
   planifiée ; les **étiquettes** `DCM-EQ-…` / `DCM-VM-…` sont posées pour chaque objet lié.
3. 🚨 **Poser à la main une étiquette ÉTRANGÈRE** sur ce ticket (p. ex. `ops-2026`), puis modifier
   l'intervention dans DC Manager et attendre la poussée : l'étiquette étrangère doit **SURVIVRE**, et
   seules les `DCM-*` devenues obsolètes doivent disparaître. **À tester explicitement, jamais par
   déduction** — c'est le risque principal sur un projet partagé.
4. **Éditer côté DC Manager** (titre, description) et vérifier que le ticket est **écrasé** par le
   contenu DC Manager : c'est le comportement voulu.
5. **Fermer le ticket côté Jira**, lancer « Synchroniser », et vérifier que la **pastille** change
   **sans** que le statut DC Manager bouge.
6. **Projet sans priorité** (créer un projet *team-managed*) : la poussée doit **réussir en dégradé**
   — le statut de la passe porte « poussée(s) dégradée(s) — priorité non appliquée… » et le ticket est
   bien créé.
7. **Ticket supprimé côté Jira** : la passe suivante doit marquer l'intervention **« introuvable »**
   (pastille d'avertissement), **sans** rien supprimer localement et **sans** re-créer de ticket.
8. **Volume** : si un lot plafonne, les identifiants non revenus ressortent en « introuvables » —
   c'est précisément le signal qu'il faut regarder, et signaler.

Deux points de configuration Jira à connaître : le jeton d'API se crée sur
`id.atlassian.com/manage/api-tokens`, et une **politique d'organisation** Atlassian peut interdire les
jetons d'API — auquel cas ce module n'est pas utilisable en l'état.

---

## 6. Déploiement

| Variable | Rôle | Sans elle |
|---|---|---|
| `DCMANAGER_SECRETS_KEY` | chiffrement des jetons d'API des trackers (**partagée** avec les modules VM, wifi et notifications) | pont inactif, routes en **503** actionnable, déclenchement inerte — les interventions restent pleinement fonctionnelles |

**Aucune autre variable d'environnement n'est propre à cette feature** : le lien de chaque ticket est
**persisté** au moment de la synchro, il n'y a donc rien à configurer pour le fabriquer.

> ⚠ Ne pas confondre avec **`JIRA_BASE_URL`** (cf. [`configuration.md`](configuration.md)), qui
> appartient à la référence **manuelle** du module interventions : elle fabrique un lien depuis une
> clé de ticket **saisie à la main**, sans aucun appel réseau. Les deux mécanismes sont indépendants.

Au premier déploiement : définir ou vérifier la clé, configurer un provider, **exécuter la procédure
de re-validation** (§ 5) avec `interval_sec = 0` le temps de la validation, puis poser une période
réaliste.
