/* ============================================================================
   Domaine `scan` — ANGLAIS (calque de `../fr/scan.ts`, même structure — le test
   test-i18n.js échoue au moindre écart). UI du scan caméra : greffon de champ,
   viseur, avertissements des parseurs, états d'échec caméra. */
export const scan = {
  button: {
    label: "Scan — {{field}}",
    tip: "Scan (QR / barcode)",
  },
  viewfinder: {
    title: "Scan",
    freeTitle: "Scan a label",
    genericField: "Input field",
    hint: "Place the code inside the zone — move or resize it by its corners.",
    locked: "Code locked",
    engineLabel: "Engine",
    engineAuto: "Auto (native)",
    engineWasm: "WASM",
    badgeNative: "native engine",
    badgeWasm: "wasm engine",
    torch: "Torch",
    torchUnavailable: "Torch not available on this camera.",
    cameraNext: "Switch camera",
    recenter: "Recenter the decoding zone",
  },
  result: {
    decodedQr: "QR code decoded",
    decoded: "Code decoded",
    announce: "Code decoded: {{value}}",
    again: "Continue",
    validate: "Apply",
    copy: "Copy",
    copied: "Value copied",
    inject: "Insert into the last active field",
    openLink: "Open the link (new tab)",
  },
  warning: {
    empty: "Empty code — nothing to insert.",
    multiline: "Multi-line value — it does not fit a single-line field.",
    linklike: "This value looks like a link — probably the wrong code from the label sheet.",
  },
  error: {
    insecure: "The camera requires a secure context: HTTPS or localhost.",
    noCamera: "No camera detected on this device.",
    permissionBlocked: "Camera access is BLOCKED for this site: the prompt will not come back. Unblock it via the camera icon in the address bar (or the site settings) — scanning will resume automatically.",
    permissionDismissed: "Camera permission denied or dismissed — retry to prompt again.",
    retry: "Retry",
    generic: "Camera failure: {{name}} {{message}}",
    engineFailed: "The decoding engine could not start.",
  },
} as const;
