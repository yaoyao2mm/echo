#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const DEFAULT_PUBLIC_REF = "public/main";
const DEFAULT_PRIVATE_REF = "origin/main";
const DEFAULT_MAX_COMMITS = 30;
const DEFAULT_MAX_FILES = 40;

const REVIEW_RULES = [
  {
    label: "relay/session state",
    test: (file) =>
      file === "src/server.js" ||
      file === "src/lib/codexStore.js" ||
      file === "src/lib/codexQueue.js" ||
      file.includes("session") ||
      file.includes("migration")
  },
  {
    label: "desktop execution boundary",
    test: (file) =>
      file === "src/desktop-agent.js" ||
      file === "src/config.js" ||
      file.includes("codexRunner") ||
      file.includes("codexInteractiveRunner") ||
      file.includes("codexWorktree") ||
      file.includes("codexRuntime") ||
      file.includes("codexCommand") ||
      file.includes("BackendAdapter")
  },
  {
    label: "mobile approval/runtime UX",
    test: (file) =>
      file.startsWith("public/app/") ||
      file.startsWith("public/styles/") ||
      file === "public/index.html" ||
      file === "public/sw.js"
  },
  {
    label: "deployment and local setup",
    test: (file) =>
      file.startsWith(".github/") ||
      file.startsWith("scripts/") ||
      file === ".env.example" ||
      file.includes("desktop-settings")
  },
  {
    label: "tests",
    test: (file) => file.startsWith("test/")
  },
  {
    label: "docs",
    test: (file) => file.startsWith("docs/") || file === "README.md"
  }
];

const SECRET_REVIEW_PATTERN =
  "(token|secret|password|passwd|api[_-]?key|bearer|private|internal|ssh|pem|p12|pfx|ECHO_[A-Z0-9_]+)";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

try {
  run();
} catch (error) {
  console.error(`sync-audit failed: ${error.message}`);
  process.exit(1);
}

