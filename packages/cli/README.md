# x4-script-check

Command line checker for X4: Foundations scripts (AI scripts and Mission Director scripts), built on `x4-script-core`. Meant for CI and for tools that want the same diagnostics the X4CodeSense VS Code extension shows.

```powershell
npx x4-script-check path/to/extension
npx x4-script-check path/to/folder/with/many/extensions
```

It looks for `md` and `aiscripts` folders directly under each given path and one level deeper, checks every `*.xml` file in them, prints one line per finding and exits with 1 when there are findings.

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
