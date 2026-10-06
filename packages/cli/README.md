# x4-script-check

Command line checker for X4: Foundations scripts (AI scripts and Mission Director scripts), built on `x4-script-core`. Meant for CI and for tools that want the same diagnostics the X4CodeSense VS Code extension shows.

```powershell
npx x4-script-check --game "C:\Games\X4 Foundations" path\to\extension
npx x4-script-check --unpacked C:\X4\extracted path\to\extension
npx x4-script-check --unpacked C:\X4\extracted path\to\folder\with\many\extensions
npx x4-script-check path\to\extension        # well-formedness only, no schemas
npx x4-script-check --format json --unpacked C:\X4\extracted path\to\extension
npx x4-script-check --fix --unpacked C:\X4\extracted path\to\extension
npx x4-script-check --game "C:\Games\X4 Foundations" "C:\Games\X4 Foundations"   # the game and its DLCs
```

It looks for `md` and `aiscripts` folders directly under each given path and one level deeper, and for the patches of other extensions in `extensions/<folder>/md` and `.../aiscripts`. It checks every `*.xml` file in them, in the order of their names, once, also when a path is given twice or inside another given path, and exits with 1 when there are findings (2 on a usage error). The game folder itself, given as a path to check, stands for the game and its DLCs.

It checks each extension's `libraries` folder as well: a patch there (`<diff>`) is applied to the game's library file of the same name, after the patches and merge files of the extensions loaded before it, and counts as a patch. A merge file, whose root is the game file's (`<wares>` in `libraries/wares.xml`), is merged as the game merges it; one whose root is neither is reported, since the game skips it. Other files there are not reported as no scripts.

