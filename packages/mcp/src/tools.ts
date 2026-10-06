/**
 * The tools: what X4CodeSense knows of the game's scripts, for agents that write them. Everything is read
 * only. Lines and columns count from 1, columns in UTF-16 code units, as editors count them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { serverIcon } from './icon';
import {
  analyzeDocument,
  chainAtToken,
  checkFile,
  collectScriptFolders,
  definitionAt,
  diskFiles,
  enumerationsOf,
  findSymbols,
  folderOfFile,
  hoverAt,
  isExpressionAttribute,
  isGameFile,
  missingTextMessage,
  propertiesOf,
  referencesAt,
  resolveChain,
  severities,
  xmlFilesOf,
  type ChainOwner,
  type DocumentAnalysis,
  type FileFolder,
  type Finding,
  type GameData,
  type ScriptDatatype,
  type ScriptProperties,
  type ScriptProperty,
  type ScriptSchema,
  type XsdAttribute,
  type XsdElement,
} from 'x4-script-core';
import * as z from 'zod';
import type { Workspace } from './workspace';

/** An LSP range: lines and characters count from 0. */
interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** The most findings, locations, properties or texts a call gives; the rest is counted. */
const findingLimit = 300;
const locationLimit = 200;
const propertyLimit = 300;
const valueLimit = 20;
const fullValueLimit = 500;

/** How long a call waits for the watchers, in milliseconds: they tell of a change a few after it. */
const watcherDelay = 15;

const noGame = 'No game files: the server was started without --unpacked or --game, or could not read them (see the status tool).';

const instructions = `X4CodeSense knows X4: Foundations scripts, Mission Director scripts (md) and AI scripts (aiscripts), from the game's own files: the schemas md.xsd and aiscripts.xsd, scriptproperties.xml with the keywords, datatypes and properties of expressions, the texts, and every script of the game, its DLCs and the extensions it was given.
- Before writing an element or attribute you are not sure of, ask describe_element; for what an expression yields and which properties it has, expression_type.
- After writing a script or a patch (a <diff> file), run check on it and fix what it reports; with text, check what you are about to write first.
- find, definition and references locate scripts, cues, libraries and interrupt handlers across the game and the extensions; hover tells what a place of a script is, as the editor's hover does; text looks up {page, id} texts or searches them.
Use these tools rather than searching the game's .xsd files, scriptproperties.xml or text files: they follow the schemas' types, groups and includes, and know the DLCs and the extensions too.
Lines and columns count from 1.`;

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A range as 1-based lines and columns. */
function placeOf(range: Range): { line: number; column: number; endLine: number; endColumn: number } {
  return { line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1 };
}

/** A path from a file URI; other URIs as they are. */
function fileOfUri(uri: string): string {
  return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
}

/** Up to `limit` items and how many were left out. */
function limited<T>(items: readonly T[], limit: number): { shown: T[]; more?: number } {
  return items.length > limit ? { shown: items.slice(0, limit), more: items.length - limit } : { shown: [...items] };
}

/** Reads the lines of files for the places a call reports, each file once. */
class Lines {
  private readonly files = new Map<string, string[] | undefined>();

  constructor(private readonly game: GameData | undefined) {}

  /** The line, trimmed and shortened; undefined when the file cannot be read. */
  line(file: string, line: number): string | undefined {
    let lines = this.files.get(file);
    if (!this.files.has(file)) {
      try {
        lines = (this.game?.index?.currentText(file) ?? (this.game?.files ?? diskFiles).readText(file)).split(/\r?\n/);
      } catch {
        lines = undefined;
      }
      this.files.set(file, lines);
    }
    const text = lines?.[line]?.trim();
    return text === undefined ? undefined : text.length > 200 ? `${text.slice(0, 199)}…` : text;
  }
}

