/* eslint-disable */
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const HtmlInlineScriptPlugin = require("html-inline-script-webpack-plugin");

module.exports = (env, argv) => {
  const isProd = argv.mode === "production";
  return {
    entry: "./src/app/main.ts",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "netmap.[contenthash].js",
      clean: true,
    },
    resolve: { extensions: [".ts", ".js"] },
    module: {
      rules: [
        { test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./src/index.html",
        filename: "netmap.html",
        inject: "body",
      }),
      /* En production : on RÉINJECTE le bundle dans le HTML → un seul fichier
         autonome (préserve l'export « viewer standalone » qui lit l'outerHTML). */
      ...(isProd ? [new HtmlInlineScriptPlugin()] : []),
    ],
    devServer: {
      static: { directory: path.resolve(__dirname, "dist") },
      hot: true,
      open: ["/netmap.html"],
    },
    devtool: isProd ? false : "source-map",
  };
};
