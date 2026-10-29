// The root package ships `diff` (used by gstack browse) without bundled types.
declare module 'diff' {
  export interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }
  export function diffLines(oldStr: string, newStr: string, options?: unknown): Change[];
}