The checks are those the X4CodeSense extension runs as you type, listed with their known limitations in [its README](https://github.com/chemodun/X4CodeSense/blob/main/client/README.md).

Options:

- `--game <folder>` - the installed game, the folder of `X4.exe`. Its files and those of its DLCs (the folders of its `extensions` whose names start with `ego_dlc_`) are read from their catalogs (`01.cat`, …, a DLC's `ext_01.cat`, …) where they lie: nothing is extracted, and the X Catalog Tool is not needed. The other folders in its `extensions`, the player's mods, are not part of the game: give them as paths to check or with `--extensions`. Used when `--unpacked` is not given.
  - The mods installed there that the checked extensions depend on, and those whose files their patches change, are read from it, also beside `--unpacked`: packed ones from their catalogs (`ext_01.cat`, and `ext_01_diff_vNNN.cat` and `ext_vNNN.cat` for the game's version), an extension of the same id among those given replacing the installed one. They count for the patches: a patch of an installed mod's script is checked against it, and their patches of a library file apply before the checked one's. Beside `--unpacked`, a folder that is no installed game is reported and gives no mods.
- `--installed-dependencies` - with `--game`, the installed mods the checked extensions depend on count as a whole: their cues, scripts and texts resolve in the checked scripts.
- `--unpacked <folder>` - the extracted vanilla game files; their `libraries` folder provides `md.xsd`, `aiscripts.xsd`, `common.xsd` and `diff.xsd`, and scripts and patches are validated against them.
- Without `--game` and `--unpacked`, the `X4_UNPACKED` environment variable gives the extracted files, else `X4_GAME` the installed game; either option given wins over both variables.
- `--extensions <folder>` - other extensions the checked ones refer to: their texts and scripts are read, they are not checked. May be given several times.
- `--no-structure` - report unknown elements, attributes and values, missing required attributes and text inside elements only, not the order and completeness of child elements.
- `--no-type-guesses` - type variables only by what the scripts and the schemas state (`<param type>`, the value `set_value` sets, groups), not by guesses from the names and documentation of actions (`create_ship` a ship).
- `--fix` - apply the preferred quick fixes to the files first, then report what is left, see below.
- `--format <format>` - `text` (default), `json`, `github` or `sarif`, see below.
- `--fail-on <severity>` - the least severe finding that fails the check: `error`, `warning`, `info` or `hint`. The default, `warning`, fails on errors and warnings: information (a property a guessed type lacks, arguments a format does not show) and hints are reported and pass. With `--fail-on info` or `hint` they fail too; with `--fail-on error`, warnings are reported and the exit code is 0.
- `-h`, `--help` - usage.

## Text

One line per finding: the file, for a place in it the 1-based line and column, the severity, the message and its code. A finding with a quick fix, the fix the editor offers, has a line per fix below it. The last line counts what was checked and found.

```text
C:\mods\my_extension\aiscripts\Misplaced.xml: error: is a md script but lies in the aiscripts folder [script-in-wrong-folder]
C:\mods\my_extension\md\Broken.xml:3:15: error: Value of attribute 'name' is not closed [unclosed-attribute]
C:\mods\my_extension\md\Invalid.xml:4:17: error: Missing required attribute 'name' in 'set_value' [missing-required-attribute]
  fix: Add the required attribute 'name'
C:\mods\my_extension\md\Texts.xml:5:50: warning: Text 2 does not exist on page 90001 [text-undefined]
6 file(s) in 2 folder(s): 5 script(s), 1 patch(es), 4 finding(s) (3 error(s), 1 warning(s))
```

## JSON

`--format json` prints one JSON object: the findings, the counts, and the problems met while reading the game files or fixing (they also go to standard error, as in the other formats).

```json
{
  "findings": [
    {
      "file": "C:\\mods\\my_extension\\md\\Invalid.xml",
      "line": 4,
      "column": 17,
      "range": { "start": { "line": 3, "character": 16 }, "end": { "line": 3, "character": 25 } },
      "severity": "error",
      "code": "missing-required-attribute",
      "message": "Missing required attribute 'name' in 'set_value'",
      "fixes": [
        {
          "title": "Add the required attribute 'name'",
          "preferred": true,
          "edits": [{ "range": { "start": { "line": 3, "character": 35 }, "end": { "line": 3, "character": 35 } }, "newText": " name=\"\"" }]
        }
      ]
    }
  ],
  "summary": {
    "files": 6,
    "folders": 2,
    "scripts": 5,
    "patches": 1,
    "findings": 1,
    "errors": 1,
    "warnings": 0,
    "info": 0,
    "hints": 0,
    "schemaValidation": true
  },
  "problems": []
}
```

- `line` and `column` count from 1, as in the text; they and `range` are absent for a finding about the whole file.
- `range` and the ranges of the edits are LSP ranges: lines and characters count from 0, characters in UTF-16 code units, and the end is not included.
- A fix is a list of edits to its file that do not overlap. `preferred` marks the fix an editor applies on its own: the only one, or clearly the closest name.

## GitHub Actions

`--format github` prints each finding as a workflow command, so GitHub shows it on the line of the file, in the run and in the pull request. Errors are errors, warnings warnings, and information notices; the quick fixes follow the message. Files are named relative to the current folder, which is the checked-out repository in a workflow.

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npx x4-script-check --format github .
```

```text
::error file=md/Invalid.xml,line=4,endLine=4,col=17,endColumn=26,title=missing-required-attribute::Missing required attribute 'name' in 'set_value'%0AFix: Add the required attribute 'name'
```

Without the game files on the runner, only well-formedness is checked.

The text, JSON and GitHub formats name the files of an installed game by the paths they would have if extracted, such as `C:\Games\X4 Foundations\md\setup.xml`.

## SARIF

`--format sarif` prints a [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) log, which GitHub code scanning and other tools read. Each code found is a rule with a description of what it reports; files are named relative to the current folder, as for `github`; the quick fixes are SARIF fixes. A finding about a whole file is placed on its first line, since code scanning shows results at lines. Code scanning has to be available for the repository (it is for public ones).

```yaml
permissions:
  security-events: write
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - run: npx x4-script-check --format sarif . > x4-script-check.sarif
  - uses: github/codeql-action/upload-sarif@v4
    if: always()
    with:
      sarif_file: x4-script-check.sarif
```

## Fixing

`--fix` applies the preferred quick fixes to the files before checking them, as **Fix All** in the editor does: a name misspelt is changed to the known name closest to it (an element's end tag with it), a value without quotes is put in quotes. Fixes that would only insert an empty value, such as a missing required attribute, are left out: the problem would move, not go away. Every file is fixed before any is checked, so a definition fixed in one file counts in the others. The report shows what is left, after a line per fix applied:

```text
C:\mods\my_extension\aiscripts\order.mine.xml:5:45: fixed: Change to 'Attack' [order-undefined]
C:\mods\my_extension\aiscripts\order.mine.xml:7:8: fixed: Change to 'set_value' [unknown-element]
3 file(s) in 1 folder(s): 3 script(s), 0 patch(es), 0 finding(s); 2 fix(es) applied to 1 file(s)
```

With `--format json` the fixes are listed under `fixed` (file, place, code, message and the fix's title) and counted as `fixes` and `fixedFiles` in the summary; with `--format github` each is a notice. Most fixes need the game files: without `--unpacked` or `--game`, only those of well-formedness are applied, such as quotes put in and values closed. The files of an installed game, read from its catalogs, are never written; nor is a file that is not UTF-8, whose other characters would be lost: it is listed among the problems, on standard error, in `problems` of the JSON and as a notification in SARIF.

## Stability

From 1.0.0 the options, the exit codes, the output formats and the diagnostic codes change only with a new major version. New options, codes and fields may come in any version: a tool reading the JSON should ignore fields it does not know.

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
