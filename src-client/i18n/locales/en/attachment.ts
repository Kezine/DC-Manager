/* ============================================================================
   Domain `attachment` — ENGLISH (calques `fr/attachment.ts`). ATTACHMENTS
   (collection `attachments`, batch B): create/edit form (`Forms.attachment`),
   "Attachments" section of the carrier sheets and shared bricks (`AttachmentUi`).
   The detail sheet lives in `detail.attachment.*`, columns/filters in `lists.*`,
   the tab in `tabs.attachments.*`. Aggregated by `../en.ts`. */
export const attachment = {
  form: {
    namePlaceholder: "2026 loan agreement, Purchase order…",
    file: "File",
    fileHint: "PDF, image, office document or text — 50 MB maximum. The binary lives outside the document.",
    editLocked: "The file cannot be replaced: to change the binary, delete the attachment and recreate it.",
    target: "Target",
    targetHint: "Equipment OR sub-equipment to attach the file to (optional).",
    familyEquipment: "Equipment",
    familySubEquipment: "Sub-equipment",
    titleNew: "New attachment",
    titleEdit: "Edit attachment",
    created: "Attachment created",
    updated: "Attachment updated",
    fileRequired: "Choose a file to attach.",
    uploadFailed: "File upload failed.",
    blobFailed: "Binary storage failed — the attachment was not created.",
    noStore: "Attachment storage unavailable.",
  },
  // "Attachments" section of the carrier sheets (equipment / sub-equipment).
  section: "Attachments ({{count}})",
  openDetail: "Open the attachment's detail sheet",
  binaryMissing: "This attachment's binary could not be found.",
  // Built-in VIEWER (batch B): image/text/markdown/PDF rendering in the modal stack.
  view: {
    title: "Attachment",
    truncated: "Display truncated — download for the full file.",
    readError: "This attachment's content could not be read.",
    notViewable: "This file type cannot be displayed — download it to open it.",
    // Image policy D-B3: a markdown's external images are neutralized by default.
    showExternalImages_one: "Show external image",
    showExternalImages_other: "Show the {{count}} external images",
    externalImageTitle: "External image neutralized — click to open its source in a new tab.",
  },
  // Detail-sheet pill flagging that the target is a SUB-EQUIPMENT (vs equipment).
  targetSubEquipmentPill: "Sub-equipment",
} as const;
