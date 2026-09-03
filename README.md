# DC Manager

Outil de cartographie réseau / datacenter : inventaire d'équipements, baies, câblage,
adressage IP (IPAM) et **visualisation 3D** des salles (Three.js / WebGL).

Deux modes de données :

- **Fichier** (autonome) — un `.json` sur disque + compagnon `.nmfb` d'images, via la
  File System Access API. Le client est un **HTML mono-fichier** ouvrable par double-clic.
- **API / REST** — données servies par le backend Node.js + SQLite (multi-documents,
  multi-clients, notifications temps réel SSE).

Le dépôt contient **les deux** dans un seul projet TypeScript :

| Dossier | Rôle | Compilé par |
|---|---|---|
| [`src-client/`](src-client/) | Front (navigateur) | webpack (`ts-loader`) |
| [`src-server/`](src-server/) | Back (Node, ESM/NodeNext) | `tsc` |
| [`src-shared/`](src-shared/) | Code PARTAGÉ front ⇄ back (schéma, validation, cascade) | les deux |
| [`user-docs/`](user-docs/) | Documentation **DÉPLOYEUR** (installer, configurer, exploiter) | — |
| [`docs/`](docs/) | Documentation **DÉVELOPPEUR** (architecture, conception) | — |
| [`Tests/modules/`](Tests/modules/) | Tests unitaires (Node, sans navigateur) | `tsc` (`tsconfig.node.json`) |

Conventions de contribution : voir [`CLAUDE.md`](CLAUDE.md).

---

## Démarrage express (Docker)

```bash
git clone <url-du-depot> DcManager
cd DcManager/src-server
docker compose up -d --build      # construit le client ET le serveur, puis démarre
# → http://localhost:3000  (mode API, utilisateur `dev` factice)
```

La 1ʳᵉ construction prend ≈ 3-6 min. Détail (prérequis, build sans Docker, healthcheck) :
[`user-docs/installation.md`](user-docs/installation.md).

> ⚠️ Le mode par défaut n'authentifie **personne**. Avant tout déploiement réel, choisir un mode
> d'authentification : [`user-docs/auth.md`](user-docs/auth.md).

---

## Documentation DÉPLOYEUR — [`user-docs/`](user-docs/)

**Le point d'entrée du technicien IT** qui installe, configure et exploite l'application.

- [`user-docs/installation.md`](user-docs/installation.md) — prérequis, build du client et du
  serveur depuis les sources, lancement local, Docker (compose et manuel), healthcheck.
- [`user-docs/configuration.md`](user-docs/configuration.md) — 🚨 **la table de référence UNIQUE des
  variables d'environnement** (27), et la section dédiée à `DCMANAGER_SECRETS_KEY`.
- [`user-docs/auth.md`](user-docs/auth.md) — les 5 modes d'authentification (`dev`, `basic`, `sso`,
  `forward`, `oidc`), exemples Authelia/nginx et Keycloak, `roles.json` et les 13 rôles fournis,
  diagnostic 401 / 403.
- [`user-docs/reverse-proxy.md`](user-docs/reverse-proxy.md) — servir l'app **sous un sous-dossier**
  (URLs relatives, `X-Forwarded-Prefix`, slash final), et le réglage du canal temps réel (SSE).
- [`user-docs/exploitation.md`](user-docs/exploitation.md) — démarrer/arrêter, logs et `LOG_LEVEL`,
  **sauvegarde** (le `.db` **et** le dossier des pièces jointes), migration des documents legacy,
  édition d'une base SQLite à la main, import d'un `.json`, dépannage.
- [`user-docs/vm-proxmox.md`](user-docs/vm-proxmox.md) — configurer un provider VM Proxmox, confiance
  TLS, dépannages (clé changée, VMs en double), gamme supportée.
- [`user-docs/wifi-unifi.md`](user-docs/wifi-unifi.md) — configurer un provider wifi UniFi, limites
  mesurées de l'API, procédure de re-validation.
- [`user-docs/jira-tracker.md`](user-docs/jira-tracker.md) — configurer la réplication des
  interventions vers un tracker, et la procédure de re-validation de l'API Jira.
- [`user-docs/notifications-certs.md`](user-docs/notifications-certs.md) — canaux, abonnements et
  contrat de payload des webhooks ; déployer la confiance d'une CA interne, changer la phrase
  maître, renouvellements.

---

## Configuration

