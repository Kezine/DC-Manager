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
  // Detail-sheet pill flagging that the target is a SUB-EQUIPMENT (vs equipment).
  targetSubEquipmentPill: "Sub-equipment",
} as const;