/** A location as the tools report it: the file, the place, the line's text; `game` for a file of the game or a DLC. */
function locationOf(uri: string, range: Range, lines: Lines, game: GameData | undefined): Record<string, unknown> {
  const file = fileOfUri(uri);
  const text = lines.line(file, range.start.line);
  return { file, ...placeOf(range), ...(text === undefined ? {} : { text }), ...(isGameFile(file, game) ? { game: true } : {}) };
}

function reportedFinding(finding: Finding): Record<string, unknown> {
  return {
    file: finding.file,
    ...(finding.range ? placeOf(finding.range) : {}),
    severity: finding.severity,
    code: finding.code,
    message: finding.message,
    fixes: finding.fixes.map((fix) => ({
      title: fix.title,
      preferred: fix.preferred,
      edits: fix.edits.map((edit) => ({ ...placeOf(edit.range), newText: edit.newText })),
    })),
  };
}

/** Names close to a wanted one, for a message: those that contain it or that it contains, then those that share its start. */
function similar(names: Iterable<string>, wanted: string): string[] {
  const lower = wanted.toLowerCase();
  const all = [...new Set(names)];
  const containing = all.filter((name) => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()));
  const sharing = all.filter((name) => !containing.includes(name) && name.toLowerCase().startsWith(lower.slice(0, 3)));
  return [...containing, ...sharing].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, 12);
}

function checkTool(workspace: Workspace, paths: readonly string[], text: string | undefined, least: (typeof severities)[number]): CallToolResult {
  const game = workspace.game;
  const files = game?.files ?? diskFiles;
  if (text !== undefined && paths.length !== 1) {
    return failure('text is the text of one file: give exactly one path with it.');
  }
  const checked = new Map<string, FileFolder>();
  for (const given of paths) {
    const resolved = path.resolve(given);
    if (text === undefined && files.isDirectory(resolved)) {
      for (const folder of collectScriptFolders(resolved, files, game)) {
        for (const file of xmlFilesOf(files, folder.folder)) {
          checked.set(file, folder.kind);
        }
      }
    } else if (text !== undefined || files.exists(resolved)) {
      checked.set(resolved, folderOfFile(resolved));
    } else {
      return failure(`Not found: ${resolved}`);
    }
  }
  workspace.touch(checked.keys());
  const findings: Finding[] = [];
  const summary = { files: 0, scripts: 0, patches: 0 };
  for (const [file, folder] of checked) {
    const result = checkFile(file, folder, workspace.context, game, text);
    summary.files++;
    summary.scripts += result.kind === 'script' ? 1 : 0;
    summary.patches += result.kind === 'patch' ? 1 : 0;
    findings.push(...result.findings.filter((finding) => severities.indexOf(finding.severity) <= severities.indexOf(least)));
  }
  const count = (severity: string): number => findings.filter((finding) => finding.severity === severity).length;
  const { shown, more } = limited(findings, findingLimit);
  return json({
    findings: shown.map(reportedFinding),
    ...(more ? { moreFindings: more } : {}),
    summary: {
      ...summary,
      findings: findings.length,
      errors: count('error'),
      warnings: count('warning'),
      info: count('info'),
      hints: count('hint'),
      schemaValidation: workspace.context.schemas !== undefined,
    },
  });
}

/** An attribute: its values by name only, the first few; in full, every value with its documentation. */
function attributeOf(attribute: XsdAttribute, full: boolean): Record<string, unknown> {
  const values = enumerationsOf(attribute.type);
  const { shown, more } = limited(values, full ? fullValueLimit : valueLimit);
  return {
    name: attribute.name,
    type: attribute.typeName ?? attribute.type.name ?? attribute.type.builtin,
    required: attribute.required,
    ...(attribute.default === undefined ? {} : { default: attribute.default }),
    expression: isExpressionAttribute(attribute),
    ...(attribute.documentation ? { documentation: attribute.documentation } : {}),
    ...(values.length > 0
      ? {
          values: shown.map((value) =>
            !full ? value.value : value.documentation ? { value: value.value, documentation: value.documentation } : { value: value.value }
          ),
        }
      : {}),
    ...(more ? { moreValues: more } : {}),
  };
}

