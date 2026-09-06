import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lockfile = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);

test("locks the native Astro compiler binding required by GitHub runners", () => {
  const packageName = "@astrojs/compiler-binding-linux-x64-gnu";
  const compilerBinding =
    lockfile.packages["node_modules/@astrojs/compiler-binding"];
  const binding = lockfile.packages[`node_modules/${packageName}`];

  assert.ok(
    binding,
    "Linux x64 GNU compiler binding is missing from package-lock.json",
  );
  assert.equal(
    binding.version,
    compilerBinding.optionalDependencies[packageName],
  );
  assert.equal(binding.optional, true);
  assert.deepEqual(binding.os, ["linux"]);
  assert.deepEqual(binding.cpu, ["x64"]);
  assert.deepEqual(binding.libc, ["glibc"]);
});
