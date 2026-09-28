# x4-script-check

Command line checker for X4: Foundations scripts (AI scripts and Mission Director scripts), built on `x4-script-core`. Meant for CI and for tools that want the same diagnostics the X4CodeSense VS Code extension shows.

```powershell
npx x4-script-check --unpacked C:\X4\extracted path\to\extension
npx x4-script-check --unpacked C:\X4\extracted path\to\folder\with\many\extensions
npx x4-script-check path\to\extension        # well-formedness only, no schemas
```

It looks for `md` and `aiscripts` folders directly under each given path and one level deeper, checks every `*.xml` file in them, prints one line per finding and exits with 1 when there are findings (2 on a usage error).

Options:

- `--unpacked <folder>` - the extracted vanilla game files; their `libraries` folder provides `md.xsd`, `aiscripts.xsd` and `common.xsd`, and scripts are validated against them. Also read from the `X4_UNPACKED` environment variable.
- `--no-structure` - report unknown elements, attributes and values only, not the order and completeness of child elements.
- `-h`, `--help` - usage.

Findings about a place in a file carry a 1-based line and column:

```text
C:\mods\my_extension\md\Broken.xml:3:15: Value of attribute 'name' is not closed [unclosed-attribute]
C:\mods\my_extension\md\Invalid.xml:5:8: Element 'conditions' is not allowed after 'actions' in 'cue'. Expected 'cues' [invalid-child-element]
C:\mods\my_extension\aiscripts\Misplaced.xml: is a md script but lies in the aiscripts folder
4 file(s) in 2 folder(s): 3 script(s), 1 patch(es), 3 finding(s)
```

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
