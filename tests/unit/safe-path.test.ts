import { describe, it, expect } from "vitest";
import { safePath, safeComponent } from "../../lib/utils/safe-path.js";

describe("safePath", () => {
  it("allows valid subpath", () => {
    const result = safePath("/base/dir", "subdir", "file.txt");
    expect(result).toBe("/base/dir/subdir/file.txt");
  });

  it("throws on path traversal via ../", () => {
    expect(() => safePath("/base/dir", "../../etc/passwd")).toThrow(/Path traversal/);
  });

  it("throws on absolute path escape", () => {
    expect(() => safePath("/base/dir", "/etc/passwd")).toThrow(/Path traversal/);
  });

  it("allows path equal to base", () => {
    const result = safePath("/base/dir");
    expect(result).toBe("/base/dir");
  });
});

describe("safeComponent", () => {
  it("allows valid component", () => {
    expect(safeComponent("valid-name-123")).toBe("valid-name-123");
  });

  it("throws on forward slash", () => {
    expect(() => safeComponent("a/b")).toThrow(/Unsafe path component/);
  });

  it("throws on backslash", () => {
    expect(() => safeComponent("a\\b")).toThrow(/Unsafe path component/);
  });

  it("throws on ..", () => {
    expect(() => safeComponent("..")).toThrow(/Unsafe path component/);
  });

  it("throws on null byte", () => {
    expect(() => safeComponent("a\0b")).toThrow(/Unsafe path component/);
  });

  it("allows UUID format", () => {
    expect(safeComponent("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
