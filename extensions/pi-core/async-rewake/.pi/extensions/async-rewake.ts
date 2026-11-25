// Project-local entry for pi-async-rewake. The implementation lives in
// extension/index.ts (canonical, shipped in the npm package); this file is a
// thin re-export so the package's own repo also loads it as a project
// extension from `.pi/extensions/`.
export { default } from "../../extension/index.ts";
