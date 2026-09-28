# x4-script-language-server

Language Server Protocol server for X4: Foundations scripts (AI scripts and Mission Director scripts), built on `x4-script-core`. The X4CodeSense VS Code extension bundles it; any other LSP client can start it with `node out/server.js --node-ipc` (or `--stdio`).

Settings are read from the `x4CodeSense` configuration section.

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
