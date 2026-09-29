# X4CodeSense

Language support for **X4: Foundations** scripts in Visual Studio Code: AI scripts (`aiscripts/*.xml`) and Mission Director scripts (`md/*.xml`).

X4CodeSense is the successor of X4CodeComplete. It is rebuilt around a language server, so the same analysis also runs from the command line and in CI.

## Status

Preview. The current build:

- recognises script and patch documents and shows the script type and name in the status bar;
- reports XML well-formedness problems (unclosed tags, missing quotes, missing end tags) as you type;
- validates scripts against the game's XSD schemas: unknown elements and attributes, elements in the wrong place or missing, missing required attributes and invalid attribute values;
- parses every expression and reports syntax errors the way the game would reject them, plus `@` combined with `?`, text references that are not `{page, id}` literals, and `%d` in format strings;
- checks property chains against `scriptproperties.xml`: a property that does not exist on the type at hand (`player.ship.frobnicate`) and, in AI scripts, a chain head that is no keyword are reported as warnings;
- completes child elements allowed at the caret, attribute names, attribute values from the schema enumerations, and property chains in expressions from `scriptproperties.xml` (`player.ship.cargo.{$ware}.count`), with keywords and the values of lookups such as `class` or `ware`;
- shows hover documentation for elements, attributes, enumeration values, keywords and properties;
- goes to the definition of an element or attribute in the schema, of a keyword or property in `scriptproperties.xml`, and of a lookup value in the game file it comes from;
- knows the variables of a script and where they live, following the cue namespace rules of the Mission Director guide: completes `$` with the variables visible at the caret (also after `this.`, `parent.` or a cue name), shows on hover where a variable is set, its type when it can be told and how often it is read, goes to its definitions, finds all references and renames it;
- knows the labels of AI scripts per attention block, the interrupt library actions, handlers and conditions, and the cues and libraries of Mission Director scripts: completes them where a reference is written, shows them on hover, goes to their definition, finds all references and renames them within the script. A label that no reachable attention block defines, a name defined twice, and a bare name in a Mission Director expression that is no keyword and no cue of the script are reported as warnings;
- reads the game's texts and those of your extensions (`t/0001-l044.xml` and the other languages): hover over `{page, id}` or `page="…" line="…"` in any XML file shows the text as the game shows it, go to definition opens it in the text file, completion offers pages after `{` and text ids after `{page,` in scripts, and a reference to a text that no file defines is reported as a warning. Text files open in the editor count with their unsaved changes;
- indexes the scripts of the game, its DLCs and your extensions: `md.Script.Cue` shows the script and cue on hover, goes to them, and completes script names after `md.` and cue names after `md.Script.`, also cues that an extension's patch adds; interrupt library actions, handlers and conditions of other scripts are shown, completed and opened, and a reference to one that no script defines is reported as a warning, as is `md.Script.Cue` naming a script or cue that no script defines. Scripts open in the editor count with their unsaved changes, and files changed on disk in the workspace are read again;
- knows variables that other scripts set: in AI scripts those that the interrupt library items a script uses set in their own files, and for `md.Script.Cue.$x` those the cue sets in its script. Hover names where they are set, go to definition opens it, and completion offers them.

Being ported and rebuilt next, in this order:

- Find all references and rename across scripts
- Patch documents (`<diff>`) checked in the context of the file they patch

## Requirements

- The extracted vanilla game files (`aiscripts`, `md`, `libraries`, `t`), set in `x4CodeSense.unpackedFileLocation`. The schemas `md.xsd`, `aiscripts.xsd` and `common.xsd` and `scriptproperties.xml` with the files it imports are read from its `libraries` folder; without it scripts are only checked for well-formedness.
- Your extensions in the workspace: a workspace may be one mod, or a folder of several mods. Other extensions yours depend on are found through `x4CodeSense.extensionsFolder`.

## Settings

- `x4CodeSense.unpackedFileLocation` - path to the extracted vanilla game files.
- `x4CodeSense.extensionsFolder` - where the other extensions are, usually set per workspace. Relative to the workspace folder: empty or `.` is the workspace itself (a workspace of several mods), `..` the folder above it (one workspace per mod, the mods side by side); an absolute path is taken as is. Extensions are read in the order their `content.xml` dependencies give, so a dependency's texts and patches come before yours.
- `x4CodeSense.languageNumber` - preferred language number for text lookups, `44` by default; the game's `libraries/languages.xml` lists the numbers.
- `x4CodeSense.limitLanguageOutput` - show only the preferred language in hovers, and read only the text files of that language and English.
- `x4CodeSense.validateXmlStructure` - check the order and completeness of child elements against the schemas, on by default. Unknown elements and attributes and invalid values are always reported.
- `x4CodeSense.debug` - verbose server logging in the X4CodeSense output channel.
- `x4CodeSense.trace.server` - LSP message tracing.

## Commands

- `X4CodeSense: Restart Language Server`

## Credits

