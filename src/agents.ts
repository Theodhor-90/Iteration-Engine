import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentId, type ClaudeAgentId, type AgentCallOptions, CONFIG, DRY_RUN } from "./config.js";
import { parseDecision, type Decision } from "./schemas.js";
import { log } from "./logger.js";

// ── Path Resolution ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENGINE_ROOT = join(__dirname, "..");
const SCHEMAS_DIR = join(ENGINE_ROOT, "schemas");
const TMP_DIR = join(ENGINE_ROOT, ".pipeline", "tmp");

// ── Types ────────────────────────────────────────────────────

export interface CliResult {
  raw: string;
  decision?: Decision;
}

// ── Structured Output (non-decision JSON) ───────────────────

export function callAgentStructured<T>(
  agentId: AgentId,
  prompt: string,
  options: AgentCallOptions & { schema: string },
): T {
  if (DRY_RUN) {
    log("", "cli", `[DRY-RUN] structured call skipped (schema: ${options.schema})`);
    return { items: [] } as unknown as T;
  }

  if (agentId !== "opus" && agentId !== "sonnet") {
    throw new Error("callAgentStructured only supports Claude agents (opus, sonnet)");
  }

  const claudeId = agentId as ClaudeAgentId;
  const agentCfg = CONFIG.agents[claudeId];
  const { tools = [], maxTurns = agentCfg.defaultMaxTurns, schema } = options;
  const schemaContent = readFileSync(join(SCHEMAS_DIR, schema), "utf-8");

  const args: string[] = [
    "-p",
    prompt,
    "--model",
    agentCfg.model,
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    "--json-schema",
    schemaContent,
  ];

  if (tools.length) {
    args.push("--allowedTools", tools.join(","));
  }

  log(
    "",
    "cli",
    `claude -p structured [${claudeId}] (tools: ${tools.join(",") || "none"}, schema: ${schema})`,
  );

  const res = spawnSyncGroup(agentCfg.bin, args, {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: CONFIG.timeoutMs,
    env: cleanEnv(),
  });

  if (res.error) {
    throw new Error(`claude failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = res.stderr?.slice(0, 500) || "";
    throw new Error(`claude exited with code ${res.status}: ${stderr}`);
  }

  const stdout = (res.stdout || "").trim();
  return parseStructuredOutput<T>(stdout);
}

function parseStructuredOutput<T>(stdout: string): T {
  // Strategy 1: Parse as Claude JSON envelope
  try {
    const envelope = JSON.parse(stdout);

    // Claude wraps output in { result, structured_output }
    if (envelope.structured_output != null) {
      return typeof envelope.structured_output === "string"
        ? JSON.parse(envelope.structured_output)
        : envelope.structured_output;
    }

    // Try result field as JSON
    if (typeof envelope.result === "string") {
      try {
        return JSON.parse(envelope.result);
      } catch {
        // result is not JSON — fall through
      }
    }

    // The envelope itself might be the data
    if (envelope.items !== undefined) {
      return envelope as T;
    }
  } catch {
    // Not valid JSON envelope — fall through
  }

  // Strategy 2: Extract JSON block from text
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(stdout.substring(firstBrace, lastBrace + 1));
    } catch {
      // Extraction failed — fall through
    }
  }

  throw new Error("Failed to parse structured output from agent");
}

// ── Mock State (for --dry-run) ───────────────────────────────

let mockDecisions: Decision[] = [];
let mockDecisionIndex = 0;

export function setMockDecisions(decisions: Decision[]): void {
  mockDecisions = decisions;
  mockDecisionIndex = 0;
}

function nextMockDecision(): Decision {
  if (mockDecisionIndex < mockDecisions.length) {
    return mockDecisions[mockDecisionIndex++];
  }
  return { verdict: "approved", feedback: "" };
}

// ── Environment Helper ───────────────────────────────────────

function cleanEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  return env;
}

// ── Process-Group-Aware Spawn ────────────────────────────────

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function spawnSyncGroup(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    maxBuffer?: number;
    timeout?: number;
    env?: Record<string, string | undefined>;
  },
): SpawnSyncReturns<string> {
  const escaped = [command, ...args].map(shellEscape).join(" ");
  const script = [
    "set -m",
    `${escaped} &`,
    "CHILD=$!",
    "trap 'kill -- -\"$CHILD\" 2>/dev/null; wait \"$CHILD\" 2>/dev/null; exit 143' TERM",
    "trap 'kill -INT -- -\"$CHILD\" 2>/dev/null; wait \"$CHILD\" 2>/dev/null; exit 130' INT",
    "wait \"$CHILD\"",
    "exit $?",
  ].join("\n");

  return spawnSync("/bin/sh", ["-c", script], {
    cwd: options.cwd,
    encoding: "utf-8",
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    env: options.env as NodeJS.ProcessEnv,
  });
}

// ── Unified Agent Dispatch ───────────────────────────────────

export function callAgent(
  agentId: AgentId,
  prompt: string,
  options: AgentCallOptions = {},
): CliResult {
  if (agentId === "opus" || agentId === "sonnet") {
    return callClaude(agentId, prompt, options);
  }
  return callCodex(prompt, options);
}

// ── Claude Wrapper ───────────────────────────────────────────

function callClaude(claudeId: ClaudeAgentId, prompt: string, options: AgentCallOptions): CliResult {
  if (DRY_RUN) {
    return mockCliCall(`claude:${claudeId}`, prompt, !!options.schema);
  }

  const agentCfg = CONFIG.agents[claudeId];
  const { tools = [], maxTurns = agentCfg.defaultMaxTurns, schema } = options;
  const isDecision = !!schema;

  const args: string[] = [
    "-p",
    prompt,
    "--model",
    agentCfg.model,
    "--output-format",
    isDecision ? "json" : "text",
    "--max-turns",
    String(maxTurns),
  ];

  if (tools.length) {
    args.push("--allowedTools", tools.join(","));
  }

  if (schema) {
    const schemaContent = readFileSync(join(SCHEMAS_DIR, schema), "utf-8");
    args.push("--json-schema", schemaContent);
  }

  log(
    "",
    "cli",
    `claude -p [${claudeId}] (tools: ${tools.join(",") || "none"}, max-turns: ${maxTurns}, schema: ${schema || "none"})`,
  );

  const res = spawnSyncGroup(agentCfg.bin, args, {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: CONFIG.timeoutMs,
    env: cleanEnv(),
  });

  if (res.error) {
    throw new Error(`claude failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = res.stderr?.slice(0, 500) || "";
    throw new Error(`claude exited with code ${res.status}: ${stderr}`);
  }

  const stdout = (res.stdout || "").trim();

  if (!isDecision) {
    return { raw: stdout };
  }

  return parseClaudeDecision(stdout, schema!);
}

function parseClaudeDecision(stdout: string, schema: string): CliResult {
  try {
    const envelope = JSON.parse(stdout);
    const result = typeof envelope.result === "string" ? envelope.result : "";

    if (envelope.structured_output != null) {
      const structured =
        typeof envelope.structured_output === "string"
          ? envelope.structured_output
          : JSON.stringify(envelope.structured_output);
      const decision = parseDecision(structured, schema);
      return { raw: result || structured, decision };
    }

    const raw = result || stdout;
    const decision = parseDecision(raw, schema);
    return { raw, decision };
  } catch {
    log("", "cli", "Claude JSON envelope parse failed, falling back to raw text");
    const decision = parseDecision(stdout, schema);
    return { raw: stdout, decision };
  }
}

// ── Codex Wrapper ────────────────────────────────────────────

function callCodex(prompt: string, options: AgentCallOptions): CliResult {
  if (DRY_RUN) {
    return mockCliCall("codex", prompt, !!options.schema);
  }

  const { sandbox = CONFIG.agents.codex.defaultSandbox, schema } = options;
  const isDecision = !!schema;

  const args: string[] = ["exec", prompt, "--sandbox", sandbox];

  let outputFile: string | null = null;

  if (schema) {
    const schemaPath = join(SCHEMAS_DIR, schema);
    args.push("--output-schema", schemaPath);

    mkdirSync(TMP_DIR, { recursive: true });
    outputFile = join(TMP_DIR, `codex-output-${Date.now()}.json`);
    args.push("-o", outputFile);
  }

  log("", "cli", `codex exec (sandbox: ${sandbox}, schema: ${schema || "none"})`);

  const res = spawnSyncGroup(CONFIG.agents.codex.bin, args, {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: CONFIG.timeoutMs,
    env: cleanEnv(),
  });

  if (res.error) {
    throw new Error(`codex failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = res.stderr?.slice(0, 500) || "";
    throw new Error(`codex exited with code ${res.status}: ${stderr}`);
  }

  const stdout = (res.stdout || "").trim();

  if (!isDecision) {
    return { raw: stdout };
  }

  return parseCodexDecision(outputFile!, stdout, schema!);
}

function parseCodexDecision(outputFile: string, stdout: string, schema: string): CliResult {
  let raw: string;
  try {
    raw = readFileSync(outputFile, "utf-8").trim();
  } catch {
    log("", "cli", "Codex output file not found, falling back to stdout");
    raw = stdout;
  }

  try {
    unlinkSync(outputFile);
  } catch {
    // Ignore cleanup failure
  }

  const decision = parseDecision(raw, schema);
  return { raw, decision };
}

// ── Mock CLI Call (dry-run) ──────────────────────────────────

function mockCliCall(cli: string, prompt: string, isDecision: boolean): CliResult {
  const preview = prompt.length > 80 ? prompt.substring(0, 80) + "..." : prompt;
  log("", "cli", `[DRY-RUN] ${cli}: ${preview}`);

  if (isDecision) {
    const decision = nextMockDecision();
    return { raw: JSON.stringify(decision), decision };
  }

  return { raw: `Mock ${cli} response for dry-run testing.` };
}

// ── Prerequisite Check ───────────────────────────────────────

export function checkPrereqs(): void {
  console.log("\nChecking prerequisites...\n");
  const problems: string[] = [];

  for (const [label, bin, pkg] of [
    ["Claude Code", CONFIG.agents.opus.bin, "@anthropic-ai/claude-code"],
    ["Codex CLI", CONFIG.agents.codex.bin, "@openai/codex"],
    ["GitHub CLI", "gh", "https://cli.github.com"],
  ] as const) {
    const r = spawnSync("which", [bin], { encoding: "utf-8" });
    if (r.status === 0) {
      console.log(`  OK  ${label} → ${r.stdout.trim()}`);
    } else {
      console.log(`  MISSING  ${label} — install with: npm install -g ${pkg}`);
      problems.push(label);
    }
  }

  for (const [label, bin, loginCmd] of [
    ["Claude auth", CONFIG.agents.opus.bin, "claude login"],
    ["Codex auth", CONFIG.agents.codex.bin, "codex login"],
  ] as const) {
    const hasApiKey =
      (bin === "claude" && process.env.ANTHROPIC_API_KEY) ||
      (bin === "codex" && (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY));
    if (hasApiKey) {
      console.log(`  OK  ${label} (API key)`);
    } else {
      console.log(
        `  ?   ${label} — no API key found; assuming subscription login via "${loginCmd}"`,
      );
    }
  }

  if (problems.length) {
    console.log(`\nBlocked by ${problems.length} missing prerequisite(s). Fix and retry.\n`);
    process.exit(1);
  }
  console.log("\nAll prerequisites met.\n");
}
