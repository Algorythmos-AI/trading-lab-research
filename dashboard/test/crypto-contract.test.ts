// The crypto desk's contract belongs to another repository (ADR 0005, addendum). Its schema and its fixture are
// copies of that repository's contracts/ files at a tagged commit, pinned here by their SHA-256. Nothing in this
// repository generates them any more, so a hand edit of either copy fails here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import lock from "@/lib/crypto.contract.lock.json";
import cryptoSchema from "@/lib/crypto.schema.json";
import { CRYPTO_SCHEMA, validateCryptoSnapshot } from "@/lib/validate";
import cryptoFixture from "./fixtures/crypto.v1.json";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex");

describe("the vendored crypto contract's lock", () => {
  it("pins the schema and the fixture as committed, byte for byte", () => {
    expect(lock.schema.sha256).toBe(sha256(lock.schema.path));
    expect(lock.fixture.sha256).toBe(sha256(lock.fixture.path));
  });

  it("says where both files come from", () => {
    expect(Object.keys(lock)).toEqual(["source_repo", "source_tag", "source_commit", "schema", "fixture"]);
    expect(lock.source_repo).toBe("Algorythmos-AI/crypto-lab");
    expect(lock.source_commit).toMatch(/^[0-9a-f]{40}$/);
    // a contract is tagged by what it is: the first 12 hex digits of the schema's sha256
    expect(lock.source_tag).toBe(`contract-${lock.schema.sha256.slice(0, 12)}`);
    expect(lock.schema).toEqual({ source_path: "contracts/crypto.schema.json", path: "src/lib/crypto.schema.json", sha256: lock.schema.sha256 });
    expect(lock.fixture).toEqual({ source_path: "contracts/crypto.v1.json", path: "test/fixtures/crypto.v1.json", sha256: lock.fixture.sha256 });
  });

  it("is the contract ingest files by, and the fixture is a snapshot of it", () => {
    expect(cryptoSchema.$id).toBe(CRYPTO_SCHEMA);
    expect((cryptoFixture as Record<string, unknown>).schema).toBe(CRYPTO_SCHEMA);
    expect(validateCryptoSnapshot(cryptoFixture).ok).toBe(true);
  });
});