function run() {
  assertGitRepo();

  if (options.fetch) {
    fetchRemoteForRef(options.publicRef);
    fetchRemoteForRef(options.privateRef);
  }

  const publicSha = revParse(`${options.publicRef}^{commit}`);
  const privateSha = revParse(`${options.privateRef}^{commit}`);
  const publicTree = revParse(`${options.publicRef}^{tree}`);
  const privateTree = revParse(`${options.privateRef}^{tree}`);
  const mergeBase = maybeGit(["merge-base", options.publicRef, options.privateRef]);
  const symmetricCounts = maybeGit(["rev-list", "--left-right", "--count", `${options.publicRef}...${options.privateRef}`]);
  const diffSummary = summarizeTreeDiff(options.publicRef, options.privateRef);
  const publicCommits = getPublicCommitAbsorption(options.publicRef, options.privateRef, options.maxCommits);
  const reviewGroups = groupReviewFiles(diffSummary.files);
  const secretReviewFiles = getSecretReviewFiles(options.privateRef, diffSummary.files);
  const recentPrivateCommits = getRecentPrivateCommits(options.privateRef, options.publicRef, options.maxCommits);
  const remoteSummary = getRemoteSummary();

  const report = {
    generatedAt: new Date().toISOString(),
    publicRef: options.publicRef,
    privateRef: options.privateRef,
    publicSha,
    privateSha,
    publicTree,
    privateTree,
    histories: {
      commonAncestor: mergeBase || null,
      unrelated: !mergeBase,
      symmetricCounts: parseSymmetricCounts(symmetricCounts)
    },
    remotes: remoteSummary,
    treeDiff: diffSummary,
    publicCommitAbsorption: publicCommits,
    reviewGroups,
    secretReviewFiles,
    recentPrivateCommits
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printMarkdown(report);
}

function parseArgs(args) {
  const parsed = {
    publicRef: DEFAULT_PUBLIC_REF,
    privateRef: DEFAULT_PRIVATE_REF,
    maxCommits: DEFAULT_MAX_COMMITS,
    maxFiles: DEFAULT_MAX_FILES,
    fetch: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--fetch") {
      parsed.fetch = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--public") {
      parsed.publicRef = readValue(args, (index += 1), "--public");
    } else if (arg.startsWith("--public=")) {
      parsed.publicRef = arg.slice("--public=".length);
    } else if (arg === "--private") {
      parsed.privateRef = readValue(args, (index += 1), "--private");
    } else if (arg.startsWith("--private=")) {
      parsed.privateRef = arg.slice("--private=".length);
    } else if (arg === "--max-commits") {
      parsed.maxCommits = parsePositiveInt(readValue(args, (index += 1), "--max-commits"), "--max-commits");
    } else if (arg.startsWith("--max-commits=")) {
      parsed.maxCommits = parsePositiveInt(arg.slice("--max-commits=".length), "--max-commits");
    } else if (arg === "--max-files") {
      parsed.maxFiles = parsePositiveInt(readValue(args, (index += 1), "--max-files"), "--max-files");
    } else if (arg.startsWith("--max-files=")) {
      parsed.maxFiles = parsePositiveInt(arg.slice("--max-files=".length), "--max-files");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function assertGitRepo() {
  git(["rev-parse", "--show-toplevel"], { quiet: true });
}

function fetchRemoteForRef(ref) {
  const remote = ref.includes("/") ? ref.split("/")[0] : "";
  if (!remote || remote === "HEAD") return;
  const remotes = new Set(git(["remote"]).split(/\r?\n/).filter(Boolean));
  if (remotes.has(remote)) {
    git(["fetch", remote, "--prune"], { quiet: true });
  }
}

function summarizeTreeDiff(publicRef, privateRef) {
  const nameStatusOutput = maybeGit(["diff", "--name-status", `${publicRef}..${privateRef}`]) || "";
  const numstatOutput = maybeGit(["diff", "--numstat", `${publicRef}..${privateRef}`]) || "";
  const files = parseNameStatus(nameStatusOutput);
  const numstat = parseNumstat(numstatOutput);
  const totals = files.reduce(
    (acc, file) => {
      acc.statusCounts[file.status] = (acc.statusCounts[file.status] || 0) + 1;
      return acc;
    },
    { files: files.length, additions: 0, deletions: 0, binaryFiles: 0, statusCounts: {} }
  );

  for (const item of numstat) {
    if (item.binary) {
      totals.binaryFiles += 1;
    } else {
      totals.additions += item.additions;
      totals.deletions += item.deletions;
    }
  }

  const areaCounts = new Map();
  for (const file of files) {
    const area = areaForPath(file.path);
    areaCounts.set(area, (areaCounts.get(area) || 0) + 1);
  }

  const topAreas = [...areaCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([area, count]) => ({ area, count }));

  return {
    totals,
    topAreas,
    files
  };
}

function parseNameStatus(output) {
  if (!output.trim()) return [];
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const rawStatus = parts[0];
      const status = rawStatus[0];
      const path = parts.at(-1);
      const oldPath = parts.length > 2 ? parts[1] : null;
      return { status, rawStatus, path, oldPath };
    });
}

function parseNumstat(output) {
  if (!output.trim()) return [];
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, path] = line.split("\t");
      const binary = added === "-" || deleted === "-";
      return {
        path,
        binary,
        additions: binary ? 0 : Number.parseInt(added, 10),
        deletions: binary ? 0 : Number.parseInt(deleted, 10)
      };
    });
}

function getPublicCommitAbsorption(publicRef, privateRef, maxCommits) {
  const output =
    maybeGit(["log", `--max-count=${maxCommits}`, "--reverse", "--format=%H%x00%h%x00%s", publicRef]) || "";
  if (!output.trim()) return [];

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, subject] = line.split("\0");
      const files = getCommitFiles(sha);
      const compared = files.map((file) => compareFileAtRefs(sha, privateRef, file.path));
      const counts = compared.reduce(
        (acc, item) => {
          acc[item.state] = (acc[item.state] || 0) + 1;
          return acc;
        },
        { identical: 0, drifted: 0, missingInPrivate: 0, missingInPublic: 0 }
      );
      return {
        sha,
        shortSha,
        subject,
        filesChanged: files.length,
        counts,
        driftedFiles: compared.filter((item) => item.state !== "identical").map((item) => item.path)
      };
    });
}

