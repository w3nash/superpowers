import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextEvent, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for omp";
const bootstrapPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../skills/using-superpowers/SKILL.md",
);

export default function superpowersOmpExtension(omp: ExtensionAPI) {
  let bootstrap: string | null | undefined;

  omp.on("context", async (event: ContextEvent) => {
    if (bootstrap === undefined) {
      try {
        const body = readFileSync(bootstrapPath, "utf8")
          .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
          .trim();
        bootstrap = `<EXTREMELY_IMPORTANT>
${BOOTSTRAP_MARKER}

The using-superpowers skill below is already loaded for this OMP session. Follow it without loading it again.

${body}

## OMP tool mapping

Read applicable skills with \`read\` at \`skill://<name>\`. Humans may explicitly invoke \`/skill:<name>\`.
Use OMP's lowercase \`read\`, \`write\`, \`edit\`, \`bash\`, \`grep\`, and \`glob\` tools for file, shell, and search actions.
Use built-in \`task\` for subagents and \`todo\` for checklist tracking. These capabilities are available in OMP; do not substitute Pi's optional companion packages or invent capitalized Skill, Task, or TodoWrite tools.
</EXTREMELY_IMPORTANT>`;
      } catch (error) {
        bootstrap = null;
        omp.logger.warn("Superpowers bootstrap unavailable", {
          code: "bootstrap-read-failed",
          path: bootstrapPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (bootstrap === null) return;

    // Context transforms are per request; later turns need the bootstrap too.
    const content = bootstrap;
    if (
      event.messages.some((message) => {
        if (message.role !== "user") return false;
        if (typeof message.content === "string")
          return message.content === content;
        return (
          Array.isArray(message.content) &&
          message.content.some(
            (part) => part.type === "text" && part.text === content,
          )
        );
      })
    )
      return;

    let insertAt = 0;
    while (event.messages[insertAt]?.role === "compactionSummary")
      insertAt += 1;
    return {
      messages: [
        ...event.messages.slice(0, insertAt),
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: content }],
          timestamp: Date.now(),
        },
        ...event.messages.slice(insertAt),
      ],
    };
  });
}
