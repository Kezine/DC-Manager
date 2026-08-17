# DC Manager — backend REST (Node.js + SQLite, TypeScript)

Sert l'API REST **et** le client (HTML autonome `dist/dc-manager.html`), en injectant
`window.__DCMANAGER_CONFIG__ = { mode: "api", apiBaseUrl: "api" }` dans la page → le client passe en
mode API **sans configuration utilisateur**. La base d'API est **relative**, ce qui permet de servir
l'application sous un sous-dossier (cf. [`user-docs/reverse-proxy.md`](../user-docs/reverse-proxy.md)).

**Stack** : Node ≥ 18 (ESM / NodeNext), Express, `better-sqlite3` (module natif), `multer` pour les
téléversements, `openid-client` pour le mode d'authentification `oidc`. Le TypeScript est compilé par
`tsc` ; le dossier partagé `src-shared/` est compilé **avec** le serveur, d'où le niveau `src-server/`
dans l'arborescence de sortie.

## Structure de `src/`

| Fichier / dossier | Rôle |
|---|---|
| `index.ts` | bootstrap : environnement → `DocumentStore` → modules → `Server.listen` |
| `server.ts` | application Express (API, service du client, routes publiques `/healthz` et `/auth/*`) |
| `api.ts` | couche HTTP : registre `/documents`, données scopées `/documents/:docId/…`, verrou optimiste, SSE |
| `db.ts` | types partagés du dépôt (driver SQLite, `Rec`, `Tx`, `ListResult`) + contrat `RepositoryContract` |
| `RelationalRepository.ts` | dépôt **relationnel** de production (schéma dérivé de la spec partagée) |
| `LegacyMigration.ts` | migration blob → relationnel au premier accès d'un document (backup `.bak`) |
| `documents.ts` | registre multi-documents (un fichier SQLite isolé par document) + révisions |
| `live.ts` | bus SSE : notification de changement par **changeset** |
| `auth.ts`, `auth/` | orchestrateur d'authentification + **un provider par mode** (`dev`, `basic`, `sso`, `forward`, `oidc`) |
| `access/` | autorisation : politique `roles.json` relue à chaud, gardes par route |
| `users/` | annuaire des utilisateurs vus (audit « créé/modifié par ») |
| `SecretBox.ts` | coffre de chiffrement des secrets au repos, **partagé** par les modules ci-dessous |
| `vm/`, `wifi/`, `tracker/`, `notify/`, `certs/`, `interventions/`, `lifecycle/` | **modules AMOVIBLES** : le cœur ne les importe jamais ; chacun a sa base SQLite dédiée et son script de suppression |

## Où lire la suite

- **Installer, builder, lancer** (avec ou sans Docker) : [`user-docs/installation.md`](../user-docs/installation.md).
- **Configurer** (variables d'environnement, source unique) : [`user-docs/configuration.md`](../user-docs/configuration.md).
- **Authentification & autorisation** : [`user-docs/auth.md`](../user-docs/auth.md).
- **Exploiter** (logs, sauvegarde, dépannage) : [`user-docs/exploitation.md`](../user-docs/exploitation.md).
- **Modèle de persistance** (schéma relationnel, évolution additive, colonne `search`) :
  [`docs/persistance.md`](../docs/persistance.md).
- **Conventions de contribution** : [`CLAUDE.md`](../CLAUDE.md).
