/**
 * `tauri build` refuses to run when a Tauri crate and its npm package differ in major or
 * minor version (e.g. tauri-plugin-notification 2.4 against @tauri-apps/plugin-notification
 * 2.5), but `tauri dev` and the CI compile don't check. This does, from the two lock files,
 * so a mismatch fails a pull request instead of a release build.
 *
 *   node scripts/check-tauri-versions.mjs      (run from frontend/)
 */
import fs from "node:fs";

const cargo = fs.readFileSync("src-tauri/Cargo.lock", "utf8").split("\r\n").join("\n");
const npm = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages;

const crates = {};
for (const m of cargo.matchAll(/name = "(tauri(?:-plugin-[a-z-]+)?)"\nversion = "([^"]+)"/g)) crates[m[1]] = m[2];

const pairs = { tauri: "@tauri-apps/api" };
for (const c of Object.keys(crates)) if (c.startsWith("tauri-plugin-")) pairs[c] = `@tauri-apps/plugin-${c.slice("tauri-plugin-".length)}`;

const minor = v => v.split(".").slice(0, 2).join(".");
let bad = 0;
for (const [crate, pkg] of Object.entries(pairs)) {
  const js = npm[`node_modules/${pkg}`]?.version;
  if (!js || !crates[crate]) continue;
  const ok = minor(crates[crate]) === minor(js);
  if (!ok) bad++;
  console.log(`${ok ? "ok      " : "MISMATCH"} ${crate} ${crates[crate]} / ${pkg} ${js}`);
}
if (bad) {
  console.error(`\n${bad} Tauri package(s) differ between Cargo.lock and package-lock.json; tauri build will refuse. Pin the npm package to the crate's version (or update the crate).`);
  process.exit(1);
}
