import { describe, expect, it } from "vitest";

import { chunkContent } from "../src/tools/projects/ingest.js";

describe("hardening regression coverage", () => {
  it("always advances when overlap is greater than or equal to chunk size", () => {
    const chunks = chunkContent(
      ["abcdefghij"],
      "source-1",
      { strategy: "recursive", max_chars: 4, overlap_chars: 4 },
      0
    );

    expect(chunks).toHaveLength(7);
    expect(chunks.at(-1)?.position.end_char).toBe(10);
  });

  it("clamps invalid chunk sizes to a terminating one-character stride", () => {
    const chunks = chunkContent(
      ["abc"],
      "source-1",
      { strategy: "recursive", max_chars: 0, overlap_chars: 0 },
      0
    );

    expect(chunks).toHaveLength(3);
    expect(chunks.map(chunk => chunk.text)).toEqual(["a", "b", "c"]);
  });
});