function describeElementTool(
  workspace: Workspace,
  name: string,
  script: ScriptSchema,
  parent: string | undefined,
  attributeName: string | undefined
): CallToolResult {
  const schema = workspace.game?.schemas.schemas[script];
  if (!schema) {
    return failure(workspace.game ? `The game files have no ${script}.xsd.` : noGame);
  }
  let declaration: XsdElement | undefined;
  if (parent !== undefined) {
    const parentDeclaration = schema.anyDeclaration(parent);
    if (!parentDeclaration) {
      return failure(`${script}.xsd declares no element <${parent}>. Similar: ${similar(schema.elementNames, parent).join(', ') || 'none'}.`);
    }
    declaration = parentDeclaration.child(name);
    if (!declaration) {
      const children = [...parentDeclaration.contentModel.declarations.keys()];
      return failure(`<${parent}> does not allow <${name}>. It allows: ${children.join(', ') || 'no elements'}.`);
    }
  } else {
    declaration = schema.root(name) ?? schema.anyDeclaration(name);
  }
  if (!declaration) {
    return failure(`${script}.xsd declares no element <${name}>. Similar: ${similar(schema.elementNames, name).join(', ') || 'none'}.`);
  }
  if (attributeName !== undefined) {
    const attribute = declaration.attributes.get(attributeName);
    if (!attribute) {
      return failure(`<${declaration.name}> has no attribute '${attributeName}'. It has: ${[...declaration.attributes.keys()].join(', ') || 'none'}.`);
    }
    return json({ element: declaration.name, script, attribute: attributeOf(attribute, true) });
  }
  return json({
    element: declaration.name,
    script,
    ...(declaration.documentation ? { documentation: declaration.documentation } : {}),
    attributes: [...declaration.attributes.values()].map((attribute) => attributeOf(attribute, false)),
    children: [...declaration.contentModel.declarations.keys()],
    text: declaration.allowsText,
  });
}

function propertyOf(property: ScriptProperty): Record<string, unknown> {
  return {
    name: property.name,
    of: property.owner.name,
    ...(property.type === undefined ? {} : { type: property.type }),
    ...(property.result ? { description: property.result } : {}),
  };
}

/** A property on one line: `iscontestedby.{$faction} → boolean`. */
function propertyLine(property: ScriptProperty): string {
  return property.type === undefined ? property.name : `${property.name} → ${property.type}`;
}

/**
 * The properties of what a chain yields, or of a datatype. Without a filter, its own and inherited ones on
 * a line each, and how many the types derived from it add (a component may be a ship); with one, those of
 * them all whose names contain it, with their descriptions.
 */
function propertyList(owner: ChainOwner, properties: ScriptProperties, filter: string | undefined): Record<string, unknown> {
  const own = new Set<string>(
    owner.kind === 'datatype'
      ? [...owner.datatype.chain()].map((type) => type.name)
      : owner.kind === 'keyword'
        ? [owner.keyword.name, ...[...(owner.keyword.type?.chain() ?? [])].map((type) => type.name)]
        : []
  );
  const seen = new Set<ScriptProperty>();
  const all = [...propertiesOf(owner, properties)].filter((property) => {
    const first = !seen.has(property);
    seen.add(property);
    return first;
  });
  if (filter === undefined) {
    const inherited = all.filter((property) => own.has(property.owner.name));
    const { shown, more } = limited(inherited, propertyLimit);
    const derived = all.length - inherited.length;
    return {
      properties: shown.map(propertyLine),
      ...(more ? { moreProperties: more } : {}),
      ...(derived > 0 ? { derivedTypeProperties: derived } : {}),
    };
  }
  const wanted = filter.toLowerCase();
  const { shown, more } = limited(
    all.filter((property) => property.name.toLowerCase().includes(wanted)),
    propertyLimit
  );
  return { properties: shown.map(propertyOf), ...(more ? { moreProperties: more } : {}) };
}

