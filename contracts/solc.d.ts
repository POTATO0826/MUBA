/**
 * Minimal ambient types for `solc` (solc-js ships no declarations).
 *
 * Only the standard-JSON entry points this repo uses are declared. `compile`
 * takes a JSON string and returns a JSON string — the wrapper does no parsing,
 * so both sides are typed as `string` and `contracts/build.ts` owns the shape
 * of what goes in and comes out.
 */
declare module "solc" {
  interface SolcImportResult {
    contents?: string;
    error?: string;
  }

  interface SolcCallbacks {
    import?: (path: string) => SolcImportResult;
  }

  interface Solc {
    /** e.g. `0.8.26+commit.8a97fa7a.Emscripten.clang` */
    version(): string;
    /** e.g. `0.8.26` */
    semver(): string;
    /** Standard JSON in, standard JSON out. */
    compile(input: string, callbacks?: SolcCallbacks): string;
  }

  const solc: Solc;
  export default solc;
}
