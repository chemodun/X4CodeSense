# x4-script-core

Editor-independent analysis of X4: Foundations scripts (AI scripts and Mission Director scripts): script detection, XML structure, expression language, types, scopes, symbols and diagnostics, and the `ReadText` calls of Lua files. Used by the X4CodeSense language server, the X4CodeSense VS Code extension, the `x4-script-check` command line tool and the `x4-script-mcp` MCP server.

The game data comes from the extracted game files, or straight from an installed game: `openInstalledGame` reads its files and its DLCs' from their catalogs with `x4-catalog`, without extracting them. `gameFileUri` and `gameFileOf` turn such a file into the read-only document a language server gives its clients, and back.

This package has no dependency on VS Code. Positions and ranges use the LSP types.

Its API is made for the X4CodeSense language server, the VS Code extension, `x4-script-check` and `x4-script-mcp`, and changes with them: every module is exported, and any export may change in a minor version, also after 1.0. What X4CodeSense keeps stable from 1.0 on is what its users meet: the extension's settings and commands, the checker's options and output formats, the MCP server's options and tools, and the diagnostic codes.

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
