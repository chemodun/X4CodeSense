# x4-script-mcp

MCP server for X4: Foundations scripts (AI scripts and Mission Director scripts), built on `x4-script-core`. It gives AI agents that write scripts what the X4CodeSense VS Code extension knows from the game's own files: the checks with their quick fixes, the elements and attributes of the schemas, the types and properties of expressions, the scripts, cues and texts of the game, its DLCs and the extensions. Its tools only read; the agent writes the files.

The X4CodeSense extension brings it along and offers it to VS Code's agents (Copilot's agent mode) on the game files and extensions set in its settings, with nothing to set up. Other agents start it from npm:

```powershell
# Claude Code
claude mcp add x4 -- npx -y x4-script-mcp --game "C:\Games\X4 Foundations" --extensions C:\mods
```

```json
{
  "mcpServers": {
    "x4": {
      "command": "npx",
      "args": ["-y", "x4-script-mcp", "--unpacked", "C:\\X4\\extracted", "--extensions", "C:\\mods"]
    }
  }
}
```

The second is the configuration of Claude Desktop, Cursor and others that take one in that form. It needs Node.js 22 or later.

Options:

- `--game <folder>` - the installed game, the folder of `X4.exe`. Its files and those of its DLCs are read from their catalogs where they lie: nothing is extracted. Used when `--unpacked` is not given.
- `--unpacked <folder>` - the extracted vanilla game files, the folder holding `libraries`, `md`, `aiscripts` and `t`.
- Without `--game` and `--unpacked`, the `X4_UNPACKED` environment variable gives the extracted files, else `X4_GAME` the installed game; either option given wins over both variables.
- `--extensions <folder>` - an extension, or a folder of extensions: those the agent writes and those they refer to. Their scripts and texts are read besides the game's. May be given several times; without it, the current folder.
- `--language <number>` - the language texts are shown in, `44` (English) by default; the game's `libraries/languages.xml` lists the numbers.
- `--no-structure` - report unknown elements, attributes and values, missing required attributes and text inside elements only, not the order and completeness of child elements.
- `--no-type-guesses` - type variables only by what the scripts and the schemas state, not by guesses from the names and documentation of actions (`create_ship` a ship).
- `-h`, `--help` - usage.

The game files are read on the first call, a few seconds. The extensions' files are watched: a script or text file the agent writes, changes or deletes is read again before the next call, and a file a call names is always taken as it is on disk. An extension added, or a `content.xml` changed, reads them all again.

## Tools

Lines and columns count from 1, columns in UTF-16 code units, as editors count them. A place is given as `file`, `line`, `column`, `endLine`, `endColumn`, with `text`, the line it is on, and `game: true` for a file of the game or a DLC, which may lie in the catalogs only. Answers are JSON; a tool that cannot answer says why, as an error.

- `check` - `paths`: files and folders; `text`: what to check instead of the one file in `paths` as it is on disk; `severity`: the least severe finding to report. A folder is checked as [x4-script-check](https://www.npmjs.com/package/x4-script-check) checks it: the `md`, `aiscripts` and `libraries` folders in it and one level deeper. The findings with their quick fixes (edits that do not overlap, `preferred` for the one an editor applies on its own), in the shape of the checker's JSON, and their counts.
- `describe_element` - `name`, `script` (`md` or `aiscripts`), `parent` for an element declared differently in different places (`param`, `actions`), `attribute` for one attribute in full. The element's documentation, its attributes with their types, whether they are required, their defaults, whether the value is an expression, and the first of their allowed values (all, with their documentation, for one attribute in full); the child elements it allows. For a name the schema does not know, similar ones.
- `expression_type` - `expression`, a keyword and its properties such as `player.ship.sector`, or `datatype`, such as `ship`; `script`; `filter`. Each step with what it resolved to, its type and description; the datatype of the result with its supertypes, and its properties as `name → type`, with how many those of the types derived from it add. With `filter`, the properties whose names contain it, those of the derived types too, with their descriptions. A variable has no type here: the step after it is matched against every datatype's properties.
- `find` - `query`, `limit`. Mission Director scripts, AI scripts, cues, libraries and interrupt library items by name: whole names first, then those that start with the query, then those that contain it; a query with a dot matches qualified names, `md.Setup.Start`.
- `definition`, `references` - `file`, `line`, `column`. Where what is named there is defined, or every place that names it, in the game, its DLCs and the extensions: cues, scripts, libraries, labels, variables, orders, texts; a definition also in the schemas and `scriptproperties.xml`.
- `text` - `page` and `id`, or `page` alone for its texts, or `search` for the texts that hold all its words; `language`, `limit`. The text as the game shows it, references resolved, and as it is written when that differs, with the file it comes from and the languages it exists in.
- `status` - the game folder, the extension folders, how many scripts and texts were read, and the problems met reading them.

Part of [X4CodeSense](https://github.com/chemodun/X4CodeSense). Apache License 2.0.
