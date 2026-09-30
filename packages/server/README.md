# x4-script-language-server

Language Server Protocol server for X4: Foundations scripts (AI scripts and Mission Director scripts), built on `x4-script-core`. The X4CodeSense VS Code extension bundles it; any other LSP client can start it with `npx x4-script-language-server --stdio`, or with `--node-ipc` when it forks the server as a Node.js process.

Settings are read from the `x4CodeSense` configuration section. Documents with the language id `lua` only get a hover between the parentheses of `ReadText(page, id)`, with the text it reads.

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
