import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lockfile = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);

/**
 * A lockfile regenerated with optional dependencies omitted keeps only the
 * bindings for the machine that wrote it, which leaves `npm ci` on a Linux
 * runner with nothing to install for packages that need a native binary.
 * Every linux-x64 binding some package declares must therefore be locked too.
 */
test("locks the native bindings required by GitHub runners", () => {
  const missing = [];
  const mismatched = [];

  for (const [parentPath, parent] of Object.entries(lockfile.packages)) {
    for (const [name, version] of Object.entries(
      parent.optionalDependencies ?? {},
    )) {
      if (!/linux.*x64/.test(name)) continue;
      const locked = lockfile.packages[`node_modules/${name}`];
      if (locked === undefined) {
        missing.push(`${name}@${version} (declared by ${parentPath || "the root package"})`);
      } else if (locked.version !== version) {
        mismatched.push(`${name} locked at ${locked.version}, declared as ${version}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Linux x64 bindings are missing from package-lock.json:\n  ${missing.join("\n  ")}`,
  );
  assert.deepEqual(
    mismatched,
    [],
    `Linux x64 bindings are locked at the wrong version:\n  ${mismatched.join("\n  ")}`,
  );
});

test("locks the specific bindings the CI toolchain loads", () => {
  // The Astro compiler parses components and rolldown backs `astro sync`, so a
  // lockfile without these fails the install and the diagnostics tests alike.
  for (const name of [
    "@astrojs/compiler-binding-linux-x64-gnu",
    "@rolldown/binding-linux-x64-gnu",
  ]) {
    const binding = lockfile.packages[`node_modules/${name}`];
    assert.ok(binding, `${name} is missing from package-lock.json`);
    assert.equal(binding.optional, true);
    assert.deepEqual(binding.os, ["linux"]);
    assert.deepEqual(binding.cpu, ["x64"]);
  }
});
