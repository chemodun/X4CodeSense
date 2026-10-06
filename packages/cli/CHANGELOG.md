# Changelog

## [1.1.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v1.0.0...x4-script-check@v1.1.0) (2026-10-06)


### Features

* the mods installed in the game that the extensions need are read, packed ones from their catalogs ([8148bde](https://github.com/chemodun/X4CodeSense/commit/8148bde0b8c565c3eb88b6fb3c8a3ba64910bbb3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.10.1 to 0.11.0

## [1.0.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.6.0...x4-script-check@v1.0.0) (2026-10-05)


### Miscellaneous Chores

* release 1.0.0 of the extension and x4-script-check ([070ea08](https://github.com/chemodun/X4CodeSense/commit/070ea08092fb6a0663f4b29273e953788db217d4))

## [0.6.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.5.1...x4-script-check@v0.6.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* x4-script-check exits with 0 when the only findings are information or hints; pass --fail-on hint for the old behaviour. The command id x4CodeSense.selectGameFolder is now x4CodeSense.selectExtractedFiles; keybindings made for the old id have to be made again.

### Bug Fixes

* x4-script-check fails on warnings by default; the command to select the extracted files has an id after its title ([056a9a4](https://github.com/chemodun/X4CodeSense/commit/056a9a4e6b6154ca8eee8ebccecc38abedc802a5))

## [0.5.1](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.5.0...x4-script-check@v0.5.1) (2026-10-03)


### Bug Fixes

* agents told when to use the MCP tools, each call logged, the server in the MCP Registry; the tests type-checked ([0476e6d](https://github.com/chemodun/X4CodeSense/commit/0476e6d625265b000644070a471b3ad732f6dbe6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.10.0 to 0.10.1

## [0.5.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.4.0...x4-script-check@v0.5.0) (2026-10-03)


### Features

* x4-script-mcp, an MCP server for AI agents that write scripts, offered by the extension to VS Code's agents ([e7ede0e](https://github.com/chemodun/X4CodeSense/commit/e7ede0e070167ee1d79459f8b1146173bb3f2e42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.9.0 to 0.10.0

## [0.4.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.3.0...x4-script-check@v0.4.0) (2026-10-02)


### Features

* patches and merge files of the game's library files ([628a5b6](https://github.com/chemodun/X4CodeSense/commit/628a5b631284c12340f5aca8ca75d6bbcd86a861))
* report text inside elements, and refuse it in the side of a patch ([97d0f22](https://github.com/chemodun/X4CodeSense/commit/97d0f227d088e533b4a99407dc9d80cd20b5871f))
* the extension brings the checker along, settings of another type and deleted folders no longer stop or fool the server ([de1f609](https://github.com/chemodun/X4CodeSense/commit/de1f609b592d9dfe91e37c5d3500e8f08d8d772e))
* variable types from what sets them, guessed for actions from the schema's words ([fabb120](https://github.com/chemodun/X4CodeSense/commit/fabb120462e7c7d10f2b1197c45a766375611f2b))
* well-formedness the game's parser checks, a script whose root lost its &gt; stays checked ([ddccfb4](https://github.com/chemodun/X4CodeSense/commit/ddccfb4e759a3aa5c38be77191e0630e01fd9ece))


### Bug Fixes

* no unset-variable finding after the include of a library chosen at run time ([89604ab](https://github.com/chemodun/X4CodeSense/commit/89604ab7d5ee7a2d642868a4ea7434f77ce63b3e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.8.0 to 0.9.0

## [0.3.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.2.0...x4-script-check@v0.3.0) (2026-10-01)


### Features

* an installed game read in place, and the checker's --game ([cdb2868](https://github.com/chemodun/X4CodeSense/commit/cdb286845bcbb176007444708106e3ca58437c69))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.7.0 to 0.8.0

## [0.2.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.8...x4-script-check@v0.2.0) (2026-10-01)


### Features

* --fix and SARIF output in the checker ([3e84bc2](https://github.com/chemodun/X4CodeSense/commit/3e84bc247f65aa36f111a8b564bc708817b14c7e))
* quick fixes for tags and children ([89eeeda](https://github.com/chemodun/X4CodeSense/commit/89eeedab41e917f7538d5e6b1e6be72229a9c6b9))
* quick fixes that create what nothing defines ([ae8a7d1](https://github.com/chemodun/X4CodeSense/commit/ae8a7d1c7647764cc88687cbff360b29cb0b8387))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.6.0 to 0.7.0

## [0.1.8](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.7...x4-script-check@v0.1.8) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.5.0 to 0.6.0

## [0.1.7](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.6...x4-script-check@v0.1.7) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.4.1 to 0.5.0

## [0.1.6](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.5...x4-script-check@v0.1.6) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.4.0 to 0.4.1

## [0.1.5](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.4...x4-script-check@v0.1.5) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.3.0 to 0.4.0

## [0.1.4](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.3...x4-script-check@v0.1.4) (2026-09-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.2.1 to 0.3.0

## [0.1.3](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.2...x4-script-check@v0.1.3) (2026-09-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.2.0 to 0.2.1

## [0.1.2](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.1...x4-script-check@v0.1.2) (2026-09-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.1.1 to 0.2.0

## [0.1.1](https://github.com/chemodun/X4CodeSense/compare/x4-script-check@v0.1.0...x4-script-check@v0.1.1) (2026-09-29)


### Documentation

* **readme:** drop the first-publication instructions ([3cd1368](https://github.com/chemodun/X4CodeSense/commit/3cd1368860974ecf5f25cf5725fbebd1c237de95))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.1.0 to 0.1.1

## 0.1.0 (2026-09-29)


### Features

* apply patch documents to the files they change ([d79442e](https://github.com/chemodun/X4CodeSense/commit/d79442eed4861d93e0f543df6acaf25a07343582))
* **cli:** output formats, severities and quick fixes in the checker ([d2caff8](https://github.com/chemodun/X4CodeSense/commit/d2caff8e24bf5af1da6d26c17db1108e019b72e7))
* **core:** check property chains against scriptproperties.xml ([2afe69e](https://github.com/chemodun/X4CodeSense/commit/2afe69eebf7031be2155ba63c700d2f34e3ae493))
* **core:** tolerant XML structure scanner with well-formedness diagnostics ([d889b68](https://github.com/chemodun/X4CodeSense/commit/d889b68122a598c80b08fe6f9426a45e69047987))
* **core:** validate scripts against the game XSD schemas with an own schema engine ([5926e00](https://github.com/chemodun/X4CodeSense/commit/5926e006a0ab4b822110d60dac2620c1089ca916))
* **core:** variables with cue namespaces, references and rename ([d1da9c9](https://github.com/chemodun/X4CodeSense/commit/d1da9c9ce9c389b970e143d6a48e3eb8fbbca9b6))
* extension load order, text patches and a workspace-relative extensions folder ([e4e2556](https://github.com/chemodun/X4CodeSense/commit/e4e25561e89943fcc4439f637f4a09849cafd608))
* scaffold X4CodeSense workspace ([cd53c28](https://github.com/chemodun/X4CodeSense/commit/cd53c284d3690db00b33aa4ce7e5299348723f03))
* script index across the game, its DLCs and the extensions ([6c959d8](https://github.com/chemodun/X4CodeSense/commit/6c959d8f0784303736a5a45791e31042f294bf48))
* text lookups for {page, id} references ([8463b72](https://github.com/chemodun/X4CodeSense/commit/8463b72643ac789ef170494665d4ca1eda3d17b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * x4-script-core bumped from 0.0.0 to 0.1.0