function datatypeOf(datatype: ScriptDatatype): Record<string, unknown> {
  return {
    datatype: datatype.name,
    supertypes: [...datatype.chain()].slice(1).map((type) => type.name),
    ...(datatype.suffix === undefined ? {} : { suffix: datatype.suffix }),
    ...(datatype.pseudo ? { pseudo: true } : {}),
  };
}

function expressionTypeTool(
  workspace: Workspace,
  expression: string | undefined,
  datatypeName: string | undefined,
  script: ScriptSchema,
  filter: string | undefined
): CallToolResult {
  const properties = workspace.game?.properties;
  if (!properties) {
    return failure(workspace.game ? 'The game files have no scriptproperties.xml.' : noGame);
  }
  if ((expression === undefined) === (datatypeName === undefined)) {
    return failure('Give either expression or datatype.');
  }
  if (datatypeName !== undefined) {
    const datatype = properties.datatype(datatypeName);
    if (!datatype) {
      return failure(
        `scriptproperties.xml has no datatype '${datatypeName}'. Similar: ${similar(properties.datatypes.keys(), datatypeName).join(', ') || 'none'}.`
      );
    }
    return json({ ...datatypeOf(datatype), ...propertyList({ kind: 'datatype', datatype }, properties, filter) });
  }
  const text = (expression ?? '').trim();
  const found = text === '' ? undefined : chainAtToken(text, 0);
  const steps = found?.chain.steps ?? [];
  if (!found || steps[steps.length - 1].end !== text.length) {
    return failure(`Not a chain of a keyword and its properties: '${text}'. Give one such as player.ship.sector, or a datatype.`);
  }
  const resolved = resolveChain(found.chain, properties, script);
  const reported = resolved.steps.map((step) => {
    const candidates = step.candidates && step.candidates.length > 1 ? step.candidates : undefined;
    return {
      step: step.step.text,
      ...(step.keyword ? { keyword: step.keyword.name, ...(step.keyword.description ? { description: step.keyword.description } : {}) } : {}),
      ...(step.property && !candidates ? propertyOf(step.property) : {}),
      ...(candidates ? { candidates: candidates.slice(0, 8).map(propertyOf) } : {}),
      ...(step.datatype ? { type: step.datatype.name } : {}),
    };
  });
  const owner = resolved.owners[steps.length] ?? { kind: 'unknown' };
  const unknownAt = resolved.steps.findIndex((step) => !step.keyword && !step.property && !(step.candidates && step.candidates.length > 0));
  const result =
    owner.kind === 'datatype'
      ? { result: datatypeOf(owner.datatype), ...propertyList(owner, properties, filter) }
      : owner.kind === 'keyword'
        ? { result: { keyword: owner.keyword.name }, ...propertyList(owner, properties, filter) }
        : { result: null, note: unknownAt < 0 ? 'The type of the result is not known.' : `'${steps[unknownAt].text}' is no keyword or property known here.` };
  return json({ expression: text, script, steps: reported, ...result });
}

function findTool(workspace: Workspace, query: string, limit: number): CallToolResult {
  const game = workspace.game;
  if (!game?.index) {
    return failure(noGame);
  }
  const lines = new Lines(game);
  const symbols = findSymbols(game.index, query, { limit, preferredFolders: workspace.extensionFolders });
  const wanted = query.trim().toLowerCase();
  // The names that contain the query; those that only have its letters in order when there are none.
  const containing = symbols.filter((symbol) => (wanted.includes('.') ? symbol.qualified : symbol.name).toLowerCase().includes(wanted));
  const found = containing.length > 0 ? containing : symbols.slice(0, 10);
  const names = found.map((symbol) => {
    const { file, line, character } = symbol.position;
    const range = { start: { line, character }, end: { line, character: character + symbol.name.length } };
    return {
      name: symbol.name,
      qualified: symbol.qualified,
      kind: symbol.what,
      in: symbol.container,
      ...locationOf(pathToFileURL(file).toString(), range, lines, game),
    };
  });
  return json(containing.length > 0 || found.length === 0 ? names : { note: `No name contains '${query}'; these have its letters in order.`, names });
}