- [Egosoft](https://www.egosoft.com) for the game.
- Cgetty and archenovalis for X4CodeComplete, the starting point of this extension.
- Members of the [x4_modding Discord channel](https://discord.com/channels/337098290917146624/502057640877228042) for answers, support and ideas.

## Changelog

### Unreleased

- Variables across scripts: an interrupt library item runs in the AI script that uses it, so what it sets counts as set there, and what it reads is left to the scripts that use it. `md.Script.Cue.$x` knows the variables the cue sets in its own script. Hover, go to definition and completion show variables set in other files. The check for variables that are read but never set stays off: with the script index, AI scripts still have 31 such reads in the game and 28 in the mods (typos, attributes that store a result without the schema saying so, parameters passed without a declaration), and in Mission Director scripts other scripts explain none of them.
- Script index: the scripts of the game, its DLCs and the extensions are indexed after the server starts (about a second for the game with 65 extensions), without holding up requests. `md.Script.Cue` gets hover, go to definition and completion of script and cue names, counting cues that extension patches add to a script; interrupt library items of other scripts get hover, go to definition and completion, and a reference to one that no script defines is reported (none in vanilla or in the scripts of 52 extensions). `md.Script.Cue` naming a script or cue that no indexed script defines is reported too: the game and its DLCs have 3 such mistakes, the extensions none; a mod that refers to another mod needs that mod in `x4CodeSense.extensionsFolder`. Open scripts count with their unsaved changes; scripts and text files changed on disk in the workspace are read again. The command-line checker takes `--extensions <folder>` for extensions to read but not check. Code in hovers keeps names as they are (`run_actions` was shown with a backslash).
- Extensions are read in the order the game loads them: after the extensions their `content.xml` names as dependencies. Extension text files that patch the game's texts are applied: pages and texts added (also before or after another), replaced (also just their `text()`) or removed, addressed by `@id`; a patch that cannot be applied is listed in the output log. `x4CodeSense.extensionsFolder` may be relative to the workspace (`.` for the workspace itself, `..` for the folder above it), and each folder may be one extension or hold several, also a level or two deeper as in a repository.
- Texts: the text files of the game, of the extensions folder and of the workspace are read, in every language or only the preferred one and English; extension text files that add pages with a `<diff>` count too. Hover over a text reference in any XML file shows the text as the game shows it, with references inside it resolved and `(comments)` hidden, and how it is written when that differs. Go to definition opens the text in the preferred language, completion offers pages and text ids, and references to texts that no file defines are reported as warnings in scripts (not in comments). The command-line checker reads the texts of the checked folders. The vanilla texts load in about 0.3 s; all 4,855 text references of the vanilla scripts and all references of 52 published extensions resolve.
- Labels, cues and interrupt library items: labels belong to their attention block (a `resume` jumps within it, a handler's `abort_called_scripts` may name a label of any block), interrupt library `actions`, `handler` and `conditions` are found by their reference attributes, and cue and library names are found wherever an expression names them, also as `md.Script.Cue` for the script itself. Completion, hover, go to definition, find all references and rename work on all of them within the script. Undefined labels and names defined twice are reported as warnings; neither occurs in vanilla or in the scripts of 52 published extensions. A bare name that is no keyword and no cue of the script is reported as well, except inside libraries, whose names resolve in the including script; vanilla has 20 of them, all vanilla mistakes such as typos of keywords and cues that no script defines, and the extensions have none. Each expression is now parsed once per analysis and shared by all checks.
- Variables: a script's variables are collected into tables following the cue namespace rules of the Mission Director guide (root cues, libraries and cues with `namespace="this"` or `"static"` own a table, other cues share their parent's; `this`, `static`, `parent`, `namespace`, a cue name, `global` and `md.Script.Cue` address the right one; `<param>` declarations, `include_actions` and `<cue ref>` are understood). Completion of `$` offers the variables visible at the caret, hover shows the type, the definitions and the number of reads, go to definition, find all references and rename work on variables, also while the XML around them is half typed. A check for variables that are read but never set exists but stays off until scripts are indexed across files. Property checks are indexed now: the largest vanilla scripts (over 1 MB) are fully analysed in about 130 ms instead of up to a second.
- Property chains are checked against `scriptproperties.xml`: unknown properties on a known type and, in AI scripts, unknown chain heads are reported as warnings. Lookup values (`class`, `faction`, `ware`, ...) are not checked because their lists lag behind the game and its DLCs. All placeholder forms of the game data are understood now: `<cuename>`, `<tagname>`, `$<variable>`, `[$x, $y, $z]`, bare values and list literals for `{$type}`, and a chain that stops inside a pattern. Keywords the game has but the file lacks (`component`, `chairtype`, `datatype.macroslot`) are added.
- Expression diagnostics: every attribute that takes an expression is parsed with the game's operator precedence; syntax errors, `@` combined with `?`, text references without numeric literals and `%d` in a format string are reported at their position. All 247,000 expressions of the vanilla scripts parse cleanly in about a second.
- Completion, hover and go to definition from the schemas and `scriptproperties.xml`: child elements allowed at the caret, attribute names, enumeration values, keywords, property chains with placeholders and lookup values. Lookups the game evaluates but `scriptproperties.xml` does not list (relation ranges, licence types, component states, input functions and more) come from the game's own data files. Everything keeps working while a tag, an attribute or a quote is still being typed.
- Schema validation of scripts against the game's XSD files, on by default: unknown elements and attributes, misplaced and missing child elements, missing required attributes, invalid attribute values with the expected values in the message. The schemas load in well under a second and the largest vanilla script validates in tens of milliseconds.
- XML well-formedness diagnostics for scripts and patches: unclosed start and end tags, missing or unquoted attribute values, missing closing quotes, duplicate attributes, missing end tags, unclosed comments.
- Initial scaffold: language server, client and command-line checker with script detection.
