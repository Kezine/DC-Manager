/* =============================================================================
   design-system/build.js — GÉNÉRATEUR des previews de la galerie design-system.

   Rôle : RÉGÉNÉRER intégralement `design-system/previews/<groupe>/<carte>.html`
   à partir de deux sources de vérité :
     1. le CSS COURANT de l'app  → `src-client/styles/dc-manager.css` (inliné EN
        ENTIER dans chaque preview : la galerie claude.ai ne peut charger aucune
        ressource relative de façon fiable → autonomie totale exigée) ;
     2. les TEMPLATES              → `design-system/templates/**.html` (le markup de
        chaque carte, miroir fidèle des primitives TS de `src-client/ui/`).

   Les previews sont DÉRIVÉES : on ne les édite JAMAIS à la main. Toute évolution
   d'une primitive UI (classe, structure DOM) se répercute en modifiant le template
   ou la primitive, puis en RELANÇANT `node design-system/build.js` (esprit du
   principe n°13 « doc à jour »).

   Aucune dépendance externe (Node pur, CommonJS) : le script tourne sans install.

   ICÔNES : les SVG vivent dans `src-client/ui/Icons.ts` (constantes statiques).
   Stratégie à deux temps (cf. loadIcons) :
     • si le compilé `dist-test/src-client/ui/Icons.js` existe (après `npm run test`)
       → `require` direct (source de vérité exécutable) ;
     • sinon → repli par EXTRACTION regex des `static readonly NOM = '<svg…>'` du
       source `.ts` (aucune compilation requise).

   THÈME : chaque preview démarre en SOMBRE (défaut app = absence de `data-theme`).
   Un bouton fixe ☀/🌙 bascule l'attribut `data-theme="light"` sur `<html>` — MÊME
   mécanisme que `applyTheme` de `src-client/app/main.ts` (le CSS thème via le
   sélecteur `[data-theme="light"]`).

   MARQUEUR : la PREMIÈRE ligne de chaque preview est
     <!-- @dsCard group="<Groupe>" name="<Nom>" subtitle="<variantes>" -->
   Elle est portée par la première ligne de chaque template et recopiée telle quelle.
   ============================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");                                   // DcManager/
const CSS_PATH = path.join(ROOT, "src-client", "styles", "dc-manager.css");
const ICONS_TS = path.join(ROOT, "src-client", "ui", "Icons.ts");
const ICONS_JS = path.join(ROOT, "dist-test", "src-client", "ui", "Icons.js");
const TEMPLATES_DIR = path.join(HERE, "templates");
const PREVIEWS_DIR = path.join(HERE, "previews");

/* ------------------------------------------------------------------ Icônes -- */

let ICON_SOURCE = "(aucune)";

/** Charge le registre d'icônes. Renvoie une map { NOM: '<svg…>' }. */
function loadIcons() {
  // Voie 1 — compilé exécutable (source de vérité). Icons.ts n'importe rien → le
  // module compilé est auto-suffisant et se `require` sans effet de bord.
  if (fs.existsSync(ICONS_JS)) {
    try {
      const mod = require(ICONS_JS);
      const Icons = mod.Icons || mod.default || mod;
      const out = {};
      Object.getOwnPropertyNames(Icons).forEach((k) => {
        const v = Icons[k];
        if (typeof v === "string" && v.trim().startsWith("<svg")) out[k] = v;
      });
      if (Object.keys(out).length) { ICON_SOURCE = "require(dist-test/…/Icons.js)"; return out; }
    } catch (_e) { /* repli sur la voie 2 */ }
  }
  // Voie 2 — extraction regex du source TS (aucune compilation nécessaire).
  const src = fs.readFileSync(ICONS_TS, "utf8");
  const out = {};
  const re = /static\s+readonly\s+([A-Z0-9_]+)\s*=\s*'(<svg[\s\S]*?<\/svg>)'/g;
  let m;
  while ((m = re.exec(src))) out[m[1]] = m[2];
  ICON_SOURCE = "regex(src-client/ui/Icons.ts)";
  return out;
}

/* ---------------------------------------------------------- Tokens de thème -- */