/** The analysis of a file and the offset of a 1-based line and column in it, or the failure to report. */
function analysedAt(workspace: Workspace, file: string, line: number, column: number): { analysis: DocumentAnalysis; offset: number } | CallToolResult {
  const resolved = path.resolve(file);
  workspace.touch([resolved]);
  let text: string;
  try {
    text = (workspace.game?.files ?? diskFiles).readText(resolved);
  } catch {
    return failure(`Not found: ${resolved}`);
  }
  const document = TextDocument.create(pathToFileURL(resolved).toString(), 'xml', 0, text);
  if (line > document.lineCount) {
    return failure(`${resolved} has ${document.lineCount} lines.`);
  }
  const offset = document.offsetAt({ line: line - 1, character: column - 1 });
  return { analysis: analyzeDocument(document, workspace.context), offset };
}

function positionTool(workspace: Workspace, file: string, line: number, column: number, wanted: 'definition' | 'references'): CallToolResult {
  const game = workspace.game;
  const at = analysedAt(workspace, file, line, column);
  if ('content' in at) {
    return at;
  }
  const { analysis, offset } = at;
  const language = workspace.options.language;
  const found = wanted === 'definition' ? definitionAt(analysis, offset, game, { language }) : referencesAt(analysis, offset, game);
  const lines = new Lines(game);
  const { shown, more } = limited(found, locationLimit);
  return json({
    [wanted]: shown.map((location) => locationOf(location.uri, location.range, lines, game)),
    ...(more ? { more } : {}),
    ...(found.length === 0
      ? { note: `Nothing at line ${line}, column ${column} has a ${wanted === 'definition' ? 'definition' : 'reference'} known here.` }
      : {}),
  });
}

/** The Markdown of a hover's contents, in any of the forms the protocol allows. */
function markdownOf(contents: NonNullable<ReturnType<typeof hoverAt>>['contents']): string {
  const parts = Array.isArray(contents) ? contents : [contents];
  return parts.map((part) => (typeof part === 'string' ? part : 'kind' in part ? part.value : `\`\`\`${part.language}\n${part.value}\n\`\`\``)).join('\n\n');
}

function hoverTool(workspace: Workspace, file: string, line: number, column: number): CallToolResult {
  const at = analysedAt(workspace, file, line, column);
  if ('content' in at) {
    return at;
  }
  const found = hoverAt(at.analysis, at.offset, workspace.game, { language: workspace.options.language });
  if (!found) {
    return json({ note: `Nothing at line ${line}, column ${column} has a description known here.` });
  }
  return json({ hover: markdownOf(found.contents), ...(found.range ? placeOf(found.range) : {}) });
}

