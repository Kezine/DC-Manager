/* =============================================================================
   TerminationSpareSource — la SOURCE de candidats du sélecteur de PIÈCE du
   dialogue de terminaison (`FormBase.configureTermination`, docs/terminaisons.md).

   POURQUOI une source dédiée. Le sélecteur propose les transceivers qui peuvent
   occuper la cage : ceux DÉJÀ AFFECTÉS à l'équipement et ceux du STOCK. Or
   `spares` est une collection PARESSEUSE en mode API (garde G7, vague 4 du
   lazy-load) : `store.all("spares")` mentirait (`[]` tant que rien n'est
   absorbé), donc le régime SYNC d'`EntityPicker` est impossible ici. Le régime
   ASYNC, lui, attend une source qui répond à « quels candidats pour cette
   saisie ? » et « comment s'appelle la valeur courante ? » — c'est ce contrat
   (`core/EntityPickerSource.EntityPickerCandidates`) que cette classe remplit,
   sur des lignes chargées UNE fois par les jumeaux async du Store (injectés).

   ⚠ Cette source porte des RÈGLES d'options, contrairement à la source
   standard `CollectionPickerSource` (parcours brut d'une collection) : le filtre
   `type === "transceiver"`, l'entrée de TÊTE « transceiver générique » et les
   candidats `disabled` (une pièce déjà logée dans une AUTRE cage, nommée). La
   doctrine « dès qu'une règle d'options existe, c'est le régime sync » ne peut
   pas s'appliquer à une collection lazy : la règle est donc calculée ICI, côté
   client, sur un lot borné (les pièces de l'équipement + le stock) — jamais
   déportée au serveur, et jamais lue au cache synchrone.

   LE « DUMMY » (amendement de l'utilisateur à Q5.9) : l'entrée de tête vaut
   `OptionSearch.EMPTY_VALUE` (""), le « rien de choisi » du contrôle. La
   choisir = ne lier AUCUNE pièce : un transceiver générique n'a AUCUNE
   existence en base — le média présenté vit sur le port, et c'est tout ce qu'il
   faut à un câblage structurellement correct. Elle n'apparaît qu'au PARCOURS
   (requête vide), ou quand la saisie la nomme.

   Module PUR (aucun DOM, aucun Store importé — lecteur injecté), testable en
   Node (`Tests/modules/test-terminaisons.js`).
   ============================================================================= */
import { OptionSearch } from "./OptionSearch";
import type { PickableOption } from "./OptionSearch";
import type { EntityPickerBatch, EntityPickerCandidates } from "./EntityPickerSource";
import { Schema } from "../../src-shared/Schema";

/** Ce que la source LIT — découplé du vrai Store (le harnais Node le remplit d'un bouchon). */
export interface TerminationSpareReader {
  /** Les candidats BRUTS (la source filtre les transceivers et dédoublonne) : transceivers affectés à
      l'équipement + pièces disponibles, par les jumeaux ASYNC du Store — jamais `all("spares")`. */
  candidates(): Promise<any[]>;
  /** Lecture SYNCHRONE au cache (libellé de la valeur courante) — null si absente. */
  get(id: string): any | null;
  /** Lecture unitaire ASYNC (valeur hors cache, absorbée) — null si introuvable. */
  fetchOne(id: string): Promise<any | null>;
  /** Nom d'un port (la cage qu'occupe déjà une pièce) — null si inconnu. */
  portName(portId: string): string | null;
}

/** Libellés INJECTÉS (traduits par l'appelant : un module pur ne produit pas de français). */
export interface TerminationSpareLabels {
  /** Entrée de tête : « Transceiver générique (non inventorié) ». */
  generic: string;
  /** Libellé d'une pièce (désignation). */
  spare(record: any): string;
  /** Pièce déjà logée dans une AUTRE cage : « <pièce> — déjà dans la cage <port> ». */
  otherCage(spareLabel: string, portName: string): string;
}

