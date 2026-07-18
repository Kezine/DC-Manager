/* =============================================================================
   ESTAMPILLAGE D'AUDIT — règles PURES « qui a écrit, quand » posées PAR LE SERVEUR.

   Le serveur est SEUL AUTORITAIRE sur les quatre champs d'audit d'un enregistrement
   du cœur (blob JSON) : `created_by` / `updated_by` (id CANONIQUE de l'auteur, cf.
   UserProfiles.canonicalId — String(id) SSO sinon login) et `created_date` /
   `updated_date` (horodatage serveur, arbitrage Q9 : en mode API les dates ne sont
   plus celles du client). Cette classe centralise la règle (principe n°2/n°3) : le
   CRUD, le lot `/transact` et les updates de CASCADE d'un `DELETE` l'appliquent tous,
   sans la dupliquer. La restauration de snapshot, elle, NE l'appelle PAS (arbitrage
   Q7 : l'audit contenu dans le snapshot est restauré tel quel).

   POURQUOI le serveur écrase les valeurs client : sans ça, un client (ou un import
   forgé) pourrait se faire passer pour un autre auteur ou antidater une création.
   Les valeurs d'audit envoyées par le client sont donc SYSTÉMATIQUEMENT neutralisées.

   Fonction PURE (aucune I/O), idempotente et sans mutation de l'entrée → testable en
   isolation. Voir docs/user-resolver.md (section « Estampillage d'audit ») et
   docs/persistance.md. Les modules à colonnes typées (certs/notify/vm-providers)
   posent leurs `created_by`/`updated_by` en SQL et réutilisent `AuditStamp.author`.
   ============================================================================= */
export class AuditStamp {
  /** Noms canoniques des champs d'audit du blob (une seule source pour éviter les fautes de frappe). */
  static readonly CREATED_BY = "created_by";
  static readonly UPDATED_BY = "updated_by";
  static readonly CREATED_DATE = "created_date";
  static readonly UPDATED_DATE = "updated_date";

  /** Normalise un id d'auteur : chaîne NON VIDE, sinon `null` (aucune identité résoluble — cas
      dégénéré d'un profil SSO sans id ni login, ou mode fichier). Définit ce que « auteur présent »
      veut dire, PARTAGÉ par le cœur (cette classe) et les modules à colonnes typées. */
  static author(authorId: unknown): string | null {
    return typeof authorId === "string" && authorId !== "" ? authorId : null;
  }

  /** Applique les règles d'estampillage sur `incoming` et renvoie une COPIE estampillée (l'entrée
      n'est jamais mutée).

      @param incoming  enregistrement à écrire (déjà normalisé/validé).
      @param existing  enregistrement ACTUELLEMENT en base → MISE À JOUR ; `null` → CRÉATION.
      @param authorId  id CANONIQUE de l'auteur (`RequestAuthor.identity(req).id`), "" = pas d'identité.
      @param nowIso    horodatage serveur ISO (créé/mis à jour).

      Règles :
      - CRÉATION : `created_by = updated_by = id`, `created_date = updated_date = nowIso`
        (les valeurs client de ces champs sont ÉCRASÉES) ;
      - MISE À JOUR : `created_by`/`created_date` REPRIS de l'existant (immuables ; ABSENTS d'un
        enregistrement legacy → restent absents), `updated_by = id`, `updated_date = nowIso` ;
      - id VIDE (dégénéré) : on ne POSE PAS les `_by` (à la création ils restent absents ; à la mise
        à jour on conserve le dernier auteur connu de l'existant) — les DATES, elles, sont toujours posées. */
  static apply(incoming: Record<string, any>, existing: Record<string, any> | null,
               authorId: unknown, nowIso: string): Record<string, any> {
    const out: Record<string, any> = { ...(incoming || {}) };
    const id = AuditStamp.author(authorId);

    // -- Dates : le SERVEUR fait autorité (mode API). `created` figé (repris de l'existant en mise à
    //    jour, absent d'un legacy → reste absent) ; `updated` rafraîchi à CHAQUE écriture. --
    if (existing) AuditStamp.inheritOrDrop(out, existing, AuditStamp.CREATED_DATE);
    else out[AuditStamp.CREATED_DATE] = nowIso;
    out[AuditStamp.UPDATED_DATE] = nowIso;

    // -- Auteurs : id canonique du serveur ; une valeur envoyée par le client est TOUJOURS neutralisée. --
    if (existing) AuditStamp.inheritOrDrop(out, existing, AuditStamp.CREATED_BY);   // créateur immuable
    else if (id !== null) out[AuditStamp.CREATED_BY] = id;
    else delete out[AuditStamp.CREATED_BY];

    if (id !== null) out[AuditStamp.UPDATED_BY] = id;
    else if (existing) AuditStamp.inheritOrDrop(out, existing, AuditStamp.UPDATED_BY);   // pas d'auteur → dernier connu
    else delete out[AuditStamp.UPDATED_BY];

    return out;
  }

  /** Reprend `field` depuis `existing` (immuabilité du créateur / neutralisation d'une valeur client),
      ou le SUPPRIME de `out` si l'existant ne le porte pas (enregistrement legacy → champ absent).
      Un champ « vide » (undefined/null/"") de l'existant équivaut à absent. */
  private static inheritOrDrop(out: Record<string, any>, existing: Record<string, any>, field: string): void {
    const value = existing[field];
    if (value === undefined || value === null || value === "") delete out[field];
    else out[field] = value;
  }
}
