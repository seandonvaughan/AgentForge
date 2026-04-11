import { describe, it, expect } from "vitest";
import { helloWorld } from "../../src/utils/hello.js";

describe("Hello World", () => {
  it("returns Hello, World! greeting", () => {
    const result = helloWorld();
    expect(result).toBe("Hello, World!");
  });
});