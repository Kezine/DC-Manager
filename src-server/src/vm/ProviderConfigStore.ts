import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import type { ProviderConfig, ProviderConfigSource } from "./VmProvider.js";
import { ProviderConfigValidate } from "./ProviderConfigValidate.js";

/* =============================================================================
   CHARGEMENT DE LA CONFIG DES PROVIDERS VM — module `vm/` AMOVIBLE. Lit et
   VALIDE le fichier `vm-providers.json` (secrets CÔTÉ SERVEUR uniquement : ce
   fichier ne transite JAMAIS par le document répliqué aux clients).

   AMENDEMENT de cadrage (2026-07-13) : la config est SCOPÉE PAR DOCUMENT. Chaque
   document DC Manager = une infrastructure avec SES clusters (multi-clusters par
   document possibles). Le fichier est donc une map `docId → { providers: [...] }`.
   Format (édité À LA MAIN en v1, aucune UI) :

     {
       "<docId>": {
         "docName": "libellé libre facultatif (IGNORÉ au parsing)",
         "providers": [
           { "id": "...", "kind": "proxmox",
             "urls": [ { "url": "https://pve1:8006", "fingerprint": "AA:…"|null },
                       "https://pve2:8006" ],
             "token": "USER@REALM!TOKENID=UUID",
             "include_lxc": true, "interval_sec": 0, "timeout_sec": 15 }
         ]
       }
     }

   POOL DE NŒUDS (exigence 2026-07-13 — palier à la défaillance d'un nœud) :
   `urls` = tableau d'endpoints essayés dans l'ordre (cf. PveHttpPool). Chaque
   entrée est un objet `{ url, fingerprint? }` (l'empreinte TLS est PAR NŒUD —
   chaque nœud Proxmox a son propre certificat) ou une chaîne (raccourci sans
   épinglage). RACCOURCI MONO-NŒUD : `url` (+ `fingerprint`) au niveau provider
   reste accepté et équivaut à un pool d'un seul endpoint. `url` ET `urls`
   ensemble = erreur (ambigu) ; `fingerprint` global avec `urls` = erreur
   (l'empreinte doit être portée par chaque entrée du pool).

   Découpe (principe n°2 de CLAUDE.md) :
   - la validation PAR PROVIDER (id/kind/token, pool d'urls, défauts) est
     DÉLÉGUÉE à `ProviderConfigValidate` (classe pure partagée avec le CRUD de la
     DB `vm-providers.db` : mêmes messages d'erreur des deux côtés, zéro duplication).
   - `parse(rawJson)` = méthode statique PURE (aucun filesystem) : string → map
     validée au niveau DOCUMENT (JSON, racine, tableau `providers`, unicité des
     id), déléguant chaque provider à `ProviderConfigValidate`. Testable en isolation.
   - l'instance = fine enveloppe qui LIT le fichier dans un DOSSIER injecté (le
     même que la DB). C'est la source LEGACY (lecture seule) : quand la clé de
     chiffrement est présente, VmModule bascule sur `ProviderConfigDb` (DB) et ce
     fichier est migré puis renommé (cf. ProviderConfigDb.importLegacyFile).

   SÉCURITÉ (invariant de ce fichier) : le `token` n'apparaît JAMAIS dans un
   message d'erreur, un log ou un résumé — les messages citent l'`id` du provider
   (et le docId + l'index), jamais sa valeur secrète.
   ============================================================================= */

/** Nom du fichier de config, cherché DANS le dossier injecté (à côté de la DB). */
const PROVIDERS_FILE = "vm-providers.json";

export class ProviderConfigStore implements ProviderConfigSource {
  private readonly filePath: string;
  /** Config validée, indexée par docId. Vide = feature dormante (fichier absent ou aucun document). */
  private readonly byDoc: Map<string, ProviderConfig[]>;

  /** @param dir Dossier contenant `vm-providers.json` (le MÊME que la DB — injecté, jamais dérivé ici). */
  constructor(dir: string, private readonly log: Logger = new Logger("error")) {
    this.filePath = path.join(dir, PROVIDERS_FILE);
    this.byDoc = this.load();
  }

  /* --------------------------------------------------------------------------
     ENVELOPPE D'INSTANCE — lecture du fichier (fine couche autour de `parse`)
     -------------------------------------------------------------------------- */

  /** Providers configurés pour un document. Document absent du fichier → `[]`
      (feature dormante pour CE document). Copie défensive : l'appelant ne peut
      pas muter l'état interne du store. */
  providersFor(docId: string): ProviderConfig[] {
    const list = this.byDoc.get(docId);
    return list ? list.slice() : [];
  }

  /** Liste des docIds ayant au moins une entrée de config (utile au timer de synchro, T2.2). */
  configuredDocIds(): string[] {
    return [...this.byDoc.keys()];
  }

