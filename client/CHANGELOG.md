# Changelog

## [0.12.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.11.0...x4codesense@v0.12.0) (2026-10-04)


### Features

* X4CodeSense: Start MCP Server serves the tools over HTTP for agents outside VS Code's agent mode ([8960fb2](https://github.com/chemodun/X4CodeSense/commit/8960fb24647184ac533b2fe00abfc3d33270d6d3))
* X4CodeSense: Start MCP Server serves the tools over HTTP for agents outside VS Code's agent mode ([56ce339](https://github.com/chemodun/X4CodeSense/commit/56ce339009cd06de55a76794e332df7fa243fdb3))

## [0.11.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.10.1...x4codesense@v0.11.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* x4-script-check exits with 0 when the only findings are information or hints; pass --fail-on hint for the old behaviour. The command id x4CodeSense.selectGameFolder is now x4CodeSense.selectExtractedFiles; keybindings made for the old id have to be made again.

### Features

* the MCP server's tool hover tells what a place of a script is, as the editor's hover does ([ef599f2](https://github.com/chemodun/X4CodeSense/commit/ef599f22c7fc6940be41aa7696ed185025a7377e))


### Bug Fixes

* x4-script-check fails on warnings by default; the command to select the extracted files has an id after its title ([056a9a4](https://github.com/chemodun/X4CodeSense/commit/056a9a4e6b6154ca8eee8ebccecc38abedc802a5))


### Documentation

* the changelog of 0.11.0 dated for its release ([dd7be16](https://github.com/chemodun/X4CodeSense/commit/dd7be169aadb6544ba7855624baca498b463adf8))

## [0.10.1](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.10.0...x4codesense@v0.10.1) (2026-10-03)


### Bug Fixes

* a bare name after a table, a chain that stops inside a property name, and properties read under @ or ? are reported ([d71e25c](https://github.com/chemodun/X4CodeSense/commit/d71e25c347d1d850e480986c4d5d3ccc7a621824))
* agents told when to use the MCP tools, each call logged, the server in the MCP Registry; the tests type-checked ([0476e6d](https://github.com/chemodun/X4CodeSense/commit/0476e6d625265b000644070a471b3ad732f6dbe6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.10.0 to 0.10.1

## [0.10.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.9.0...x4codesense@v0.10.0) (2026-10-03)


### Features

* x4-script-mcp, an MCP server for AI agents that write scripts, offered by the extension to VS Code's agents ([e7ede0e](https://github.com/chemodun/X4CodeSense/commit/e7ede0e070167ee1d79459f8b1146173bb3f2e42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.9.0 to 0.10.0

## [0.9.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.8.0...x4codesense@v0.9.0) (2026-10-02)


### Features

* patches and merge files of the game's library files ([628a5b6](https://github.com/chemodun/X4CodeSense/commit/628a5b631284c12340f5aca8ca75d6bbcd86a861))
* rename and references through the literals of patches' paths ([03e32ae](https://github.com/chemodun/X4CodeSense/commit/03e32ae85c2f11951af75f00327fd15eeadb7123))
* report text inside elements, and refuse it in the side of a patch ([97d0f22](https://github.com/chemodun/X4CodeSense/commit/97d0f227d088e533b4a99407dc9d80cd20b5871f))
* the extension brings the checker along, settings of another type and deleted folders no longer stop or fool the server ([de1f609](https://github.com/chemodun/X4CodeSense/commit/de1f609b592d9dfe91e37c5d3500e8f08d8d772e))
* variable types from what sets them, guessed for actions from the schema's words ([fabb120](https://github.com/chemodun/X4CodeSense/commit/fabb120462e7c7d10f2b1197c45a766375611f2b))
* well-formedness the game's parser checks, a script whose root lost its &gt; stays checked ([ddccfb4](https://github.com/chemodun/X4CodeSense/commit/ddccfb4e759a3aa5c38be77191e0630e01fd9ece))


### Bug Fixes

* bare names after a value are checked, units have types, cleaner messages while typing ([d9b3a44](https://github.com/chemodun/X4CodeSense/commit/d9b3a44d4b5ececa908c31e48481721074b05fb6))
* no unset-variable finding after the include of a library chosen at run time ([89604ab](https://github.com/chemodun/X4CodeSense/commit/89604ab7d5ee7a2d642868a4ea7434f77ce63b3e))
* rename follows a cue's bare names into other scripts' libraries, no child offered where none fits ([98b9c82](https://github.com/chemodun/X4CodeSense/commit/98b9c825390faf9a6f76c42328d4b55ec7c06a64))
* valid XPath in patches is not reported as wrong, silent="1", text and comments in operations ([2b29d4b](https://github.com/chemodun/X4CodeSense/commit/2b29d4bc7636d75f620ff630f42503c135ec0ea7))
* what libraries set is followed across scripts, other documents wait for a pause ([85293fa](https://github.com/chemodun/X4CodeSense/commit/85293fa7145aa67a96fb8bd1d5210979b732cf9d))


### Performance Improvements

* **core:** an index of a patch tree's children by attribute value ([8dfaa3e](https://github.com/chemodun/X4CodeSense/commit/8dfaa3ebd38ec2c8137f96a03e5fc7699ca6da8b))
* keep parsed expressions from one keystroke to the next ([9cb0853](https://github.com/chemodun/X4CodeSense/commit/9cb08531fbff060c94a89cdce0550abe324e4af0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.8.0 to 0.9.0

## [0.8.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.7.0...x4codesense@v0.8.0) (2026-10-01)


### Features

* an installed game read in place, and the checker's --game ([cdb2868](https://github.com/chemodun/X4CodeSense/commit/cdb286845bcbb176007444708106e3ca58437c69))
* the installed game in the extension, its files as read-only documents ([a02bc0b](https://github.com/chemodun/X4CodeSense/commit/a02bc0b99ccb8edae7e7b4b91d002e847b0329cd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.7.0 to 0.8.0

## [0.7.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.6.0...x4codesense@v0.7.0) (2026-10-01)


### Features

* --fix and SARIF output in the checker ([3e84bc2](https://github.com/chemodun/X4CodeSense/commit/3e84bc247f65aa36f111a8b564bc708817b14c7e))
* check the arguments of formats ([da8e8b1](https://github.com/chemodun/X4CodeSense/commit/da8e8b1ba50b902142ca205908bc87cf44eaa99e))
* quick fixes for tags and children ([89eeeda](https://github.com/chemodun/X4CodeSense/commit/89eeedab41e917f7538d5e6b1e6be72229a9c6b9))
* quick fixes that create what nothing defines ([ae8a7d1](https://github.com/chemodun/X4CodeSense/commit/ae8a7d1c7647764cc88687cbff360b29cb0b8387))
* signature help for the arguments of a format ([f2bb4fb](https://github.com/chemodun/X4CodeSense/commit/f2bb4fb8ca76a08a1683682e23ab16919f7688ac))
* text references completed in any XML file ([81cd880](https://github.com/chemodun/X4CodeSense/commit/81cd880760b8b65d6f03c2f4a92aac2686651e7a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.6.0 to 0.7.0

## [0.6.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.5.0...x4codesense@v0.6.0) (2026-10-01)


### Features

* choose which scripts show problems from the status bar ([2df0a7a](https://github.com/chemodun/X4CodeSense/commit/2df0a7a1fef946361af122ce83fb3581e9dc27c0))
* the workspace's problems, fix all, and unknown script names ([dd6266a](https://github.com/chemodun/X4CodeSense/commit/dd6266ad2be35915e8a60ba8588028a50fd7e816))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.5.0 to 0.6.0

## [0.5.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.4.1...x4codesense@v0.5.0) (2026-10-01)


### Features

* AI script names and order ids in calls ([14f3af5](https://github.com/chemodun/X4CodeSense/commit/14f3af585fe529c584e7d3202581b81bbd0caf14))
* Go to Symbol in Workspace ([8b66c33](https://github.com/chemodun/X4CodeSense/commit/8b66c33e14a89ecbe049c7738b5db61b0f3db1b1))
* the parameters of calls, and param-unknown ([190388a](https://github.com/chemodun/X4CodeSense/commit/190388a9486fce2681443ae93db40e4a9aaeeb34))


### Documentation

* date the 0.4.1 changelog ([55f5841](https://github.com/chemodun/X4CodeSense/commit/55f5841abaa273e241602af6e9fea5bcf4768486))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.4.1 to 0.5.0

## [0.4.1](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.4.0...x4codesense@v0.4.1) (2026-10-01)


### Bug Fixes

* the diff follows a patch moved up from the diff's group ([45b35f6](https://github.com/chemodun/X4CodeSense/commit/45b35f6bede9f781f59b132500c2c61bee157405))


### Performance Improvements

* resolve each chain once, and allocate less per expression ([cc78372](https://github.com/chemodun/X4CodeSense/commit/cc783720f5726147ed47c8c1fc43f86ffd970fb7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.4.0 to 0.4.1

## [0.4.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.3.0...x4codesense@v0.4.0) (2026-10-01)


### Features

* the script's features in both sides of a patch's diff ([cf89d4b](https://github.com/chemodun/X4CodeSense/commit/cf89d4bd8a16afdc63291ef348db369887970361))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.3.0 to 0.4.0

## [0.3.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.2.2...x4codesense@v0.3.0) (2026-09-30)


### Features

* edit a patch above the file it changes, both ways ([5d5d260](https://github.com/chemodun/X4CodeSense/commit/5d5d260c917c03b3fe771e94890249609e348ba8))


### Documentation

* **client:** date and complete the 0.3.0 changelog ([c9369c0](https://github.com/chemodun/X4CodeSense/commit/c9369c073508d4adb97bf6cd1346fd49e151cbf5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.2.1 to 0.3.0

## [0.2.2](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.2.1...x4codesense@v0.2.2) (2026-09-30)


### Bug Fixes

* hover and completion of properties whose name goes on ([3a9c0bd](https://github.com/chemodun/X4CodeSense/commit/3a9c0bddea8771df9112d2f538955161869b5adf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.2.0 to 0.2.1

## [0.2.1](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.2.0...x4codesense@v0.2.1) (2026-09-30)


### Miscellaneous Chores

* **client:** drop the preview flag ([4ece765](https://github.com/chemodun/X4CodeSense/commit/4ece765f622595cd4362902dc179856fb46b9058))

## [0.2.0](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.1.1...x4codesense@v0.2.0) (2026-09-30)


### Features

* **client:** offer the settings of X4CodeComplete ([fe4c223](https://github.com/chemodun/X4CodeSense/commit/fe4c2236630fdf5f076ec67396054d9ca794bd6b))
* semantic highlighting of script expressions ([9869769](https://github.com/chemodun/X4CodeSense/commit/986976988bcbcfaf10298719a0e7674fc217555f))
* show the text of ReadText calls in Lua files ([8f1baf1](https://github.com/chemodun/X4CodeSense/commit/8f1baf14918ca947bdb3c917f6a02e1bec1693d2))


### Documentation

* **client:** date the 0.2.0 changelog ([83cb848](https://github.com/chemodun/X4CodeSense/commit/83cb8483a041e4c918a831418f5e10cf3635d8b8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.1.1 to 0.2.0

## [0.1.1](https://github.com/chemodun/X4CodeSense/compare/x4codesense@v0.1.0...x4codesense@v0.1.1) (2026-09-29)


### Documentation

* **client:** the Marketplace README, an icon and a prepared publishing job ([a0b2f37](https://github.com/chemodun/X4CodeSense/commit/a0b2f37785bd9d967637b629ca5dfc4fced8917c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.1.0 to 0.1.1

## 0.1.0 (2026-09-29)


### Features

* apply patch documents to the files they change ([d79442e](https://github.com/chemodun/X4CodeSense/commit/d79442eed4861d93e0f543df6acaf25a07343582))
* check what a patch brings in where it lands ([9ced0ec](https://github.com/chemodun/X4CodeSense/commit/9ced0ece4f7801ab337666fcf924378a888c8d23))
* **cli:** output formats, severities and quick fixes in the checker ([d2caff8](https://github.com/chemodun/X4CodeSense/commit/d2caff8e24bf5af1da6d26c17db1108e019b72e7))
* **core:** check property chains against scriptproperties.xml ([2afe69e](https://github.com/chemodun/X4CodeSense/commit/2afe69eebf7031be2155ba63c700d2f34e3ae493))
* **core:** completion, hover and definition from schemas and scriptproperties.xml ([b889e0e](https://github.com/chemodun/X4CodeSense/commit/b889e0eda0bb82eb21a09c20088c2233c01e3e21))
* **core:** expression parser with syntax diagnostics ([b5e0353](https://github.com/chemodun/X4CodeSense/commit/b5e0353f7a8fe054a76a4eba7ebb78834846ae44))
* **core:** labels, cues and interrupt library items in one script ([e1722d2](https://github.com/chemodun/X4CodeSense/commit/e1722d213d9d1949b83621b417eca74a691ced80))
* **core:** tolerant XML structure scanner with well-formedness diagnostics ([d889b68](https://github.com/chemodun/X4CodeSense/commit/d889b68122a598c80b08fe6f9426a45e69047987))
* **core:** validate scripts against the game XSD schemas with an own schema engine ([5926e00](https://github.com/chemodun/X4CodeSense/commit/5926e006a0ab4b822110d60dac2620c1089ca916))
* **core:** variables with cue namespaces, references and rename ([d1da9c9](https://github.com/chemodun/X4CodeSense/commit/d1da9c9ce9c389b970e143d6a48e3eb8fbbca9b6))
* editor features in patch documents ([87a62a9](https://github.com/chemodun/X4CodeSense/commit/87a62a96e9063bbf2021d2ce15d6c7a0c22da433))
* extension load order, text patches and a workspace-relative extensions folder ([e4e2556](https://github.com/chemodun/X4CodeSense/commit/e4e25561e89943fcc4439f637f4a09849cafd608))
* find references and rename across scripts ([79ae3e5](https://github.com/chemodun/X4CodeSense/commit/79ae3e57f47a8983469ef1aabb65794c09fd9036))
* outline of scripts and patches ([e35306c](https://github.com/chemodun/X4CodeSense/commit/e35306c3110d49bdedc6dbdfbb15b32c86c0d2df))
* quick fixes for the diagnostics with an obvious fix ([4826432](https://github.com/chemodun/X4CodeSense/commit/48264322b4ae3d4188e86711317e4f7e9ccd21bd))
* report variables that are read but never set ([4103f04](https://github.com/chemodun/X4CodeSense/commit/4103f04dee32e7f3e2fc831f9355d97b762003b3))
* scaffold X4CodeSense workspace ([cd53c28](https://github.com/chemodun/X4CodeSense/commit/cd53c284d3690db00b33aa4ce7e5299348723f03))
* script index across the game, its DLCs and the extensions ([6c959d8](https://github.com/chemodun/X4CodeSense/commit/6c959d8f0784303736a5a45791e31042f294bf48))
* status bar, commands and patch comparison in the client ([ce349c3](https://github.com/chemodun/X4CodeSense/commit/ce349c3490b10680aee53203a6f4f069b2bf8dc7))
* text lookups for {page, id} references ([8463b72](https://github.com/chemodun/X4CodeSense/commit/8463b72643ac789ef170494665d4ca1eda3d17b3))
* variables across scripts ([415e62f](https://github.com/chemodun/X4CodeSense/commit/415e62fe22b4c29d9191e228658b74a965268927))


### Documentation

* **readme:** rewording ([6bd330d](https://github.com/chemodun/X4CodeSense/commit/6bd330d723da092670f78a5c20196d5288064a38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.0.0 to 0.1.0
