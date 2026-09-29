# X4CodeSense

Language support for **X4: Foundations** scripts (AI scripts and Mission Director scripts), built as a Language Server Protocol server with a thin Visual Studio Code client and a command-line checker.

Status: preview, up to the first release, 0.1.0. The extension is not on the Visual Studio Marketplace yet. The Marketplace-facing description lives in [client/README.md](client/README.md).

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

Optional corpus check against the extracted vanilla game files, and a folder of extensions:

```powershell
$env:X4_EXTRACTED = 'C:\path\to\extracted\9.00'
$env:X4_MODS = 'C:\path\to\extensions'
npm test
```

The corpus check times the analysis of the largest game file against a ceiling of 200 ms, and of patch documents against twice that. On a slower or busy machine, `X4_FILE_CEILING_MS` sets a higher ceiling; with all corpus files running at once, each shares the machine with the others.

## Releases

`release-please` keeps one release pull request open on `main`: the next versions and the changelogs of the four packages, from the conventional commits since their last release. They share one pull request because they depend on each other at exact versions, and it updates `package-lock.json` with them. Merging it tags each package that changed (`x4-script-core@v0.1.0`, `x4codesense@v0.1.0`) and creates its GitHub release, which starts the _Build and Publish_ workflow:

- `x4codesense`: the `.vsix` is built, attached to the release and, with the `VT_API_KEY` secret, scanned by VirusTotal. It is not published to the Marketplace yet.
- `x4-script-core`, `x4-script-language-server`, `x4-script-check`: built, tested and sent to npm by trusted publishing. No npm token is kept in the repository: npm accepts the upload because the package is bound to this repository and its `build-and-publish.yml`, and adds a provenance statement. The version is staged, and goes live once a maintainer approves it with 2FA, on npmjs.com or with `npm stage approve`. With the repository variable `NPM_DIRECT_PUBLISH` set to `true`, and a binding that allows it, it is published directly.

npm binds a repository only to a package that exists, so the first version of a package is published by hand, from its release tag, and the binding added after it (npm 11.15 or later, 2FA on the account). The workflow skips a package that is not on npm yet, or whose version is there already.

```powershell
git fetch --tags
git switch --detach x4-script-core@v0.1.0
npm ci
npm run clean
npm run build
foreach ($p in 'core', 'server', 'cli') { npm publish -w packages/$p }
foreach ($n in 'x4-script-core', 'x4-script-language-server', 'x4-script-check') {
  npm trust github $n --repo chemodun/X4CodeSense --file build-and-publish.yml --allow-stage-publish
}
git switch main
```

Then, in the package's settings on npmjs.com, _Require two-factor authentication and disallow tokens_ leaves trusted publishing as the only way to publish from CI.

## Lineage and credits

X4CodeSense is the successor of [X4CodeComplete](https://github.com/archenovalis/X4CodeComplete) (MIT), started by Cgetty and continued by archenovalis. It is written anew around a language server, building on the ideas of X4CodeComplete and on the valuable experience gained during its development.

- [Egosoft](https://www.egosoft.com) for the game.
- Members of the [x4_modding Discord channel](https://discord.com/channels/337098290917146624/502057640877228042) for answers, support and ideas.

## License

Apache License 2.0, see [LICENSE](LICENSE).
