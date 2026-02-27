import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Agent Identifiers ────────────────────────────────────────

export type AgentId = "opus" | "sonnet" | "codex";
export type ClaudeAgentId = "opus" | "sonnet";

// ── Per-Level Agent Roles ────────────────────────────────────

export interface LevelAgentConfig {
  creator: AgentId;
  challenger: AgentId;
  tiebreaker: AgentId;
}

// ── Per-Level Configuration ──────────────────────────────────

export interface AgentCallOptions {
  tools?: string[];
  sandbox?: "read-only" | "workspace-write";
  maxTurns?: number;
  schema?: string;
}

export interface LevelConfig {
  agents: LevelAgentConfig;
  maxIterations: number;
  templates: {
    draft: string;
    challenge: string;
    refine: string;
    tiebreak: string;
  };
  creatorOptions: AgentCallOptions;
  challengerOptions: AgentCallOptions & { schema: string };
  tiebreakerOptions: AgentCallOptions;
}

// ── Agent Binary Configuration ───────────────────────────────

export interface ClaudeAgentBinaryConfig {
  bin: string;
  model: string;
  defaultMaxTurns: number;
}

export interface AgentBinaryConfig {
  opus: ClaudeAgentBinaryConfig;
  sonnet: ClaudeAgentBinaryConfig;
  codex: {
    bin: string;
    defaultSandbox: "read-only" | "workspace-write";
  };
}

// ── Scaffold Configuration ───────────────────────────────────

export interface ScaffoldConfig {
  agent: AgentId;
  options: AgentCallOptions & { schema: string };
  templates: {
    milestones: string;
    phases: string;
    tasks: string;
  };
}

// ── Git Configuration ────────────────────────────────────────

export interface GitConfig {
  enabled: boolean;
  branchPrefix: string;
  autoCommit: boolean;
  autoPR: boolean;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

// ── Full Pipeline Configuration ──────────────────────────────

export interface PipelineConfig {
  project: string;
  masterPlanFile: string;
  pipelineDir: string;
  timeoutMs: number;
  agents: AgentBinaryConfig;
  levels: {
    milestone: LevelConfig;
    phase: LevelConfig;
    task: LevelConfig;
    implementation: LevelConfig;
  };
  scaffold: ScaffoldConfig;
  git: GitConfig;
}

// ── Default Configuration ────────────────────────────────────

const readOnlyTools = ["Read", "Glob", "Grep"];
const implementationTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
const reviewTools = ["Read", "Glob", "Grep", "Bash"];

const DEFAULTS: PipelineConfig = {
  project: "my-project",
  masterPlanFile: "MASTER_PLAN.md",
  pipelineDir: ".pipeline",
  timeoutMs: 20 * 60_000,

  agents: {
    opus: { bin: "claude", model: "opus", defaultMaxTurns: 25 },
    sonnet: { bin: "claude", model: "sonnet", defaultMaxTurns: 25 },
    codex: { bin: "codex", defaultSandbox: "read-only" },
  },

  levels: {
    milestone: {
      agents: { creator: "opus", challenger: "opus", tiebreaker: "opus" },
      maxIterations: 2,
      templates: {
        draft: "milestone/draft",
        challenge: "milestone/challenge",
        refine: "milestone/refine",
        tiebreak: "milestone/tiebreak",
      },
      creatorOptions: { tools: readOnlyTools },
      challengerOptions: { tools: readOnlyTools, schema: "challenge-decision.json" },
      tiebreakerOptions: { tools: readOnlyTools },
    },

    phase: {
      agents: { creator: "opus", challenger: "opus", tiebreaker: "opus" },
      maxIterations: 2,
      templates: {
        draft: "phase/draft",
        challenge: "phase/challenge",
        refine: "phase/refine",
        tiebreak: "phase/tiebreak",
      },
      creatorOptions: { tools: readOnlyTools },
      challengerOptions: { tools: readOnlyTools, schema: "challenge-decision.json" },
      tiebreakerOptions: { tools: readOnlyTools },
    },

    task: {
      agents: { creator: "opus", challenger: "opus", tiebreaker: "opus" },
      maxIterations: 2,
      templates: {
        draft: "task/draft",
        challenge: "task/challenge",
        refine: "task/refine",
        tiebreak: "task/tiebreak",
      },
      creatorOptions: { tools: readOnlyTools },
      challengerOptions: { tools: readOnlyTools, schema: "challenge-decision.json" },
      tiebreakerOptions: { tools: readOnlyTools },
    },

    implementation: {
      agents: { creator: "sonnet", challenger: "sonnet", tiebreaker: "opus" },
      maxIterations: 2,
      templates: {
        draft: "impl/implement",
        challenge: "impl/review",
        refine: "impl/implement-fix",
        tiebreak: "impl/tiebreak",
      },
      creatorOptions: { tools: implementationTools, sandbox: "workspace-write", maxTurns: 40 },
      challengerOptions: { tools: reviewTools, sandbox: "workspace-write", schema: "review-decision.json" },
      tiebreakerOptions: { tools: implementationTools, sandbox: "workspace-write", maxTurns: 40 },
    },
  },

  scaffold: {
    agent: "opus",
    options: { tools: readOnlyTools, schema: "scaffold.json" },
    templates: {
      milestones: "scaffold/milestones",
      phases: "scaffold/phases",
      tasks: "scaffold/tasks",
    },
  },

  git: {
    enabled: true,
    branchPrefix: "phase/",
    autoCommit: true,
    autoPR: true,
    commitMessage: "{milestoneId}/{phaseId}/{taskId}: task completed",
    prTitle: "{milestoneId}/{phaseId}: phase completed",
    prBody:
      "## Phase {phaseId} (Milestone {milestoneId})\n\n" +
      "All tasks in this phase have been completed by the AI pipeline.\n\n" +
      "### Review checklist\n" +
      "- [ ] Code review\n" +
      "- [ ] Tests passing\n" +
      "- [ ] Merge to main\n",
  },
};

// ── Deep Merge ───────────────────────────────────────────────

function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (result as Record<string, unknown>)[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }
  return result;
}

// ── Config Resolution ────────────────────────────────────────

let CONFIG: PipelineConfig = { ...DEFAULTS };

export function resolveConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  let fileConfig: Record<string, unknown> = {};

  const configPath = join(process.cwd(), "pipeline.config.json");
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`Warning: Could not parse ${configPath}, using defaults.`);
    }
  }

  CONFIG = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig) as unknown as PipelineConfig;
  if (overrides) {
    CONFIG = deepMerge(CONFIG as unknown as Record<string, unknown>, overrides as unknown as Record<string, unknown>) as unknown as PipelineConfig;
  }
  return CONFIG;
}

export { CONFIG };

// ── Dry-run Mode ─────────────────────────────────────────────

export let DRY_RUN = false;

export function setDryRun(value: boolean): void {
  DRY_RUN = value;
}