export class TerminationSpareSource implements EntityPickerCandidates {
  /** Type de pièce qui occupe une cage — le SEUL admis (miroir de l'invariant partagé de `spares`). */
  static readonly TRANSCEIVER = "transceiver";
  /** Filtrage LOCAL sur des candidats déjà chargés : aucun réseau à ménager (parité `EntityPicker.build`). */
  readonly debounceMs = 0;
  /** Chargement UNIQUE des candidats (promesse mémoïsée) : le dialogue est court, ses lignes ne bougent pas. */
  private loaded: Promise<any[]> | null = null;
  /** Candidats retenus, par id — libellé SYNCHRONE de la valeur courante, pièce lue pour l'avertissement. */
  private readonly byId = new Map<string, any>();

  constructor(
    private readonly reader: TerminationSpareReader,
    /** La cage du dialogue : une pièce qui l'occupe DÉJÀ est la valeur courante, pas un candidat grisé. */
    private readonly portId: string,
    private readonly labels: TerminationSpareLabels,
    private readonly limit: number = OptionSearch.DEFAULT_LIMIT,
  ) {}

  /** Charge (une fois) et retient les TRANSCEIVERS, dédoublonnés (deux lectures peuvent se recouper), triés par
      libellé normalisé — même normalisation que la recherche (casse et accents repliés). */
  load(): Promise<any[]> {
    if (!this.loaded) {
      this.loaded = this.reader.candidates().then((rows) => {
        const kept: any[] = [];
        for (const row of rows || []) {
          if (!row || !row.id || row.type !== TerminationSpareSource.TRANSCEIVER || this.byId.has(row.id)) continue;
          this.byId.set(row.id, row);
          kept.push(row);
        }
        return kept.sort((a, b) => TerminationSpareSource.compareLabels(this.labels.spare(a), this.labels.spare(b)));
      });
    }
    return this.loaded;
  }

  /** La pièce qui occupe DÉJÀ cette cage (`assigned_port_id` = le port du dialogue), sinon null. */
  async currentSpareId(): Promise<string | null> {
    const current = (await this.load()).find((row) => row.assigned_port_id === this.portId);
    return current ? current.id : null;
  }

  /** Une pièce retenue (ou au cache), pour l'avertissement pièce ⇄ cage/média du dialogue. */
  record(id: string): any | null {
    return this.byId.get(id) || this.reader.get(id) || null;
  }

  /** Candidats de la saisie : tête « générique » + transceivers filtrés sur le libellé (normalisation partagée
      `Schema.normSearch`, plafond ANNONCÉ — jamais tu). */
  async fetch(query: string): Promise<EntityPickerBatch> {
    const rows = await this.load();
    const options = rows.map((row) => this.toOption(row));
    const outcome = OptionSearch.filter(options, query, { normalize: Schema.normSearch, limit: this.limit });
    const needle = Schema.normSearch(String(query == null ? "" : query).trim());
    const shown: PickableOption[] = [];
    // La tête est un ÉTAT (« aucune pièce »), pas une entité : `OptionSearch.filter` l'écarte toujours — on la
    // remet en tête au parcours, ou quand la saisie la nomme (sinon l'utilisateur cherche une VRAIE pièce).
    if (needle === "" || Schema.normSearch(this.labels.generic).includes(needle)) shown.push({ value: OptionSearch.EMPTY_VALUE, label: this.labels.generic });
    return { options: shown.concat(outcome.shown), hidden: outcome.hidden };
  }

  labelOf(id: string): string | null {
    const record = this.record(id);
    return record ? this.labels.spare(record) : null;
  }

  async resolveLabel(id: string): Promise<string | null> {
    const record = await this.reader.fetchOne(id);
    return record ? this.labels.spare(record) : null;
  }

  /** Une pièce → une option ; logée dans une AUTRE cage ⇒ `disabled`, la cage NOMMÉE (le « pourquoi pas »). */
  private toOption(row: any): PickableOption {
    const label = this.labels.spare(row);
    if (row.assigned_port_id && row.assigned_port_id !== this.portId) {
      return { value: row.id, label: this.labels.otherCage(label, this.reader.portName(row.assigned_port_id) || "?"), disabled: true };
    }
    return { value: row.id, label };
  }

  private static compareLabels(a: string, b: string): number {
    const left = Schema.normSearch(a), right = Schema.normSearch(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
}