Toutes les variables d'environnement reconnues par le serveur sont décrites, avec leurs défauts,
dans **[`user-docs/configuration.md`](user-docs/configuration.md)** — c'est la **source unique**.

Le minimum vital d'un déploiement réel :

| Variable | Pourquoi |
|---|---|
| `DOCS_DIR` | où vivent les bases SQLite (sur un volume **persistant**) |
| `AUTH_MODE` | `forward` ou `oidc` — jamais `dev` en production |
| `BOOTSTRAP_ADMIN_IDS` | le premier administrateur, le temps d'écrire `roles.json` |
| `DCMANAGER_SECRETS_KEY` | requise si les modules VM / wifi / tracker / notifications sont utilisés |

---

## Documentation DÉVELOPPEUR — [`docs/`](docs/)

Architecture et conception, référencées depuis le code.

**Données & modèle**

- [`docs/validation.md`](docs/validation.md) — normalisation & validation partagées front ⇄ back.
- [`docs/persistance.md`](docs/persistance.md) — persistance serveur : modèle relationnel SQLite,
  schéma dérivé de la spec, colonne `search`, migration des documents legacy.
- [`docs/attachments.md`](docs/attachments.md) — pièces jointes : métadonnées dans le document,
  binaires hors document (disque serveur / IndexedDB + compagnon `.nmfa`).
- [`docs/hydratation.md`](docs/hydratation.md) — hydratation du cache client par collection et
  gardes de sûreté (anti-snapshot, export, SSE, facettes).
- [`docs/recherche.md`](docs/recherche.md) — palette Ctrl+K, listings serveur-pilotés, filtre cible.
- [`docs/placement.md`](docs/placement.md) — doctrine du placement (conteneurs, repères, chaîne
  bâtiment → étage → salle → baie).

**Domaine métier**

- [`docs/deduction-reseau.md`](docs/deduction-reseau.md) — réseau déduit depuis les ports terminaux.
- [`docs/faisceaux.md`](docs/faisceaux.md) — faisceaux (trunks) : contraintes et rendu du tracé.
- [`docs/breakout.md`](docs/breakout.md) — breakout : un port trunk éclaté en N lanes (modèle, refus
  d'éclatement/défaire, section dédiée du formulaire, fiche, contrat avec la terminaison).
- [`docs/terminaisons.md`](docs/terminaisons.md) — terminaisons : un transceiver dans la cage (média présenté
  sur le port, pièce inventoriée facultative, type effectif et héritage lane ← trunk, gestes ⋮ / formulaire câble).
- [`docs/power.md`](docs/power.md) — analyse énergie (source/sink, charges, PoE, avertissements).
- [`docs/lifecycle.md`](docs/lifecycle.md) — cycle de vie matériel : veilleur d'alerte de garantie.

**Vues 2D/3D**

- [`docs/perf-3d.md`](docs/perf-3d.md) — optimisations du moteur 3D WebGL.
- [`docs/redressement-perspective.md`](docs/redressement-perspective.md) — correction de perspective
  et assemblage des images de façade.

**Modules serveur amovibles**

- [`docs/vm-proxmox.md`](docs/vm-proxmox.md) — inventaire VM Proxmox.
- [`docs/wifi-unifi.md`](docs/wifi-unifi.md) — inventaire des clients wifi (UniFi).
- [`docs/notifications.md`](docs/notifications.md) — service de notifications et d'alertes.
- [`docs/certs.md`](docs/certs.md) — PKI interne zéro-connaissance.
- [`docs/interventions.md`](docs/interventions.md) — incidents & interventions.
- [`docs/jira-interventions.md`](docs/jira-interventions.md) — réplication des incidents &
  interventions vers un tracker distant (Jira Cloud).

**Transverse**

- [`docs/auth.md`](docs/auth.md) — authentification (un provider par mode) & autorisation (RBAC à
  permissions atomiques, gardes par route, gating client).
- [`docs/user-resolver.md`](docs/user-resolver.md) — annuaire utilisateurs et audit « créé/modifié par ».
- [`docs/i18n.md`](docs/i18n.md) — localisation du client (fr/en).

---

## Crédits

Projet conçu et maintenu par **Kezine**.

Co-écrit avec **Claude** (Anthropic), utilisé comme assistant de développement pour la
conception, l'implémentation, les tests et la documentation. Les conventions que
l'assistant doit respecter sont réunies dans [`CLAUDE.md`](CLAUDE.md).
