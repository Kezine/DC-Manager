/* Barrel de la couche d'accès aux données. */
export { FieldIndex } from "./FieldIndex";
export { DataAdapter } from "./DataAdapter";
export { BrowserStorageAdapter } from "./BrowserStorageAdapter";
export type { BrowserStorageOptions } from "./BrowserStorageAdapter";
export { RestAdapter } from "./RestAdapter";
export type { RestOptions } from "./RestAdapter";
export { ImageStore } from "./ImageStore";
export type { ImageRec, ImageMirror, LegacyImage } from "./ImageStore";
export { IdbImageBackend, RestImageBackend } from "./ImageBackend";
export type { ImageBackend } from "./ImageBackend";
export { PAGE_SIZE_DEFAULT, HISTORY_MAX, IDX_NULL, INDEX_SPEC } from "./config";
export type {
  RawRecord,
  Snapshot,
  Transaction,
  TxCreate,
  TxUpdate,
  TxDelete,
  Where,
  ListOptions,
  ListResult,
} from "./types";
