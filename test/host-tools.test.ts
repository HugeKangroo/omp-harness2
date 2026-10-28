import { afterEach, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostTools } from "../src/host-tools.ts";

const temporary: string[] = [];
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "omp-host-tools-"));
  temporary.push(base);
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  return { base, workspace };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("workspace host tools", () => {
  test("read-only by default; solver can create directories and round-trip UTF-8", async () => {
    const { workspace } = await fixture();
    const reader = await createHostTools(workspace);
    expect(reader.definitions.map((tool) => tool.name)).toEqual(["list_files", "read_file"]);
    expect((await reader.execute("write_file", { path: "x", content: "no" })).isError).toBe(true);
    const writer = await createHostTools(workspace, { writable: true });
    expect((await writer.execute("write_file", { path: "src/main.ts", content: "你好\n" })).isError).toBeUndefined();
    expect((await reader.execute("read_file", { path: "src/main.ts" })).content[0]?.text).toBe("你好\n");
    expect((await writer.execute("write_file", { path: "src/main.ts", content: "x" })).isError).toBeUndefined();
    expect(await readFile(path.join(workspace, "src/main.ts"), "utf8")).toBe("x");
  });

  test("rejects absolute/traversal/control/credential paths without touching outside files", async () => {
    const { base, workspace } = await fixture();
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "unchanged");
    const tools = await createHostTools(workspace, { writable: true });
    for (const target of [outside, "../outside.txt", "a/../../outside.txt", "./a", "a//b", "C:\\secrets", "a\\b", "bad\nname", ".git/config", ".omp/config.yml", ".harness2/state", ".harness2-origin.json", "AGENTS.md", ".pi/settings.json", ".gemini/config", "sub/.codex/auth.json", ".env.production", ".aws/credentials", "secret.json", "id_rsa", "tls.pem"]) {
      expect((await tools.execute("write_file", { path: target, content: "bad" })).isError).toBe(true);
      expect((await tools.execute("read_file", { path: target })).isError).toBe(true);
    }
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });

  test("rejects symlink files and symlink parents for reads and writes", async () => {
    const { base, workspace } = await fixture();
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(workspace, "alias"));
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "linked.txt"));
    const tools = await createHostTools(workspace, { writable: true });
    for (const target of ["alias/secret.txt", "linked.txt", "alias/new.txt"]) {
      expect((await tools.execute("read_file", { path: target })).isError).toBe(true);
      expect((await tools.execute("write_file", { path: target, content: "bad" })).isError).toBe(true);
    }
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
    expect((await tools.execute("list_files", { path: "alias" })).isError).toBe(true);
    expect(JSON.parse((await tools.execute("list_files", {})).content[0]!.text).entries).toEqual([]);
  });

  test("rejects hard links, including modification through an otherwise valid relative path", async () => {
    const { base, workspace } = await fixture();
    const outside = path.join(base, "source");
    await writeFile(outside, "unchanged");
    await link(outside, path.join(workspace, "hardlink"));
    const tools = await createHostTools(workspace, { writable: true });
    expect((await tools.execute("read_file", { path: "hardlink" })).isError).toBe(true);
    expect((await tools.execute("write_file", { path: "hardlink", content: "bad" })).isError).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });

  test("pins root identity and rejects replaced roots and parents", async () => {
    const { base, workspace } = await fixture();
    const tools = await createHostTools(workspace, { writable: true });
    await mkdir(path.join(workspace, "src"));
    await rename(path.join(workspace, "src"), path.join(workspace, "old-src"));
    await symlink(base, path.join(workspace, "src"));
    expect((await tools.execute("write_file", { path: "src/escape", content: "bad" })).isError).toBe(true);
    await rename(workspace, path.join(base, "old-workspace"));
    await mkdir(workspace);
    expect((await tools.execute("write_file", { path: "escape", content: "bad" })).isError).toBe(true);
    expect((await tools.execute("list_files", {})).isError).toBe(true);
  });

  test("refuses a symlink workspace root", async () => {
    const { base, workspace } = await fixture();
    const alias = path.join(base, "alias");
    await symlink(workspace, alias);
    await expect(createHostTools(alias)).rejects.toThrow("Workspace root");
  });

  test("paginates large files, bounds writes, and only returns valid UTF-8", async () => {
    const { workspace } = await fixture();
    await writeFile(path.join(workspace, "large"), "x".repeat(5000));
    await writeFile(path.join(workspace, "binary"), Buffer.from([0xff, 0xfe]));
    const tools = await createHostTools(workspace, { writable: true, maxFileBytes: 2048 });
    let offset: number | null = 0;
    let accumulated = "";
    while (offset !== null) {
      const page = await tools.execute("read_file", { path: "large", offset });
      expect(page.isError).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048);
      const metadata = JSON.parse(page.content[1]!.text).pagination;
      expect(metadata.totalBytes).toBe(5000);
      accumulated += page.content[0]!.text;
      offset = metadata.nextOffset;
    }
    expect(accumulated).toBe("x".repeat(5000));
    expect((await tools.execute("read_file", { path: "binary" })).isError).toBe(true);
    expect((await tools.execute("write_file", { path: "new", content: "你".repeat(1000) })).isError).toBe(true);
    await expect(lstat(path.join(workspace, "new"))).rejects.toThrow();
  });

  test("byte pages preserve complete UTF-8 characters and expose continuation metadata", async () => {
    const { workspace } = await fixture();
    await writeFile(path.join(workspace, "unicode"), "ab中🙂z");
    const tools = await createHostTools(workspace);
    for (const [offset, content, nextOffset] of [[0, "ab", 2], [2, "中", 5], [5, "🙂", 9], [9, "z", null]] as const) {
      const page = await tools.execute("read_file", { path: "unicode", offset, length: 4 });
      expect(page.content[0]?.text).toBe(content);
      expect(page.details).toEqual({ offset, bytes: Buffer.byteLength(content), totalBytes: 10, nextOffset, truncated: nextOffset !== null });
      expect(JSON.parse(page.content[1]!.text).pagination).toEqual(page.details);
    }
    expect((await tools.execute("read_file", { path: "unicode", offset: 3 })).isError).toBe(true);
    expect((await tools.execute("read_file", { path: "unicode", offset: 2, length: 2 })).isError).toBe(true);
    expect((await tools.execute("read_file", { path: "unicode", offset: 11 })).isError).toBe(true);
    expect((await tools.execute("read_file", { path: "unicode", offset: 10 })).content[0]?.text).toBe("");
    expect((await tools.execute("read_file", { path: "unicode", offset: -1 })).isError).toBe(true);
    expect((await tools.execute("read_file", { path: "unicode", length: 0 })).isError).toBe(true);
  });

  test("virtual resources are read-only exact matches with the same pagination and no disk materialization", async () => {
    const { workspace } = await fixture();
    const uri = "harness://skills/code%20review";
    const resources = { [uri]: "ab中🙂z" };
    const tools = await createHostTools(workspace, { writable: true, virtualResources: resources });
    resources[uri] = "changed";
    const page = await tools.execute("read_file", { path: uri, offset: 2, length: 4 });
    expect(page.content[0]?.text).toBe("中");
    expect(page.details).toEqual({ offset: 2, bytes: 3, totalBytes: 10, nextOffset: 5, truncated: true });
    expect((await tools.execute("read_file", { path: "harness://skills/code review" })).isError).toBe(true);
    expect((await tools.execute("read_file", { path: "file:///etc/passwd" })).isError).toBe(true);
    expect((await tools.execute("write_file", { path: uri, content: "bad" })).isError).toBe(true);
    expect((await tools.execute("list_files", { path: uri })).isError).toBe(true);
    expect(JSON.parse((await tools.execute("list_files", {})).content[0]!.text).entries).toEqual([]);
  });

  test("reserved evidence remains readable and listable but cannot be overwritten or extended", async () => {
    const { workspace } = await fixture();
    await mkdir(path.join(workspace, ".harness-evidence"));
    await writeFile(path.join(workspace, ".harness-evidence/trace.txt"), "immutable evidence");
    const tools = await createHostTools(workspace, { writable: true });
    expect((await tools.execute("read_file", { path: ".harness-evidence/trace.txt" })).content[0]?.text).toBe("immutable evidence");
    const listed = JSON.parse((await tools.execute("list_files", { path: ".harness-evidence" })).content[0]!.text);
    expect(listed.entries.map((entry: { path: string }) => entry.path)).toEqual([".harness-evidence/trace.txt"]);
    for (const target of [".harness-evidence", ".harness-evidence/trace.txt", ".harness-evidence/new.txt", ".harness-evidence/sub/new.txt", "sub/.harness-evidence/new.txt", ".HARNESS-EVIDENCE/new.txt"]) {
      expect((await tools.execute("write_file", { path: target, content: "bad" })).isError).toBe(true);
    }
    expect(await readFile(path.join(workspace, ".harness-evidence/trace.txt"), "utf8")).toBe("immutable evidence");
    await expect(lstat(path.join(workspace, ".harness-evidence/new.txt"))).rejects.toThrow();
    await expect(lstat(path.join(workspace, "sub"))).rejects.toThrow();
  });

  test("serialized pagination responses stay bounded even with JSON-escaped content", async () => {
    const { workspace } = await fixture();
    const body = "\u0000".repeat(3000);
    const tools = await createHostTools(workspace, { maxFileBytes: 2048, virtualResources: { "harness://evidence/log": body } });
    let offset: number | null = 0;
    let accumulated = "";
    while (offset !== null) {
      const page = await tools.execute("read_file", { path: "harness://evidence/log", offset });
      expect(page.isError).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048);
      accumulated += page.content[0]!.text;
      offset = JSON.parse(page.content[1]!.text).pagination.nextOffset;
    }
    expect(accumulated).toBe(body);
  });

  test("lists recursively with a bounded count, and excludes protected files", async () => {
    const { workspace } = await fixture();
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src/a.ts"), "a");
    await writeFile(path.join(workspace, "src/b.ts"), "b");
    await writeFile(path.join(workspace, ".env"), "secret");
    const tools = await createHostTools(workspace, { maxEntries: 2 });
    const data = JSON.parse((await tools.execute("list_files", { recursive: true })).content[0]!.text);
    expect(data.entries.map((entry: { path: string }) => entry.path)).toEqual(["src", "src/a.ts"]);
    expect(data.truncated).toBe(true);
    expect(data.skipped).toBe(1);
  });

  test("aborted and malformed calls make no writes; errors do not disclose absolute host paths", async () => {
    const { workspace } = await fixture();
    const tools = await createHostTools(workspace, { writable: true });
    const controller = new AbortController();
    controller.abort();
    expect((await tools.execute("write_file", { path: "new", content: "bad" }, controller.signal)).isError).toBe(true);
    expect((await tools.execute("write_file", { path: "new", content: 42 })).isError).toBe(true);
    expect((await tools.execute("read_file", { path: "new", unsafe: true })).isError).toBe(true);
    expect((await tools.execute("bash", { command: "pwd" })).isError).toBe(true);
    const missing = await tools.execute("read_file", { path: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).not.toContain(workspace);
    await expect(lstat(path.join(workspace, "new"))).rejects.toThrow();
  });
});