function getCommitFiles(commit) {
  const output = maybeGit(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", commit]) || "";
  return parseNameStatus(output).filter((file) => file.path);
}

function compareFileAtRefs(publicCommit, privateRef, file) {
  const publicBlob = maybeGit(["rev-parse", `${publicCommit}:${file}`], { quiet: true });
  const privateBlob = maybeGit(["rev-parse", `${privateRef}:${file}`], { quiet: true });

  if (!publicBlob) {
    return { path: file, state: "missingInPublic" };
  }
  if (!privateBlob) {
    return { path: file, state: "missingInPrivate" };
  }
  return {
    path: file,
    state: publicBlob === privateBlob ? "identical" : "drifted"
  };
}

function groupReviewFiles(files) {
  return REVIEW_RULES.map((rule) => ({
    label: rule.label,
    files: files.filter((file) => rule.test(file.path)).map((file) => file.path)
  })).filter((group) => group.files.length > 0);
}

function getSecretReviewFiles(privateRef, files) {
  if (!files.length) return [];

  const paths = files.map((file) => file.path).filter((file) => fileExistsAtRef(privateRef, file));
  const results = new Set();
  const chunkSize = 80;

  for (let index = 0; index < paths.length; index += chunkSize) {
    const chunk = paths.slice(index, index + chunkSize);
    const output = maybeGit(["grep", "-l", "-I", "-E", SECRET_REVIEW_PATTERN, privateRef, "--", ...chunk], {
      quiet: true,
      maxBuffer: 10 * 1024 * 1024
    });
    if (!output) continue;
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const prefix = `${privateRef}:`;
      results.add(line.startsWith(prefix) ? line.slice(prefix.length) : line);
    }
  }

  return [...results].sort();
}

function fileExistsAtRef(ref, file) {
  try {
    git(["cat-file", "-e", `${ref}:${file}`], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function getRecentPrivateCommits(privateRef, publicRef, maxCommits) {
  const output =
    maybeGit(["log", `--max-count=${maxCommits}`, "--format=%h%x00%s", privateRef, "--not", publicRef]) || "";
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [shortSha, subject] = line.split("\0");
      return { shortSha, subject };
    });
}

function getRemoteSummary() {
  const output = maybeGit(["remote", "-v"]) || "";
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, url, direction] = line.split(/\s+/);
      return {
        name,
        url,
        direction: direction?.replace(/[()]/g, "") || ""
      };
    });
}

function areaForPath(file) {
  if (file.startsWith("src/lib/")) return "src/lib";
  if (file.startsWith("public/app/")) return "public/app";
  if (file.startsWith("public/styles/")) return "public/styles";
  if (file.startsWith("test/e2e/")) return "test/e2e";
  const [first, second] = file.split("/");
  if (!second) return first;
  return `${first}/${second}`;
}

function parseSymmetricCounts(output) {
  if (!output) return null;
  const [publicOnly, privateOnly] = output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  return { publicOnly, privateOnly };
}

function revParse(ref) {
  return git(["rev-parse", "--verify", ref], { quiet: true });
}

function maybeGit(args, options = {}) {
  try {
    return git(args, options);
  } catch {
    return "";
  }
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "pipe" : "pipe"],
    maxBuffer: options.maxBuffer || 50 * 1024 * 1024
  }).trimEnd();
}

