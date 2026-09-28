/** Where a definition lives in a game data file: the start tag of its node, as offsets into that file's text. */
export interface SourceLocation {
  /** Absolute path of the file. */
  file: string;
  start: number;
  end: number;
}
