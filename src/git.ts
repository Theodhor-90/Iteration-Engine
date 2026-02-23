import { spawnSync } from "node:child_process";
import { log } from "./logger.js";
import { CONFIG, DRY_RUN } from "./config.js";

// ── Template Interpolation ──────────────────────────────────

function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// ── Git Helpers ──────────────────────────────────────────────

function git(args: string[], description: string): string {
  if (DRY_RUN) {
    log("", "git", `[DRY-RUN] git ${args.join(" ")}`);
    return "";
  }

  log("", "git", description);
  const res = spawnSync("git", args, {
    encoding: "utf-8",
    timeout: 30_000,
  });

  if (res.error) {
    throw new Error(`git ${args[0]} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || "").trim();
    throw new Error(`git ${args[0]} exited with code ${res.status}: ${stderr}`);
  }

  return (res.stdout || "").trim();
}

// ── Branch Management ────────────────────────────────────────

export function createPhaseBranch(milestoneId: string, phaseId: string): void {
  const branchName = phaseBranchName(milestoneId, phaseId);

  if (DRY_RUN) {
    log("", "git", `[DRY-RUN] Would create/checkout branch ${branchName}`);
    return;
  }

  const existing = spawnSync("git", ["rev-parse", "--verify", branchName], {
    encoding: "utf-8",
  });

  if (existing.status === 0) {
    git(["checkout", branchName], `Switching to existing branch ${branchName}`);
  } else {
    git(["checkout", "-b", branchName, "main"], `Creating branch ${branchName} from main`);
  }
}

// ── Task Commits ─────────────────────────────────────────────

export function commitTaskCompletion(
  milestoneId: string,
  phaseId: string,
  taskId: string,
): void {
  if (!CONFIG.git.autoCommit) return;

  if (DRY_RUN) {
    log("", "git", `[DRY-RUN] Would commit task ${milestoneId}/${phaseId}/${taskId}`);
    return;
  }

  const status = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf-8",
  });
  const changes = (status.stdout || "").trim();

  if (!changes) {
    log("", "git", `No changes to commit for task ${taskId}`);
    return;
  }

  const vars = { milestoneId, phaseId, taskId };
  const message = interpolate(CONFIG.git.commitMessage, vars) +
    "\n\nAutomated commit by pipeline after task approval.";

  git(["add", "-A"], `Staging all changes for task ${taskId}`);
  git(
    ["commit", "-m", message],
    `Committing task ${milestoneId}/${phaseId}/${taskId}`,
  );
}

// ── Phase PRs ────────────────────────────────────────────────

export function createPhasePR(milestoneId: string, phaseId: string): void {
  if (!CONFIG.git.autoPR) return;

  const branchName = phaseBranchName(milestoneId, phaseId);

  if (DRY_RUN) {
    log("", "git", `[DRY-RUN] Would push ${branchName} and create PR`);
    return;
  }

  git(["push", "-u", "origin", branchName], `Pushing ${branchName} to origin`);

  const vars = { milestoneId, phaseId };
  const title = interpolate(CONFIG.git.prTitle, vars);
  const body = interpolate(CONFIG.git.prBody, vars);

  log("", "git", `Creating PR for ${branchName}`);
  const res = spawnSync(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--base", "main"],
    {
      encoding: "utf-8",
      timeout: 30_000,
    },
  );

  if (res.error) {
    throw new Error(`gh pr create failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || "").trim();
    if (stderr.includes("already exists")) {
      log("", "git", "PR already exists, skipping creation");
      return;
    }
    throw new Error(`gh pr create exited with code ${res.status}: ${stderr}`);
  }

  const prUrl = (res.stdout || "").trim();
  log("", "git", `PR created: ${prUrl}`);
  console.log(`\n  PR created: ${prUrl}\n`);
}

export function returnToMain(): void {
  git(["checkout", "main"], "Switching back to main");
}

// ── Helpers ──────────────────────────────────────────────────

function phaseBranchName(milestoneId: string, phaseId: string): string {
  return `${CONFIG.git.branchPrefix}${milestoneId}-${phaseId}`;
}