function printMarkdown(report) {
  console.log("# Echo Public/Private Sync Audit");
  console.log("");
  console.log(`Generated: ${report.generatedAt}`);
  console.log("");
  console.log("## Refs");
  console.log("");
  console.log(`- Public: \`${report.publicRef}\` @ \`${report.publicSha.slice(0, 12)}\``);
  console.log(`- Private: \`${report.privateRef}\` @ \`${report.privateSha.slice(0, 12)}\``);
  console.log(`- Public tree: \`${report.publicTree.slice(0, 12)}\``);
  console.log(`- Private tree: \`${report.privateTree.slice(0, 12)}\``);
  console.log("");
  console.log("## History Shape");
  console.log("");
  if (report.histories.commonAncestor) {
    console.log(`- Common ancestor: \`${report.histories.commonAncestor.slice(0, 12)}\``);
  } else {
    console.log("- Common ancestor: none. Treat this as unrelated histories and reconcile by audited patches.");
  }
  if (report.histories.symmetricCounts) {
    console.log(
      `- Symmetric commit count: public-only ${report.histories.symmetricCounts.publicOnly}, private-only ${report.histories.symmetricCounts.privateOnly}`
    );
  }
  console.log("");
  console.log("## Tree Difference");
  console.log("");
  const totals = report.treeDiff.totals;
  console.log(
    `- Changed files from public to private: ${totals.files} (${totals.additions} additions, ${totals.deletions} deletions)`
  );
  console.log(`- Status counts: ${formatStatusCounts(totals.statusCounts)}`);
  console.log("");
  console.log("Top changed areas:");
  for (const item of report.treeDiff.topAreas.slice(0, 12)) {
    console.log(`- \`${item.area}\`: ${item.count}`);
  }
  console.log("");
  console.log("## Public Commit Absorption");
  console.log("");
  for (const commit of report.publicCommitAbsorption) {
    console.log(
      `- \`${commit.shortSha}\` ${commit.subject}: ${commit.counts.identical}/${commit.filesChanged} touched files match private current tree`
    );
    const drifted = commit.driftedFiles.slice(0, options.maxFiles);
    if (drifted.length) {
      console.log(`  Drift or missing: ${drifted.map((file) => `\`${file}\``).join(", ")}`);
    }
  }
  console.log("");
  console.log("## Manual Review Groups");
  console.log("");
  for (const group of report.reviewGroups) {
    const files = group.files.slice(0, options.maxFiles);
    console.log(`- ${group.label}: ${group.files.length} file(s)`);
    if (files.length) {
      console.log(`  ${files.map((file) => `\`${file}\``).join(", ")}`);
    }
    if (group.files.length > files.length) {
      console.log(`  ...and ${group.files.length - files.length} more`);
    }
  }
  console.log("");
  console.log("## Secret Review Candidates");
  console.log("");
  if (report.secretReviewFiles.length) {
    console.log("These changed files contain secret-shaped or policy-shaped words. Inspect values before any public PR:");
    for (const file of report.secretReviewFiles.slice(0, options.maxFiles)) {
      console.log(`- \`${file}\``);
    }
    if (report.secretReviewFiles.length > options.maxFiles) {
      console.log(`- ...and ${report.secretReviewFiles.length - options.maxFiles} more`);
    }
  } else {
    console.log("- No changed files matched the secret review pattern.");
  }
  console.log("");
  console.log("## Recent Private Commit Queue");
  console.log("");
  for (const commit of report.recentPrivateCommits) {
    console.log(`- \`${commit.shortSha}\` ${commit.subject}`);
  }
  console.log("");
  console.log("## Suggested Next Commands");
  console.log("");
  console.log("```bash");
  console.log("pnpm run sync:audit -- --fetch");
  console.log("git diff --name-status public/main..origin/main");
  console.log("git show --stat <candidate-private-commit>");
  console.log("git switch -c upstream/<topic> public/main");
  console.log("git cherry-pick -n <candidate-private-commit>");
  console.log("```");
}

function formatStatusCounts(statusCounts) {
  const entries = Object.entries(statusCounts).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "none";
  return entries.map(([status, count]) => `${status}=${count}`).join(", ");
}

function printHelp() {
  console.log(`Usage: node scripts/sync-audit.js [options]

Options:
  --public <ref>        Public upstream ref to inspect (default: ${DEFAULT_PUBLIC_REF})
  --private <ref>       Private downstream ref to inspect (default: ${DEFAULT_PRIVATE_REF})
  --fetch               Fetch remotes inferred from the refs before auditing
  --json                Print machine-readable JSON instead of Markdown
  --max-commits <n>     Limit public/private commit lists (default: ${DEFAULT_MAX_COMMITS})
  --max-files <n>       Limit long file lists in Markdown output (default: ${DEFAULT_MAX_FILES})
  -h, --help            Show this help
`);
}