  /** Lit + valide le fichier. Deux « dormances » DISTINCTES d'une vraie erreur :
      - fichier ABSENT (ENOENT) → aucune instance pour aucun document (feature
        dormante GLOBALE, décision de cadrage) : PAS une erreur ;
      - fichier PRÉSENT mais invalide → on LÈVE (pas de silence trompeur qui
        laisserait croire la feature inactive alors que la config est cassée).
      Toute autre erreur d'IO (droits, fichier illisible) est aussi remontée. */
  private load(): Map<string, ProviderConfig[]> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.log.info("vm: aucun " + PROVIDERS_FILE + " (inventaire VM dormant)", this.filePath);
        return new Map();
      }
      // Le message d'IO ne contient jamais le CONTENU du fichier (donc jamais le token) : sûr à journaliser.
      throw new Error("vm: lecture de " + this.filePath + " impossible : " + ProviderConfigStore.errorMessage(err));
    }
    const byDoc = ProviderConfigStore.parse(raw);
    // Résumé volontairement CHIFFRÉ (compteurs) — aucun secret : ni token, ni id, ni url dans le log.
    this.log.info("vm: config providers chargée", "documents=" + byDoc.size, "providers=" + ProviderConfigStore.countProviders(byDoc));
    return byDoc;
  }

  /* --------------------------------------------------------------------------
     PARSING PUR (string → map validée) — testable sans filesystem
     -------------------------------------------------------------------------- */

  /** Parse ET valide le contenu JSON du fichier. Renvoie la map `docId → ProviderConfig[]`
      (défauts appliqués) ou LÈVE avec un message explicite RÉUNISSANT toutes les erreurs
      détectées (JSON invalide, racine non-objet, champ requis manquant/mal typé, id en
      double dans un document…). Le token n'est JAMAIS cité dans ces messages. */
  static parse(rawJson: string): Map<string, ProviderConfig[]> {
    let root: unknown;
    try {
      root = JSON.parse(rawJson);
    } catch (err) {
      throw new Error(PROVIDERS_FILE + " : JSON invalide (" + ProviderConfigStore.errorMessage(err) + ")");
    }
    if (!ProviderConfigValidate.isPlainObject(root)) {
      throw new Error(PROVIDERS_FILE + " : la racine doit être un objet { \"<docId>\": { providers: [...] } }");
    }

    const errors: string[] = [];
    const byDoc = new Map<string, ProviderConfig[]>();

    for (const docId of Object.keys(root)) {
      const entry = root[docId];
      if (!ProviderConfigValidate.isPlainObject(entry)) {
        errors.push(ProviderConfigValidate.docLabel(docId) + " : valeur attendue = objet { providers: [...] } (docName facultatif)");
        continue;
      }
      // `docName` toléré et IGNORÉ (lisibilité du fichier édité à la main) ; toute autre clé
      // inconnue au niveau document est également ignorée — seul `providers` est exploité.
      const providersRaw = entry["providers"];
      if (!Array.isArray(providersRaw)) {
        errors.push(ProviderConfigValidate.docLabel(docId) + " : champ « providers » requis (tableau)");
        continue;
      }

      const providers: ProviderConfig[] = [];
      const seenIds = new Set<string>();
      providersRaw.forEach((rawProvider, index) => {
        // Validation PAR PROVIDER déléguée (mêmes règles/messages que le CRUD de la DB).
        const parsed = ProviderConfigValidate.parseProvider(docId, index, rawProvider, errors);
        if (parsed === null) return;
        // UNICITÉ des id PAR document (doublon = erreur) : deux clusters ne peuvent partager
        // un id (c'est la clé de réconciliation VmRecord.provider_id).
        if (seenIds.has(parsed.id)) {
          errors.push(ProviderConfigValidate.providerLabel(docId, index, parsed.id) + " : identifiant « id » en double dans le document (unicité requise)");
          return;
        }
        seenIds.add(parsed.id);
        providers.push(parsed);
      });
      byDoc.set(docId, providers);
    }

    if (errors.length > 0) {
      throw new Error(PROVIDERS_FILE + " invalide :\n- " + errors.join("\n- "));
    }
    return byDoc;
  }

  /* --------------------------------------------------------------------------
     Helpers internes (privés) — résumé de log + message d'erreur
     -------------------------------------------------------------------------- */

  /** Nombre total de providers configurés (résumé de log sans secret). */
  private static countProviders(byDoc: Map<string, ProviderConfig[]>): number {
    let total = 0;
    for (const list of byDoc.values()) total += list.length;
    return total;
  }

  /** Message lisible d'une erreur inconnue (sans jamais exposer de contenu de fichier). */
  private static errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