function textTool(
  workspace: Workspace,
  page: number | undefined,
  id: number | undefined,
  search: string | undefined,
  language: string | undefined,
  limit: number
): CallToolResult {
  const texts = workspace.game?.texts;
  if (!texts || texts.fileCount === 0) {
    return failure(workspace.game ? 'The game files have no texts.' : noGame);
  }
  const wantedLanguage = language ?? workspace.options.language;
  const shown = (textPage: number, textId: number): Record<string, unknown> | undefined => {
    const picked = texts.pick(textPage, textId, wantedLanguage);
    if (!picked) {
      return undefined;
    }
    const display = texts.display(picked.text, picked.language);
    return {
      page: textPage,
      id: textId,
      language: picked.language,
      text: display,
      ...(display === picked.text ? {} : { written: picked.text }),
      file: picked.file,
      line: picked.line + 1,
    };
  };
  if (search !== undefined) {
    const words = search
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== '');
    const matches: Record<string, unknown>[] = [];
    let total = 0;
    for (const textPage of texts.pages()) {
      for (const textId of texts.ids(textPage.id)) {
        const picked = texts.pick(textPage.id, textId, wantedLanguage);
        const display = picked ? texts.display(picked.text, picked.language).toLowerCase() : '';
        if (words.length > 0 && words.every((word) => display.includes(word))) {
          total++;
          if (matches.length < limit) {
            matches.push(shown(textPage.id, textId) ?? {});
          }
        }
      }
    }
    return json({ texts: matches, ...(total > matches.length ? { more: total - matches.length } : {}) });
  }
  if (page === undefined) {
    return failure('Give page and id, page alone for its texts, or search.');
  }
  if (id !== undefined) {
    const text = shown(page, id);
    if (!text) {
      return failure(missingTextMessage(texts, page, id) ?? `No text {${page}, ${id}}.`);
    }
    return json({ ...text, pageTitle: texts.page(page)?.title, languages: texts.languagesOf(page, id, wantedLanguage) });
  }
  const textPage = texts.page(page);
  if (!textPage) {
    return failure(`No text page ${page}.`);
  }
  const ids = texts.ids(page);
  return json({
    page,
    ...(textPage.title ? { title: textPage.title } : {}),
    texts: ids.slice(0, limit).map((textId) => shown(page, textId) ?? { page, id: textId }),
    ...(ids.length > limit ? { more: ids.length - limit } : {}),
  });
}

function statusTool(workspace: Workspace, version: string | undefined): CallToolResult {
  const game = workspace.game;
  return json({
    ...(version ? { version } : {}),
    game: workspace.gameFolder ?? null,
    gameKind: workspace.options.unpacked !== undefined ? 'extracted' : workspace.options.game !== undefined ? 'installed' : null,
    loaded: game !== undefined,
    ...(game ? { loadSeconds: Math.round(workspace.loadTime / 100) / 10 } : {}),
    extensions: workspace.extensionFolders,
    schemas: game ? Object.keys(game.schemas.schemas) : [],
    scriptProperties: game?.properties !== undefined,
    indexedFiles: game?.index?.size ?? 0,
    texts: game?.texts.textCount ?? 0,
    textFiles: game?.texts.fileCount ?? 0,
    language: workspace.options.language,
    structure: workspace.options.structure,
    typeGuesses: workspace.options.typeGuesses,
    problems: workspace.problems.slice(0, 50),
    ...(workspace.problems.length > 50 ? { moreProblems: workspace.problems.length - 50 } : {}),
  });
}

/** A call's arguments for the log: long texts shortened, `text` to check by its length. */
function argumentsShown(args: Record<string, unknown>): string {
  return JSON.stringify(args, (key, value: unknown) => {
    if (key === 'text' && typeof value === 'string') {
      return `(${value.length} characters)`;
    }
    return typeof value === 'string' && value.length > 120 ? `${value.slice(0, 119)}…` : value;
  });
}

const scriptKind = z.enum(['md', 'aiscripts']).describe('md for Mission Director scripts, aiscripts for AI scripts.');
const readOnly = { readOnlyHint: true, openWorldHint: false };

