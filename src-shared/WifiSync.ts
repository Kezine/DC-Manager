/* =============================================================================
   SYNCHRO CLIENTS WIFI — FRONTIÈRE SOURCE / LOCAUX (code PARTAGÉ front ⇄ back, TS pur).

   Miroir STRICT de `VmSync.ts` pour la collection `wifiClients` (cadrage
   `.notes/toDos/wifi-clients-provider-unifi-cadrage-2026-08-03.md`, D1) : la
   collection sépare deux familles de champs —
   - champs SOURCE : alimentés par la synchro d'un provider wifi (contrôleur
     UniFi en première implémentation, cf. D9 : la marque n'est QU'un adaptateur),
     ÉCRASÉS à chaque réconciliation — l'utilisateur ne les édite jamais ;
   - champs LOCAUX : enrichissements utilisateur (`notes`, `description`), JAMAIS
     touchés par la synchro.

   Ce fichier est la SOURCE DE VÉRITÉ de cette frontière : le modèle client
   (`src-client/models/WifiClient.ts`) normalise ses champs source ici, et le
   moteur de réconciliation serveur (`src-server/src/wifi/WifiReconcile.ts`)
   n'écrase QUE les champs listés ici — une divergence de sémantique entre les
   deux côtés est ainsi impossible par construction (principe n°3, réutilisation).
   ⚠ Sans cette délégation, le modèle client normaliserait autrement que le diff
   serveur et la synchro produirait des FAUX DELTAS à chaque passe.

   AGNOSTIQUE DE LA MARQUE (D9) : aucun champ propre à UniFi ici. `client_type`
   reste une CHAÎNE tolérante (« wireless », « wired », valeur inconnue conservée
   telle quelle) plutôt qu'une énumération — un autre contrôleur (Aruba, Meraki,
   Ruckus…) nommera ses types autrement, et le pivot doit l'absorber sans rejeter.

   Portée `src-shared/` : TS PUR (ni DOM ni Node), compilé des DEUX côtés — front
   (résolution *bundler*) et serveur (NodeNext). Ce fichier n'importe rien : c'est
   un CONSTAT, pas une contrainte (l'isolement du DOSSIER, lui, reste permanent —
   cf. `CLAUDE.md` § « Code partagé front/back »). Un import relatif vers un autre
   fichier partagé serait AUTORISÉ, à condition IMPÉRATIVE d'écrire le
   spécificateur avec l'extension `.js`.
   ============================================================================= */

/** Les 12 champs SOURCE de l'entité `wifiClients`, sous leur forme normalisée. */
export interface WifiSourceFields {
  /** Identité STABLE côté contrôleur — clé de réconciliation (l'adaptateur décide
      ce qui la compose : l'adresse MAC est le candidat naturel côté UniFi). */
  ext_id: string;
  /** Instance d'adaptateur d'origine (`WifiProviderConfig.id`) — multi-contrôleurs. */
  provider_id: string;
  /** Nom d'affichage remonté par le contrôleur (hostname / alias). "" est FRÉQUENT
      (un client sans hostname) — l'UI replie alors sur la MAC, jamais sur "?" . */
  name: string;
  /** Adresse MAC du client — pivot de rapprochement naturel. */
  mac: string;
  /** Adresse IP CONSTATÉE (bail courant). Donnée SOURCE informative : aucun
      enregistrement `ipAddresses` n'est créé (non-but du cadrage §5). */
  ip: string;
  /** Nature du raccordement, TOLÉRANTE : « wireless » / « wired » / valeur inconnue
      conservée telle quelle (résilience aux marques et aux releases). */
  client_type: string;
  /** SSID du réseau sans fil rejoint ("" pour un client filaire). */
  ssid: string;
  /** MAC du point d'accès qui porte le client. */
  ap_mac: string;
  /** Nom du point d'accès côté contrôleur (rapproché d'un équipement DC Manager
      par NOM — cf. `ap_equipment_id`, champ DÉRIVÉ hors de cette liste). */
  ap_name: string;
  /** Horodatage ISO du début de la connexion courante — distingue un RETOUR d'une
      présence continue quand un client réapparaît après un passage « déconnecté ». */
  connected_since: string;
  /** Client DISPARU de l'inventaire à la dernière passe. ⚠ Sémantique D2 : côté
      wifi, ce n'est PAS un incident mais un simple « déconnecté » (l'API ne liste
      que les clients CONNECTÉS) — la mécanique est identique aux VMs (patch, jamais
      de delete), seul le LIBELLÉ UI change. */
  orphan: boolean;
  /** Horodatage ISO de la dernière synchro ayant touché cet enregistrement. */
  last_sync: string;
}

/** Liste CANONIQUE des champs source — le périmètre exact de ce que la synchro a le
    droit d'écraser. Tout champ de l'entité `wifiClients` HORS de cette liste est
    LOCAL (jamais touché), SAUF `ap_equipment_id` : champ DÉRIVÉ par la réconciliation,
    re-résolu du nom d'AP à CHAQUE synchro (décision D4 — la synchro est la source de
    vérité du rattachement, il n'y a pas d'édition utilisateur, cf. WifiReconcile).
    Un test d'invariant vérifie la cohérence de cette liste avec le modèle `WifiClient`. */
export const WIFI_SOURCE_FIELDS: readonly (keyof WifiSourceFields)[] = [
  "ext_id", "provider_id", "name", "mac", "ip", "client_type", "ssid",
  "ap_mac", "ap_name", "connected_since", "orphan", "last_sync",
];

export class WifiSync {
  /** Normalise les 12 champs SOURCE depuis des propriétés brutes — MÊMES patterns que
      les constructeurs d'entités (strings `|| ""`, booléens `=== true`). Utilisée par le
      constructeur de `WifiClient` (client) ET par le diff de réconciliation (serveur) :
      comparer deux états passés par cette normalisation élimine les faux écarts
      (undefined vs "", null vs ""…) qui feraient réécrire le document à chaque passe. */
  static normalizeSource(p: { [k: string]: any }): WifiSourceFields {
    return {
      ext_id: p.ext_id || "",
      provider_id: p.provider_id || "",
      name: p.name || "",
      mac: p.mac || "",
      ip: p.ip || "",
      client_type: p.client_type || "",
      ssid: p.ssid || "",
      ap_mac: p.ap_mac || "",
      ap_name: p.ap_name || "",
      connected_since: p.connected_since || "",
      orphan: p.orphan === true,
      last_sync: p.last_sync || "",
    };
  }

  /** Égalité d'UN champ source entre deux états NORMALISÉS. Comparaison par JSON :
      correcte ici car `normalizeSource` garantit des valeurs canoniques (chaînes
      jamais nulles, booléen strict). Forme IDENTIQUE à `VmSync.sourceEquals` — les
      deux frontières restent lisibles côte à côte. */
  static sourceEquals(a: WifiSourceFields, b: WifiSourceFields, field: keyof WifiSourceFields): boolean {
    return JSON.stringify(a[field]) === JSON.stringify(b[field]);
  }
}
