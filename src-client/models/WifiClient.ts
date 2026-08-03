import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";
import { WifiSync } from "../../src-shared/WifiSync";

/** CLIENT WIFI vu par un contrôleur (UniFi en première implémentation — la marque n'est qu'un
    ADAPTATEUR côté serveur, cf. docs/wifi-unifi.md) — collection AMOVIBLE (le cœur n'en dépend
    jamais). Ne porte QUE ce qu'un client sans fil a de pertinent : ni placé en 2D/3D, ni câblé,
    ni compté dans le power ou les spares. Alimenté par la synchro serveur ; en MODE FICHIER la
    collection reste lisible et cherchable (records déjà synchronisés puis exportés), mais aucune
    synchro n'a lieu — écart au principe n°15 DOCUMENTÉ (docs/wifi-unifi.md § « Mode local »).

    Frontière SOURCE / LOCAUX (décision de cadrage D1) :
    - champs SOURCE : ÉCRASÉS à chaque synchro (réconciliation par `ext_id`) ;
    - champs LOCAUX : enrichissements JAMAIS touchés par la synchro (notes, description). */
export class WifiClient extends Entity implements Records.WifiClient {
  /* ---- champs SOURCE (écrasés par la synchro) ---- */
  /** Identité STABLE côté contrôleur — clé de RÉCONCILIATION create/update/déconnexion. */
  ext_id: string;
  /** Instance d'adaptateur/contrôleur d'origine (multi-contrôleurs par document). */
  provider_id: string;
  /** Nom d'affichage remonté par le contrôleur. "" est FRÉQUENT (client sans hostname) :
      l'UI replie alors sur la MAC — jamais sur un « ? » qui n'apprendrait rien. */
  name: string;
  /** Adresse MAC du client — l'identité physique, et le repli d'affichage du nom. */
  mac: string;
  /** Adresse IP CONSTATÉE (bail courant). Donnée SOURCE informative : aucun enregistrement
      `ipAddresses` n'est créé par la synchro (non-but du cadrage). */
  ip: string;
  /** Nature du raccordement — champ TOLÉRANT (« wireless »/« wired »/valeur inconnue conservée). */
  client_type: string;
  /** SSID rejoint ("" pour un client filaire ou si le contrôleur ne le remonte pas). */
  ssid: string;
  /** MAC du point d'accès porteur. */
  ap_mac: string;
  /** Nom du point d'accès côté contrôleur (base du rapprochement vers `ap_equipment_id`). */
  ap_name: string;
  /** Début de la connexion courante (ISO). Distingue un vrai RETOUR d'une présence continue. */
  connected_since: string;
  /** Client DISPARU de l'inventaire à la dernière synchro. ⚠ Côté wifi cela signifie
      « DÉCONNECTÉ » (l'API ne liste que les clients connectés) — jamais un incident, et jamais
      une suppression : l'enregistrement survit avec ses enrichissements locaux. */
  orphan: boolean;
  /** Horodatage ISO de la dernière synchro ayant touché cet enregistrement. */
  last_sync: string;

  /* ---- champs LOCAUX (jamais touchés par la synchro) ---- */
  /** Note libre d'enrichissement (saisie utilisateur). */
  notes: string;
  /** FK → equipments : point d'accès rapproché. Champ DÉRIVÉ par la synchro (re-résolu du nom
      d'AP à CHAQUE passe — non éditable, la synchro est la source de vérité). Détaché en cascade
      à la suppression de l'équipement (re-résolu à la synchro suivante si un homonyme réapparaît). */
  ap_equipment_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    /* --- SOURCE --- normalisation PARTAGÉE (WifiSync.normalizeSource). Une SEULE définition de
       la sémantique, commune au modèle client et au diff de réconciliation serveur : un écart de
       normalisation entre les deux côtés créerait de FAUX deltas à chaque synchro. */
    const src = WifiSync.normalizeSource(p);
    this.ext_id = src.ext_id;
    this.provider_id = src.provider_id;
    this.name = src.name;
    this.mac = src.mac;
    this.ip = src.ip;
    this.client_type = src.client_type;
    this.ssid = src.ssid;
    this.ap_mac = src.ap_mac;
    this.ap_name = src.ap_name;
    this.connected_since = src.connected_since;
    this.orphan = src.orphan;
    this.last_sync = src.last_sync;
    /* --- LOCAUX --- (`description` est héritée d'Entity) */
    this.notes = p.notes || "";
    this.ap_equipment_id = p.ap_equipment_id || null;
  }

  /** Libellé d'affichage : le nom remonté, sinon la MAC. Règle UNIQUE (listing, fiche, palette
      de recherche) — la dupliquer laisserait les trois diverger au premier ajustement. Rend ""
      si l'enregistrement n'a ni nom ni MAC (l'appelant décide alors de son propre repli). */
  static displayName(client: { name?: string; mac?: string } | null | undefined): string {
    if (!client) return "";
    return (client.name || "").trim() || (client.mac || "").trim();
  }
}
