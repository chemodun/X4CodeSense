# X4CodeSense

Language support for **X4: Foundations** scripts (AI scripts and Mission Director scripts), built as a Language Server Protocol server with a thin Visual Studio Code client and a command-line checker.

Status: 0.x. The npm packages are on npm; the extension is on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=X4DevTools.x4codesense), and its `.vsix` is also attached to the GitHub releases. The Marketplace-facing description lives in [client/README.md](client/README.md).

## Layout

- `packages/catalog` - `x4-catalog`, reads the game's catalogs (`.cat`/`.dat`) in place, without extracting them, and writes new ones. No dependencies.
- `packages/core` - `x4-script-core`, the editor-independent analysis library: script detection, XML structure, expression language, types, scopes, symbols, diagnostics, and the `ReadText` calls of Lua files. No `vscode` imports.
- `packages/server` - `x4-script-language-server`, the LSP server on top of the core.
- `packages/cli` - `x4-script-check`, a command-line checker for CI and tools, on top of the core.
- `client` - the `X4CodeSense` VS Code extension (publisher `X4DevTools`). It bundles the server and the core into `client/dist`.

## Development

Requires Node.js 22.

```powershell
npm install
npm run build        # tsc -b for all packages, then esbuild bundle of the client
npm test             # vitest across the packages and the client
npm run lint
npm run package -w client   # produces client/x4codesense-<version>.vsix
```

Press F5 in VS Code (configuration `Launch Client`, or `Client + Server` to attach to the server as well).

Optional corpus check against the extracted vanilla game files, an installed game read from its catalogs, and a folder of extensions:

```powershell
$env:X4_EXTRACTED = 'C:\path\to\extracted\9.00'
$env:X4_GAME = 'C:\path\to\X4 Foundations'
$env:X4_MODS = 'C:\path\to\extensions'
npm test
```

With both `X4_EXTRACTED` and `X4_GAME`, the files read from the catalogs are compared with the extracted ones of the same build.

The corpus check times the analysis of the largest game file against a ceiling of 200 ms, and of patch documents against twice that. On a slower or busy machine, `X4_FILE_CEILING_MS` sets a higher ceiling; with all corpus files running at once, each shares the machine with the others.

## Releases

`release-please` keeps one release pull request open on `main`: the next versions and the changelogs of the five packages, from the conventional commits since their last release. They share one pull request because they depend on each other at exact versions, and it updates `package-lock.json` with them. Merging it tags each package that changed (`x4-script-core@v0.1.0`, `x4codesense@v0.1.0`) and creates its GitHub release, which starts the _Build and Publish_ workflow:

- `x4codesense`: the `.vsix` is built, attached to the release and, with the `VT_API_KEY` secret, scanned by VirusTotal. With the repository variable `PUBLISH_TO_MARKETPLACE` set to `true`, the same `.vsix` is then published to the Visual Studio Marketplace as `X4DevTools`. That job runs in the `marketplace` environment and signs in to Microsoft Entra ID, whose app registration trusts that environment, so no Marketplace token is kept either.
- `x4-catalog`, `x4-script-core`, `x4-script-language-server`, `x4-script-check`: built, tested and sent to npm by trusted publishing. No npm token is kept in the repository: npm accepts the upload because the package is bound to this repository and its `build-and-publish.yml`, and adds a provenance statement. The version is published directly. A package that is not on npm yet is skipped with a warning: its first version is published by hand, which creates the package the binding is set on.

## Lineage and credits

X4CodeSense is the successor of [X4CodeComplete](https://github.com/archenovalis/X4CodeComplete) (MIT), started by Cgetty and continued by archenovalis. It is written anew around a language server, building on the ideas of X4CodeComplete and on the valuable experience gained during its development.

- [Egosoft](https://www.egosoft.com) for the game.
- Members of the [x4_modding Discord channel](https://discord.com/channels/337098290917146624/502057640877228042) for answers, support and ideas.

## License

Apache License 2.0, see [LICENSE](LICENSE).
