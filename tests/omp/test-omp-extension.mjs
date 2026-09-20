import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const adapter = join(root, ".omp/extensions/superpowers.ts");
const marker = "superpowers:using-superpowers bootstrap for omp";

async function fixture(
  t,
  body = "Use the fixture process before implementation.",
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "superpowers-omp-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, ".omp/extensions/superpowers.ts");
  const skill = join(directory, "skills/using-superpowers/SKILL.md");
  await mkdir(dirname(extension), { recursive: true });
  await copyFile(adapter, extension);
  if (body !== null) {
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(skill, `---\r\nname: fixture\r\n---\r\n${body}\r\n`);
  }
  const handlers = new Map();
  const warnings = [];
  const imported = await import(pathToFileURL(extension).href);
  imported.default({
    on(event, handler) {
      handlers.set(event, handler);
    },
    logger: {
      warn(...args) {
        warnings.push(args);
      },
    },
  });
  return { directory, skill, handlers, warnings };
}

async function context(f, messages) {
  const result = await f.handlers.get("context")(
    { type: "context", messages },
    {},
  );
  return result?.messages ?? messages;
}

function text(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

test("bootstrap remains available on later user turns without mutating input", async (t) => {
  const f = await fixture(t);
  const first = [{ role: "user", content: "First task", timestamp: 1 }];
  const before = structuredClone(first);
  const injected = await context(f, first);
  assert.equal(injected.length, 2);
  assert.ok(
    text(injected[0]).includes(
      "Use the fixture process before implementation.",
    ),
  );
  assert.ok(!text(injected[0]).includes("name: fixture"));
  assert.equal(injected[1], first[0]);
  assert.deepEqual(first, before);
  await f.handlers.get("agent_end")?.({}, {});
  await rm(f.skill);
  const second = [{ role: "user", content: "Another task", timestamp: 2 }];
  const repeated = await context(f, second);
  assert.equal(repeated.length, 2);
  assert.equal(
    text(repeated[0]),
    text(injected[0]),
    "successful bootstrap is cached across turns",
  );
  assert.equal(repeated[1], second[0]);
  assert.deepEqual(f.warnings, []);
});

test("resumed or compacted contexts receive bootstrap after all leading summaries", async (t) => {
  const f = await fixture(t);
  const messages = [
    { role: "compactionSummary", summary: "older work" },
    { role: "compactionSummary", summary: "recent work" },
    { role: "user", content: "Continue" },
  ];
  const before = structuredClone(messages);
  const injected = await context(f, messages);
  assert.equal(injected.length, 4);
  assert.equal(injected[0], messages[0]);
  assert.equal(injected[1], messages[1]);
  assert.ok(text(injected[2]).includes(marker));
  assert.equal(injected[3], messages[2]);
  assert.deepEqual(messages, before);
});

test("full injected messages deduplicate, marker-only user questions do not", async (t) => {
  const f = await fixture(t);
  const question = { role: "user", content: `What does ${marker} mean?` };
  const first = await context(f, [question]);
  assert.equal(first.length, 2);
  assert.equal(first[1], question);
  const second = await context(f, first);
  assert.equal(second, first);
  const multipart = { role: "user", content: [{ type: "text", text: marker }] };
  assert.equal((await context(f, [multipart])).length, 2);
});

test("missing bootstrap warns once and leaves the conversation usable", async (t) => {
  const f = await fixture(t, null);
  const messages = [{ role: "user", content: "Explain this code" }];
  assert.equal(await context(f, messages), messages);
  assert.equal(await context(f, messages), messages);
  assert.equal(f.warnings.length, 1);
  const diagnostic = f.warnings[0][1];
  assert.equal(diagnostic.path, f.skill);
  assert.equal(diagnostic.code, "bootstrap-read-failed");
  assert.match(diagnostic.error, /ENOENT/);
});
