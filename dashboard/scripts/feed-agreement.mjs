// The feed agreement's runner (docs/runbooks/feed-agreement.md): loads src/lib/feed-agreement-run.ts through Vite's
// module runner (the same "@" alias and server-only stub as the unit tests) and runs it. Reports go to the
// repository's git-ignored var/feed-agreement/ unless --out is given.
//
//   node --env-file-if-exists=.env dashboard/scripts/feed-agreement.mjs --day 2026-11-12 --edition <file>
//   node dashboard/scripts/feed-agreement.mjs --summary
//   node --env-file-if-exists=.env dashboard/scripts/feed-agreement.mjs --save-edition --day 2026-11-12
// (from the repository's root, as the make targets run it: a relative --edition is read from there)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { module } = await runnerImport(join(root, "src/lib/feed-agreement-run.ts"), {
  configFile: false,
  root,
  logLevel: "silent",
  resolve: {
    alias: {
      "@": join(root, "src"),
      // `server-only` throws outside a React server bundle; this runner is a plain Node process.
      "server-only": join(root, "test/server-only-stub.ts"),
    },
  },
});
process.exitCode = await module.main(process.argv.slice(2), module.nodeDeps(join(root, "..", "var", "feed-agreement")));
