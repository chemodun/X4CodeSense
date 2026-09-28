# X4CodeSense

Language support for **X4: Foundations** scripts (AI scripts and Mission Director scripts), built as a Language Server Protocol server with a thin Visual Studio Code client and a command-line checker.

Status: early scaffold. The extension is not published yet. The Marketplace-facing description lives in [client/README.md](client/README.md).

## Layout

- `packages/core` - `x4-script-core`, the editor-independent analysis library: script detection, XML structure, expression language, types, scopes, symbols, diagnostics. No `vscode` imports.
- `packages/server` - `x4-script-language-server`, the LSP server on top of the core.
- `packages/cli` - `x4-script-check`, a command-line checker for CI and tools, on top of the core.
- `client` - the `X4CodeSense` VS Code extension (publisher `X4DevTools`). It bundles the server and the core into `client/dist`.

## Development

Requires Node.js 22.

```powershell
npm install
npm run build        # tsc -b for all packages, then esbuild bundle of the client
npm test             # vitest across packages
npm run lint
npm run package -w client   # produces client/x4codesense-<version>.vsix
```

Press F5 in VS Code (configuration `Launch Client`, or `Client + Server` to attach to the server as well).

Optional corpus check against the extracted vanilla game files:

```powershell
$env:X4_EXTRACTED = 'C:\path\to\extracted\9.00'
npm test
```

## Releases

`release-please` manages versions and changelogs per package. Tags look like `x4codesense@v1.2.3` (extension) or `x4-script-core@v1.2.3` (npm package). Publishing the extension needs the `VSCE_PAT` secret, publishing npm packages needs `NPM_TOKEN`, both optional for a dry run.

## Lineage and credits

X4CodeSense is the successor of [X4CodeComplete](https://github.com/archenovalis/X4CodeComplete) (MIT), started by Cgetty and continued by archenovalis and Chem O'Dun. Proven parts of that code base are ported here module by module while the whole is restructured around a language server.

- [Egosoft](https://www.egosoft.com) for the game.
- Members of the [x4_modding Discord channel](https://discord.com/channels/337098290917146624/502057640877228042) for answers, support and ideas.

## License

Apache License 2.0, see [LICENSE](LICENSE).