/** The server with its tools; every call first reads what changed in the extensions. */
export function createServer(workspace: Workspace, version?: string): McpServer {
  const server = new McpServer({ name: 'x4-script-mcp', title: 'X4CodeSense', version: version ?? '0.0.0', icons: [serverIcon] }, { instructions });
  /**
   * Runs a tool on a current workspace; an error is reported to the agent, not thrown. Each call is logged
   * on standard error, which clients show as the server's log: what agents ask, and how it went.
   */
  const answer = async (tool: string, args: Record<string, unknown>, body: () => CallToolResult): Promise<CallToolResult> => {
    // What the watchers have to report is taken first: a file written just before the call.
    await new Promise((resolve) => setTimeout(resolve, watcherDelay));
    const started = performance.now();
    let result: CallToolResult;
    try {
      workspace.current();
      result = body();
    } catch (error) {
      result = failure(`Failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    const size = result.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
    const outcome = result.isError ? `error: ${result.content[0]?.type === 'text' ? result.content[0].text.split('\n')[0] : ''}` : `${size} characters`;
    console.error(`x4-script-mcp: ${tool} ${argumentsShown(args)} in ${Math.round(performance.now() - started)} ms: ${outcome}`);
    return result;
  };

  server.registerTool(
    'check',
    {
      title: 'Check scripts',
      description:
        'Checks X4 scripts and patches as the X4CodeSense editor and x4-script-check do: well-formedness, the game schemas, expressions, variables, names, cues, scripts and texts referred to. Returns the findings with their quick fixes (edits to apply), and counts. Run it after every change to an md or aiscripts script or a patch, and fix what it reports; with text, check a draft before writing it.',
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe(
            'Files and folders. A folder is checked as x4-script-check checks it: the md, aiscripts and libraries folders in it and one level deeper, so an extension or a folder of extensions. Relative paths are taken from the server’s working folder.'
          ),
        text: z.string().optional().describe('The text to check instead of what is on disk, for one file in paths: what you are about to write there.'),
        severity: z.enum(severities).optional().describe('The least severe finding to report: error, warning, info or hint (the default, all).'),
      },
      annotations: readOnly,
    },
    (args) => answer('check', args, () => checkTool(workspace, args.paths, args.text, args.severity ?? 'hint'))
  );

  server.registerTool(
    'describe_element',
    {
      title: 'Describe an element',
      description:
        'An element of the Mission Director or AI script schema, from the game’s md.xsd or aiscripts.xsd: its documentation, its attributes (type, required, default, allowed values, whether the value is an expression) and the child elements it allows. Use it before writing an element or attribute you are not sure of, instead of searching md.xsd, aiscripts.xsd or common.xsd: it follows their types, groups and includes.',
      inputSchema: {
        name: z.string().describe('The element name: set_value, find_ship, create_order, cue.'),
        script: scriptKind,
        parent: z.string().optional().describe('The parent element, for an element declared differently in different places, such as param or actions.'),
        attribute: z
          .string()
          .optional()
          .describe('One attribute in full: every allowed value with its documentation. Without it, every attribute with the first values by name.'),
      },
      annotations: readOnly,
    },
    (args) => answer('describe_element', args, () => describeElementTool(workspace, args.name, args.script, args.parent, args.attribute))
  );

  server.registerTool(
    'expression_type',
    {
      title: 'Type of an expression',
      description:
        'What a keyword or a property chain of the expression language yields, step by step, from the game’s scriptproperties.xml: player.ship, player.ship.sector, event.param; and the properties of the result with their types. Or a datatype’s properties. A variable has no type here, its type comes from the script around it: the step after it is matched against the properties of every datatype. Use it before writing a property chain you are not sure of, instead of searching scriptproperties.xml.',
      inputSchema: {
        expression: z.string().optional().describe('A keyword and its properties: player.ship.sector.'),
        datatype: z.string().optional().describe('Instead of an expression, a datatype: ship, sector, list, faction.'),
        script: scriptKind.optional().describe('The script kind, for the keywords of one kind only: md (the default) or aiscripts.'),
        filter: z
          .string()
          .optional()
          .describe(
            'Only the properties of the result whose names contain this text, with their descriptions, also those of the types derived from it. Without it, its own and inherited properties as name → type.'
          ),
      },
      annotations: readOnly,
    },
    (args) => answer('expression_type', args, () => expressionTypeTool(workspace, args.expression, args.datatype, args.script ?? 'md', args.filter))
  );

  server.registerTool(
    'find',
    {
      title: 'Find scripts and cues',
      description:
        'Mission Director scripts, AI scripts, cues, libraries and interrupt library items (actions, handlers, conditions) of the game, its DLCs and the extensions, by name: whole names first, then those starting with the query, then those containing it; the extensions’ before the game’s among equals. A query with a dot matches qualified names: md.Setup.Start. When no name contains the query, a few that have its letters in order. Use it instead of searching the files for a cue or script name.',
      inputSchema: {
        query: z.string().describe('A name or part of one.'),
        limit: z.number().int().min(1).max(500).optional().describe('The most names to return; 50 by default.'),
      },
      annotations: readOnly,
    },
    (args) => answer('find', args, () => findTool(workspace, args.query, args.limit ?? 50))
  );

  const position = {
    file: z.string().describe('The script or patch.'),
    line: z.number().int().min(1).describe('The line, from 1.'),
    column: z.number().int().min(1).describe('The column, from 1.'),
  };
  server.registerTool(
    'definition',
    {
      title: 'Go to definition',
      description:
        'Where what is named at a place of a script is defined, as the editor’s go to definition finds it: a cue, script, library, label, variable, order, text, element or attribute of the schema, property of scriptproperties.xml. Each place with its line of text.',
      inputSchema: position,
      annotations: readOnly,
    },
    (args) => answer('definition', args, () => positionTool(workspace, args.file, args.line, args.column, 'definition'))
  );
  server.registerTool(
    'references',
    {
      title: 'Find references',
      description:
        'Every place that names what is named at a place of a script, in the game, its DLCs and the extensions, as the editor finds them: who signals a cue, includes a library, runs a script. Each place with its line of text. Use it instead of searching the files for a name.',
      inputSchema: position,
      annotations: readOnly,
    },
    (args) => answer('references', args, () => positionTool(workspace, args.file, args.line, args.column, 'references'))
  );
  server.registerTool(
    'hover',
    {
      title: 'Describe a place',
      description:
        'What the editor’s hover shows for a place of a script or patch: an element or attribute with its documentation from the schema, a step of a property chain with its type and description from scriptproperties.xml, a variable with its type and where the type comes from, a cue or script with where it is defined, a {page, id} text as the game shows it. Use it to understand a line of an existing script, the game’s included, instead of looking each part up in the schemas, scriptproperties.xml or the t folders.',
      inputSchema: position,
      annotations: readOnly,
    },
    (args) => answer('hover', args, () => hoverTool(workspace, args.file, args.line, args.column))
  );

  server.registerTool(
    'text',
    {
      title: 'Look up texts',
      description:
        'Texts of the game and the extensions, as the game shows them, references resolved: {page, id} in a language; the texts of a page; or the texts that contain some words. Use it instead of searching the t folders: for what a {page, id} says, or to find an existing text to reuse.',
      inputSchema: {
        page: z.number().int().optional().describe('The page id.'),
        id: z.number().int().optional().describe('The text id on the page; without it, the texts of the page.'),
        search: z.string().optional().describe('Instead of page and id: words that must all be in the text, without regard to case.'),
        language: z.string().optional().describe('The language number, 44 for English; by default the one the server was started with.'),
        limit: z.number().int().min(1).max(500).optional().describe('The most texts to return for a page or a search; 20 by default.'),
      },
      annotations: readOnly,
    },
    (args) => answer('text', args, () => textTool(workspace, args.page, args.id, args.search, args.language, args.limit ?? 20))
  );

  server.registerTool(
    'status',
    {
      title: 'Status',
      description: 'What the server read: the game folder, the extension folders, how many scripts and texts, and the problems met reading them.',
      annotations: readOnly,
    },
    () => answer('status', {}, () => statusTool(workspace, version))
  );

  return server;
}
