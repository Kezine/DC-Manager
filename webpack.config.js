/* eslint-disable */
const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const HtmlInlineScriptPlugin = require("html-inline-script-webpack-plugin");

/* Émet des fichiers STATIQUES (manifest PWA, service worker, icônes) dans dist/, TELS QUELS — sans les faire
   passer par le graphe de modules (le SW doit rester un fichier autonome à URL stable, non bundlé/inliné).
   Zéro dépendance : on lit la source et on ajoute l'asset à la compilation. `from` relatif à la racine projet. */
class EmitStaticAssetsPlugin {
  constructor(files) { this.files = files; }   // [{ from: "src/pwa/sw.js", to: "sw.js" }]
  apply(compiler) {
    const { RawSource } = compiler.webpack.sources;
    const STAGE = compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL;
    compiler.hooks.thisCompilation.tap("EmitStaticAssets", (compilation) => {
      compilation.hooks.processAssets.tap({ name: "EmitStaticAssets", stage: STAGE }, () => {
        for (const f of this.files) {
          const abs = path.resolve(__dirname, f.from);
          compilation.fileDependencies.add(abs);   // re-build en watch si la source change
          compilation.emitAsset(f.to, new RawSource(fs.readFileSync(abs)));
        }
      });
    });
  }
}

module.exports = (env, argv) => {
  const isProd = argv.mode === "production";
  return {
    entry: "./src/app/main.ts",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "dc-manager.[contenthash].js",
      publicPath: "auto",   // URLs d'assets RELATIVES → l'app se charge à la racine ou sous un sous-dossier (reverse-proxy)
      clean: true,
    },
    resolve: { extensions: [".ts", ".js"] },
    module: {
      rules: [
        { test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ },
        /* CSS injecté au runtime via style-loader → reste inclus dans le bundle JS,
           donc dans le HTML autonome (HtmlInlineScriptPlugin). */
        { test: /\.css$/, use: ["style-loader", "css-loader"] },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./src/index.html",
        filename: "dc-manager.html",
        inject: "body",
      }),
      /* En production : on RÉINJECTE le bundle dans le HTML → un seul fichier
         autonome (préserve l'export « viewer standalone » qui lit l'outerHTML). */
      ...(isProd ? [new HtmlInlineScriptPlugin()] : []),
      /* PWA : flag d'activation (false en dev → pas de SW pendant le HMR) + émission des fichiers PWA.
         Le SW n'a de sens que servi par HTTP(S) (mode API/serveur) ; il est no-op en file:// (cf. Pwa.ts). */
      new webpack.DefinePlugin({ __PWA_ENABLED__: JSON.stringify(isProd) }),
      new EmitStaticAssetsPlugin([
        { from: "src/pwa/manifest.webmanifest", to: "manifest.webmanifest" },
        { from: "src/pwa/sw.js", to: "sw.js" },
        { from: "src/pwa/icon-192.png", to: "icons/icon-192.png" },
        { from: "src/pwa/icon-512.png", to: "icons/icon-512.png" },
        { from: "src/pwa/icon-maskable-512.png", to: "icons/icon-maskable-512.png" },
      ]),
    ],
    devServer: {
      static: { directory: path.resolve(__dirname, "dist") },
      hot: true,
      open: ["/dc-manager.html"],
    },
    devtool: isProd ? false : "source-map",
    // sortie mono-fichier (CSS + bundle inlinés) → le seuil de taille webpack
    // n'a pas de sens ici (pas de chargement réseau séparé).
    performance: { hints: false },
  };
};
