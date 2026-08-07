/* ============================================================================
   Domain `tracker` — ENGLISH. Calque EXACT de `fr/tracker.ts` (le français est la
   langue de référence — cf. docs/i18n.md). Toute clé ajoutée d'un côté doit
   l'être de l'autre : le test de complétude `test-i18n.js` compare les deux
   catalogues récursivement.

   Comme côté français, AUCUN libellé ne nomme un tracker : les noms de marque
   vivent dans le `<select>` de type, non traduits. Et le STATUT d'un ticket n'est
   jamais traduit (décision D3) — seule sa catégorie l'est, dans `domain`. */
export const tracker = {
  // Header actions of the Interventions view — API mode AND non-viewer (both write).
  action: {
    sync: "Synchronise",
    syncTitle: "Send the pending updates and read back the state of the issues from the trackers configured for this document",
    syncing: "Synchronising…",
    syncDone: "Synchronisation complete",
    syncFailed: "Synchronisation failed — {{detail}}",
    providers: "Providers…",
    providersTitle: "Configure the destination trackers (instance, service account, token, project, interval)",
  },
  // "Issue" block of an intervention detail card. ⚠ `notFoundTitle` explains the same mechanism as
  // `vm.orphanTitle` and `wifi.disconnectedTitle`, with a THIRD meaning: an issue that can no longer
  // be resolved signals a deletion, an archived project or a lost permission.
  ticket: {
    section: "Issue",
    notFoundTitle: "Not resolved at the last synchronisation — deleted, archived project or lost permission. The intervention and its content are kept here, and the issue will come back if access is restored.",
    assignee: "Assignee",
    unassigned: "Unassigned",
    lastSync: "Last state read",
    never: "Never",
    // PUSH STATE: what DC Manager knows about sending ITS content to the issue.
    push: {
      label: "Issue content",
      synced: "Up to date",
      pending: "Send pending",
      error: "Send failed",
      none: "Never sent",
    },
    update: "Update the issue",
    updated: "Issue updated",
    // BOOTSTRAP — two mutually exclusive cases (cf. the TrackerTicketBlock header).
    replicate: "Replicate to the tracker",
    replicateHint: "Creates the issue in the tracker, then follows its handling. The project and issue type come from the provider configuration.",
    replicated: "Intervention replicated",
    link: "Link the existing issue",
    linkHint: "An issue reference is already set on this intervention ({{reference}}): it will be ADOPTED rather than duplicated by a new issue.",
    linkConfirmTitle: "Link this existing issue?",
    linkConfirmMessage: "Adopt issue “{{reference}}” for this intervention? DC Manager owns the CONTENT: the title and description of the intervention WILL OVERWRITE the summary and description of that issue at the next update. If the issue was created by another source, its current content will be lost.",
    linkConfirm: "Link the issue",
    providerField: "Destination tracker",
    providerHint: "This document is linked to several trackers: pick the one to replicate to.",
    // FAILURE after an actual creation: the issue EXISTS in the tracker but the local state did not
    // follow. The message carries the KEY — the only thing that makes the situation recoverable.
    createdOrphan: "Issue “{{key}}” exists in the tracker but the intervention could not be updated here. Set reference “{{key}}” on the intervention, then use “Link the existing issue”. Details: {{detail}}",
  },
  // Push failure indicator in the LISTING (issue column) — tooltip = the tracker message.
  list: {
    pushErrorTitle: "Content send failed — {{detail}}",
  },
  providers: {
    title: "Replication providers",
    subtitle: "Manage the destination trackers of this document",
    loading: "Loading providers…",
    loadError: "Could not load providers — {{detail}}",
    intro: "Trackers where the incidents and interventions of this document are replicated. API tokens are encrypted server-side and are never displayed again.",
    empty: "No provider configured for this document. Add one to start replicating incidents and interventions.",
    intervalManual: "manual",
    colProvider: "Provider",
    colType: "Type",
    colUrl: "Instance",
    colAccount: "Account",
    colInterval: "Interval",
    colTimeout: "Timeout",
    add: "+ Add a provider",
    back: "← Back to the list",
    headingEdit: "Edit “{{id}}”",
    headingNew: "New provider",
    idPlaceholder: "e.g. jira-infra",
    idField: "Provider identifier",
    idHintEdit: "Immutable — it is the key referenced by the interventions already replicated.",
    idHintNew: "Unique per document (referenced by the replicated interventions).",
    typeField: "Tracker type",
    typeHint: "Determines the adapter used and the options shown below.",
    urlField: "Instance URL",
    urlPlaceholder: "https://example.atlassian.net",
    urlHint: "https URL of the instance (without any API path). The token travels in a header on every request: https is mandatory.",
    accountField: "Service account",
    accountPlaceholder: "service-dcmanager@example.com",
    accountHint: "Identifier of the account the token belongs to (usually its e-mail address). This is not a secret: it is displayed again when editing.",
    tokenPlaceholderEdit: "unchanged if empty",
    tokenPlaceholderNew: "API token (required)",
    tokenField: "API token",
    tokenHintEdit: "Leave empty to keep the current token. The token is never displayed again.",
    tokenHintNew: "API token of the service account, created in the tracker. It is encrypted server-side. Prefer a dedicated account with rights limited to the target project.",
    intervalField: "Sync interval (s)",
    intervalHint: "0 = manual synchronisation only. Set it high: one pass sends the pending updates then reads back the state of the replicated issues, and an issue's state moves slowly.",
    timeoutField: "Request timeout (s)",
    timeoutHint: "Maximum duration of one request to the tracker. A request travels the Internet: be generous.",
    opt: {
      section: "{{kind}} options",
      projectField: "Destination project",
      projectHint: "Project where DC Manager incidents and interventions are replicated. Required: without a destination, replication has nowhere to write.",
      projectPlaceholder: "e.g. INFRA",
      typeIncidentField: "Issue type — incidents",
      typeIncidentHint: "Type applied to replicated INCIDENTS. The label depends on the project configuration and its language; an unknown type makes the tracker reject the creation.",
      typeIncidentPlaceholder: "Incident",
      typeInterventionField: "Issue type — interventions",
      typeInterventionHint: "Type applied to replicated INTERVENTIONS. Same caveat as for incidents: this is a project setting, not an enumeration.",
      typeInterventionPlaceholder: "Infrastructure",
      autoReplicateField: "Replicate automatically",
      autoReplicateHint: "Creates the issue as soon as an incident or intervention is saved. An unavailable tracker never blocks saving: the push is retried at the next synchronisation.",
    },
    test: "Test the connection",
    testing: "Testing…",
    testConnOk: "Connection OK",
    testConnFail: "Connection failed",
    testApiOk: "API recognised",
    testApiWarn: "API to be checked",
    idRequired: "Provider identifier required",
    savedUpdated: "Provider updated",
    savedCreated: "Provider created",
    deleteTitle: "Delete this provider?",
    deleteMessage: "Delete provider “{{id}}”? The interventions already replicated keep their issue and its reference, but their state will stop being refreshed.",
    deleted: "Provider deleted",
    disabledTitle: "Provider management unavailable",
    disabledDetail: "Provider management from the UI is disabled server-side. Set the secrets encryption key (DCMANAGER_SECRETS_KEY) in the server environment to enable it.",
  },
} as const;