/** Extrait le corps `{ … }` du PREMIER bloc dont le sélecteur est `selector`. */
function blockBody(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** Parse un corps de bloc CSS en map ordonnée { --nom: valeur } (commentaires ôtés). */
function parseVars(body) {
  const map = new Map();
  body.replace(/\/\*[\s\S]*?\*\//g, "").split(";").forEach((decl) => {
    const m = decl.match(/(--[\w-]+)\s*:\s*(.+)/);
    if (m) map.set(m[1].trim(), m[2].trim());
  });
  return map;
}

/** Une valeur CSS est-elle une COULEUR affichable en pastille ? */
function isColor(v) { return /^(#|rgb|hsl|color-mix)/i.test(v); }

/* Catégories de tokens (ordre & libellés d'affichage). Un token de couleur non
   listé retombe dans « Autres ». */
const TOKEN_GROUPS = [
  { title: "Fonds", names: ["--bg", "--bg-2", "--bg-3"] },
  { title: "Lignes", names: ["--line", "--line-2"] },
  { title: "Textes", names: ["--fg", "--fg-dim", "--fg-dimmer"] },
  { title: "Accents & états", names: ["--accent", "--accent-2", "--ok", "--warn", "--err"] },
  { title: "Rôles (réseau)", names: ["--role-mgmt", "--role-data", "--role-power"] },
  { title: "Visualisation (équipement)", names: ["--viz-equip-bg", "--viz-equip-fg"] },
];

/* --------------------------------------------------------- Générateurs HTML -- */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Grille des tokens de couleur des DEUX thèmes (une pastille sombre + une claire,
    valeurs LITTÉRALES parsées → visibles quel que soit le thème de la page). */
function genColorTokens(dark, light) {
  const rendered = new Set();
  const row = (name) => {
    const d = dark.get(name);
    if (!d || !isColor(d)) return "";
    rendered.add(name);
    const l = light.has(name) ? light.get(name) : d;
    const inherited = !light.has(name);
    return `
      <div class="ds-swrow">
        <span class="ds-chip" style="background:${esc(d)}" title="${esc(d)}"></span>
        <span class="ds-chip" style="background:${esc(l)}" title="${esc(l)}"></span>
        <code class="ds-swname">${esc(name)}</code>
        <span class="ds-swval">${esc(d)}<span class="ds-sep">·</span>${esc(l)}${inherited ? '<span class="ds-inherit">hérité</span>' : ""}</span>
      </div>`;
  };
  let html = '<div class="ds-swhead"><span>Sombre</span><span>Clair</span><span>Token</span><span>Valeurs</span></div>';
  TOKEN_GROUPS.forEach((g) => {
    const rows = g.names.map(row).filter(Boolean).join("");
    if (rows) html += `<div class="ds-variant-title">${esc(g.title)}</div>${rows}`;
  });
  // Couleurs non catégorisées.
  const others = [];
  dark.forEach((v, name) => { if (isColor(v) && !rendered.has(name)) others.push(name); });
  if (others.length) html += `<div class="ds-variant-title">Autres</div>` + others.map(row).join("");
  // Tokens NON-couleur (rayons, grille, police).
  const misc = [];
  dark.forEach((v, name) => { if (!isColor(v)) misc.push([name, v]); });
  if (misc.length) {
    html += `<div class="ds-variant-title">Rayons &amp; divers (non-couleur)</div>`;
    html += misc.map(([n, v]) => `<div class="ds-swrow ds-swrow--misc"><code class="ds-swname">${esc(n)}</code><span class="ds-swval">${esc(v)}</span></div>`).join("");
  }
  return html;
}

/** Grille du registre COMPLET des icônes : nom + rendus 16 px et 24 px, en teintes
    courant / accent / danger (l'icône suit `currentColor`, cf. ui/Icons). */
function genIconsGrid(icons) {
  const names = Object.keys(icons).sort();
  const cell = (name) => `
      <div class="ds-ico-cell">
        <div class="ds-ico-name">${esc(name)}</div>
        <div class="ds-ico-renders">
          <span class="ds-ico ds-ico-16" title="16 px">${icons[name]}</span>
          <span class="ds-ico ds-ico-24" title="24 px courant">${icons[name]}</span>
          <span class="ds-ico ds-ico-24 ds-accent" title="24 px accent">${icons[name]}</span>
          <span class="ds-ico ds-ico-24 ds-danger" title="24 px danger">${icons[name]}</span>
        </div>
      </div>`;
  return `<div class="ds-ico-grid">${names.map(cell).join("")}</div>`;
}

/* ------------------------------------------------------------- Injection -- */

/** Remplace les jetons `{{…}}` d'un SEGMENT (hors commentaire). Jetons reconnus :
      {{COLOR_TOKENS}} · {{ICONS_GRID}} · {{MONO_STACK}} · {{ICON:NOM}}
    Un `{{ICON:NOM}}` inconnu lève une erreur (typo de template → build rouge). */
function injectSegment(seg, ctx) {
  let out = seg
    .replace(/\{\{COLOR_TOKENS\}\}/g, () => genColorTokens(ctx.dark, ctx.light))
    .replace(/\{\{ICONS_GRID\}\}/g, () => genIconsGrid(ctx.icons))
    .replace(/\{\{MONO_STACK\}\}/g, () => esc(ctx.dark.get("--mono") || ""));
  out = out.replace(/\{\{ICON:([A-Z0-9_]+)\}\}/g, (_m, name) => {
    if (!ctx.icons[name]) throw new Error(`Icône inconnue référencée par un template : {{ICON:${name}}}`);
    return ctx.icons[name];
  });
  return out;
}

/** Injecte les jetons d'un fragment de template. Les COMMENTAIRES HTML (`<!-- … -->`)
    sont préservés VERBATIM : ils documentent la carte et peuvent citer un jeton
    (`{{ICONS_GRID}}`) comme nom sans qu'il soit expansé (sinon la grille se
    dupliquerait dans le commentaire). Seul le markup hors commentaire est injecté. */
function inject(body, ctx) {
  return body.split(/(<!--[\s\S]*?-->)/).map((seg) =>
    seg.startsWith("<!--") ? seg : injectSegment(seg, ctx)
  ).join("");
}

/* -------------------------------------------------------- Gabarit de page -- */

/* Habillage MINIMAL propre à la galerie (préfixe `ds-` → JAMAIS confondu avec les
   classes de l'app ; exclu du lint de classes). Le fond de page vient du CSS de
   l'app (règle `body`, grille + halo) ; `.ds-page` se pose AU-DESSUS de `body::before`
   (z-index 1). Le bouton de thème reproduit `applyTheme` (attribut sur <html>). */
const CHROME_CSS = `
  /* ===================== HABILLAGE GALERIE (design-system) ===================== */
  .ds-page { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 20px 22px 60px; }
  .ds-card-head { margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .ds-card-group { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--fg-dimmer); }
  .ds-card-title { font-size: 18px; letter-spacing: 0.06em; font-weight: 700; color: var(--fg); margin-top: 4px; }
  .ds-card-title span { color: var(--accent); }
  .ds-card-sub { font-size: 12px; color: var(--fg-dim); margin-top: 3px; }
  .ds-section { margin: 26px 0 0; }
  .ds-section > h2 { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin: 0 0 12px; }
  .ds-variant-title { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fg-dim); margin: 18px 0 8px; }
  .ds-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .ds-row.ds-col { flex-direction: column; align-items: stretch; }
  .ds-note { font-size: 11px; color: var(--fg-dimmer); font-style: italic; margin: 6px 0 0; line-height: 1.5; }
  .ds-demo { position: relative; background: var(--bg); border: 1px dashed var(--line-2); border-radius: 8px; padding: 18px; }
  .ds-demo.ds-tight { padding: 12px; }
  .ds-field-w { max-width: 340px; }

  /* Pastilles de couleurs (carte Fondations) */
  .ds-swhead { display: grid; grid-template-columns: 40px 40px 190px 1fr; gap: 12px; align-items: center; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fg-dimmer); padding: 0 0 6px; }
  .ds-swrow { display: grid; grid-template-columns: 40px 40px 190px 1fr; gap: 12px; align-items: center; padding: 4px 0; }
  .ds-swrow--misc { grid-template-columns: 190px 1fr; }
  .ds-chip { width: 34px; height: 24px; border-radius: 4px; border: 1px solid var(--line-2); display: inline-block; }
  .ds-swname { font-family: var(--mono); font-size: 12px; color: var(--fg); }
  .ds-swval { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); }
  .ds-sep { color: var(--fg-dimmer); margin: 0 6px; }
  .ds-inherit { margin-left: 8px; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-dimmer); border: 1px solid var(--line-2); border-radius: 999px; padding: 0 6px; }

  /* Grille d'icônes (carte Icônes) */
  .ds-ico-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .ds-ico-cell { border: 1px solid var(--line); background: var(--bg-2); border-radius: 6px; padding: 10px 12px; }
  .ds-ico-name { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); margin-bottom: 8px; word-break: break-word; }
  .ds-ico-renders { display: flex; align-items: center; gap: 12px; }
  .ds-ico { display: inline-flex; align-items: center; justify-content: center; color: var(--fg); }
  .ds-ico svg { width: 100%; height: 100%; display: block; }
  .ds-ico-16 { width: 16px; height: 16px; }
  .ds-ico-24 { width: 24px; height: 24px; }
  .ds-accent { color: var(--accent); }
  .ds-danger { color: var(--err); }

  /* Typographie (carte Fondations) */
  .ds-type-row { display: flex; align-items: baseline; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .ds-type-meta { font-family: var(--mono); font-size: 10px; color: var(--fg-dimmer); min-width: 210px; }

  /* Bouton de bascule de thème (fixe) */
  .ds-theme-toggle { position: fixed; top: 12px; right: 12px; z-index: 5000; width: 40px; height: 40px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--bg-2); color: var(--fg); font-size: 18px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
  .ds-theme-toggle:hover { border-color: var(--accent); }
`;

/* Petit script INLINE (seul JS autorisé) : bascule `data-theme` sur <html>, à
   l'identique de `applyTheme` (light = attribut posé ; dark = attribut retiré). */
const THEME_SCRIPT = `
  (function () {
    var el = document.documentElement, btn = document.getElementById("ds-theme-toggle");
    function sync() { btn.textContent = el.getAttribute("data-theme") === "light" ? "\\u2600" : "\\u263D"; }
    btn.addEventListener("click", function () {
      if (el.getAttribute("data-theme") === "light") el.removeAttribute("data-theme");
      else el.setAttribute("data-theme", "light");
      sync();
    });
    sync();
  })();
`;

/** Assemble la page complète (marqueur en 1re ligne + document autonome). */
function renderPage(meta, marker, css, bodyHtml) {
  const title = "DC Manager — DS · " + meta.name;
  return `${marker}
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${css}
${CHROME_CSS}
</style>
</head>
<body>
<button type="button" id="ds-theme-toggle" class="ds-theme-toggle" aria-label="Basculer le thème clair / sombre" title="Basculer le thème"></button>
<div class="ds-page">
  <header class="ds-card-head">
    <div class="ds-card-group">${esc(meta.group)}</div>
    <div class="ds-card-title">${esc(meta.name)}</div>
    ${meta.subtitle ? `<div class="ds-card-sub">${esc(meta.subtitle)}</div>` : ""}
  </header>
${bodyHtml}
</div>
<script>${THEME_SCRIPT}</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------- Lint classes -- */

/** Ensemble des classes DÉFINIES dans le CSS de l'app (sélecteurs `.nom`). */
function cssClassSet(css) {
  const set = new Set();
  let m; const re = /\.(-?[_a-zA-Z][-\w]*)/g;
  while ((m = re.exec(css))) set.add(m[1]);
  return set;
}

/* Classes ACCROCHES JS (pas de style) : générées par les primitives réelles mais
   jamais dans le CSS car elles ne servent qu'au `querySelector` (ex. Modal._build →
   `.modal-save`/`.modal-cancel` câblés en JS). On les reproduit par fidélité et on
   les EXCLUT du lint pour qu'il reste ciblé sur les fautes de frappe de classes de
   STYLE. Toute entrée ici doit être une vraie accroche du code source. */
const KNOWN_HOOK_CLASSES = new Set(["modal-save", "modal-cancel"]);

/** Classes UTILISÉES dans un HTML (attributs `class="…"`), hors préfixe `ds-`
    (habillage propre à la galerie) et hors accroches JS connues. */
function usedClasses(html) {
  const set = new Set();
  let m; const re = /class="([^"]*)"/g;
  while ((m = re.exec(html))) m[1].split(/\s+/).forEach((c) => { if (c && !c.startsWith("ds-") && !KNOWN_HOOK_CLASSES.has(c)) set.add(c); });
  return set;
}

/* ------------------------------------------------------------------ Build -- */

/** Liste récursive des templates `.html` (chemins relatifs à TEMPLATES_DIR). */
function listTemplates(dir, base) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const abs = path.join(dir, e.name);
    const rel = base ? base + "/" + e.name : e.name;
    if (e.isDirectory()) out.push(...listTemplates(abs, rel));
    else if (e.name.endsWith(".html")) out.push(rel);
  });
  return out.sort();
}

function main() {
  // ⚠ STRIP du BOM UTF-8 : dc-manager.css commence par U+FEFF. Inliné tel quel AU MILIEU du
  // document (dans <style>), ce caractère n'est PAS du blanc pour le tokenizer CSS du navigateur :
  // il invalide la règle suivante, qui se trouve être `:root { … }` — TOUT le thème sombre était
  // avalé (fond blanc, monochrome), alors que `[data-theme="light"]`, règle distincte, survivait.
  // (Le parse de tokens ci-dessous, lui, est régex-tolérant et masquait le problème.)
  const css = fs.readFileSync(CSS_PATH, "utf8").replace(/^\uFEFF/, "");
  const icons = loadIcons();
  const dark = parseVars(blockBody(css, ":root"));
  const light = parseVars(blockBody(css, '[data-theme="light"]'));
  const ctx = { icons, dark, light };
  const classSet = cssClassSet(css);

  // Régénération PROPRE : on efface previews/ pour garantir l'idempotence (aucun
  // fichier périmé si un template disparaît).
  fs.rmSync(PREVIEWS_DIR, { recursive: true, force: true });

  const templates = listTemplates(TEMPLATES_DIR, "");
  const generated = [];
  const missingByFile = [];

  templates.forEach((rel) => {
    const raw = fs.readFileSync(path.join(TEMPLATES_DIR, rel), "utf8");
    const nl = raw.indexOf("\n");
    const marker = (nl >= 0 ? raw.slice(0, nl) : raw).trim();
    const rest = nl >= 0 ? raw.slice(nl + 1) : "";
    const mm = marker.match(/@dsCard\s+group="([^"]*)"\s+name="([^"]*)"(?:\s+subtitle="([^"]*)")?/);
    if (!mm) throw new Error(`Template sans marqueur @dsCard valide en 1re ligne : ${rel}`);
    const meta = { group: mm[1], name: mm[2], subtitle: mm[3] || "" };

    const bodyHtml = inject(rest, ctx);
    const page = renderPage(meta, marker, css, bodyHtml);
    // Garde-fou : aucun U+FEFF ne doit survivre dans une page générée (un BOM au milieu d'un
    // <style> casse le parse CSS du navigateur — cf. strip à la lecture du CSS ci-dessus).
    if (page.includes("\uFEFF")) throw new Error(`U+FEFF (BOM) résiduel dans la page générée : ${rel}`);

    const outPath = path.join(PREVIEWS_DIR, rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, page);
    generated.push({ group: meta.group, rel, name: meta.name });

    // Lint : classes utilisées ∉ CSS de l'app.
    const missing = [...usedClasses(page)].filter((c) => !classSet.has(c)).sort();
    if (missing.length) missingByFile.push({ rel, missing });
  });

  // ---- Rapport ----
  console.log("design-system/build.js");
  console.log("  Icônes         : " + Object.keys(icons).length + " (source : " + ICON_SOURCE + ")");
  console.log("  Tokens         : " + dark.size + " (:root) / " + light.size + " ([data-theme=light])");
  console.log("  Previews       : " + generated.length + " carte(s) régénérée(s)");
  generated.forEach((g) => console.log("    " + g.group.padEnd(24) + " → previews/" + g.rel));
  console.log("  Lint classes   : " + (missingByFile.length === 0
    ? "OK (toutes les classes non-`ds-` existent dans dc-manager.css)"
    : missingByFile.length + " fichier(s) avec classe(s) hors CSS :"));
  missingByFile.forEach((f) => console.log("    ⚠ " + f.rel + " : " + f.missing.join(", ")));
}

main();
