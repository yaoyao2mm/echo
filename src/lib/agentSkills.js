import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const managedFolderPrefix = ".echo-managed-";
const importedFolderSuffixLength = 8;
const execFileAsync = promisify(execFile);
const providerLabels = {
  codex: "Codex",
  "claude-code": "Claude Code"
};

export function listInstalledAgentSkills(options = {}) {
  return agentSkillRegistry(options).installedSkills;
}

export function agentSkillRegistry(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : defaultSkillRootSpecs();
  const state = normalizeState(options.state || readAgentSkillState(options));
  const includePaths = options.includePaths === true;
  const byName = new Map();
  for (const rootSpec of roots) {
    for (const skill of listSkillsFromRoot(rootSpec, { includePaths: true })) {
      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, skill);
        continue;
      }
      existing.providers = mergeProviders(existing.providers, skill.providers);
      existing.sourceEntries = [...(existing.sourceEntries || []), ...(skill.sourceEntries || [])];
      existing.paths = mergePaths(existing.paths, skill.paths);
      if (!existing.description && skill.description) existing.description = skill.description;
      if (!existing.folder && skill.folder) existing.folder = skill.folder;
    }
  }

  const discovered = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  const managed = discovered.map((skill) => managedSkillFromDiscovered(skill, state.skills?.[skill.id], roots, { includePaths }));
  return {
    version: 1,
    capability: {
      canManage: true,
      commandTypes: ["agent-skill.list", "agent-skill.update", "agent-skill.sync", "agent-skill.import"],
      providers: targetProviderSummaries(roots)
    },
    skills: managed,
    installedSkills: managed
      .filter((skill) => skill.enabled)
      .map((skill) => publicInstalledSkill(skill, { includePaths })),
    summary: summarizeManagedSkills(managed)
  };
}

export function updateAgentSkillState(input = {}, options = {}) {
  const registry = agentSkillRegistry(options);
  const skillId = normalizeSkillId(input.skillId);
  const skill = registry.skills.find((item) => item.id === skillId);
  if (!skill) return skillError("Unknown agent skill.");

  const allowedProviders = new Set(registry.capability.providers.map((provider) => provider.provider));
  const requestedProviders = input.targetProviders === undefined
    ? skill.targetProviders
    : normalizeTargetProviders(input.targetProviders, allowedProviders);
  if (input.targetProviders !== undefined && requestedProviders.length === 0 && input.enabled !== false) {
    return skillError("At least one advertised backend is required.");
  }

  const state = normalizeState(readAgentSkillState(options));
  const desired = {
    ...(state.skills?.[skillId] || {}),
    enabled: input.enabled === undefined ? skill.enabled : input.enabled === true,
    showInComposer: input.showInComposer === undefined ? skill.showInComposer : input.showInComposer === true,
    targetProviders: requestedProviders
  };
  const nextState = {
    version: 1,
    skills: {
      ...(state.skills || {}),
      [skillId]: desired
    }
  };
  writeAgentSkillState(nextState, options);
  const sync = syncAgentSkill(skillId, options);
  const nextRegistry = agentSkillRegistry(options);
  return {
    ok: sync.ok,
    skill: nextRegistry.skills.find((item) => item.id === skillId) || null,
    registry: nextRegistry,
    error: sync.ok ? "" : sync.error
  };
}

export async function importAgentSkill(input = {}, options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : defaultSkillRootSpecs();
  const sharedRoot = roots.find((rootSpec) => rootSpec?.sourceKind === "echo-shared" || rootSpec?.provider === "echo-shared");
  if (!sharedRoot?.root) return skillError("Echo shared Skill root is not available.");

  const source = normalizeGitHubSkillSource(input.sourceUrl || input.url);
  if (!source.ok) return skillError(source.error);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-agent-skill-import-"));
  const cloneDir = path.join(tempRoot, "repo");
  try {
    const cloneGit = options.cloneGit || cloneGitRepository;
    await cloneGit(source, cloneDir);
    const skillDir = resolveImportedSkillDirectory(cloneDir, source.path);
    const skill = skillFromDirectory({ provider: "echo-shared", label: "Echo shared registry", root: path.dirname(skillDir), sourceKind: "echo-shared" }, path.basename(skillDir), { includePaths: true });
    if (!skill) return skillError("Imported repository does not contain a valid SKILL.md.");

    const sharedRootReal = ensureRootDirectory(sharedRoot.root);
    const folderHash = crypto.createHash("sha256").update(source.normalizedUrl).digest("hex").slice(0, importedFolderSuffixLength);
    const targetFolder = `${sanitizeFolderName(skill.folder || skill.name)}-${folderHash}`;
    const targetPath = path.join(sharedRootReal, targetFolder);
    const parentReal = safeRealpath(path.dirname(targetPath));
    if (!parentReal || !isPathInsideOrSame(parentReal, sharedRootReal)) {
      throw new Error("Skill import target escaped shared root.");
    }
    if (fs.existsSync(targetPath)) {
      const targetReal = safeRealpath(targetPath);
      if (!targetReal || !isPathInsideOrSame(targetReal, sharedRootReal)) {
        throw new Error("Skill import target escaped shared root.");
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    copyDirectory(skillDir, targetPath, sharedRootReal);

    const registry = agentSkillRegistry({ ...options, roots });
    const importedSkill = registry.skills.find((item) => item.name === skill.name);
    if (!importedSkill) return skillError("Imported Skill was not discovered after install.");

    const targetProviders = input.targetProviders === undefined
      ? importedSkill.targetProviders
      : normalizeTargetProviders(input.targetProviders, new Set(registry.capability.providers.map((provider) => provider.provider)));
    const update = updateAgentSkillState(
      {
        skillId: importedSkill.id,
        enabled: input.enabled !== false,
        showInComposer: input.showInComposer !== false,
        targetProviders
      },
      { ...options, roots }
    );
    const nextRegistry = agentSkillRegistry({ ...options, roots });
    return {
      ok: update.ok,
      skill: nextRegistry.skills.find((item) => item.id === importedSkill.id) || null,
      registry: nextRegistry,
      source: {
        type: "github",
        owner: source.owner,
        repo: source.repo,
        ref: source.ref,
        path: source.path
      },
      error: update.ok ? "" : update.error
    };
  } catch (error) {
    return skillError(boundedError(error));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function syncAgentSkill(skillIdInput, options = {}) {
  const skillId = normalizeSkillId(skillIdInput);
  const roots = Array.isArray(options.roots) ? options.roots : defaultSkillRootSpecs();
  const registry = agentSkillRegistry({ ...options, roots, includePaths: true });
  const skill = registry.skills.find((item) => item.id === skillId);
  if (!skill) return skillError("Unknown agent skill.");
  const sourcePath = firstSourceDirectory(skill);
  if (!sourcePath) return skillError("Skill source is not available.");
  const sourceRoot = sourceRootForPath(sourcePath, roots);
  if (!sourceRoot) return skillError("Skill source is outside advertised roots.");

  const providerResults = [];
  if (skill.enabled) {
    for (const rootSpec of roots) {
      const provider = normalizeProviderId(rootSpec.provider);
      if (!provider || !skill.targetProviders.includes(provider)) continue;
      providerResults.push(syncSkillToProvider(skill, sourcePath, sourceRoot.root, rootSpec));
    }
  }
  if (!skill.enabled) {
    for (const rootSpec of roots) {
      const provider = normalizeProviderId(rootSpec.provider);
      if (!provider) continue;
      providerResults.push(removeManagedSkillFromProvider(skill, rootSpec));
    }
  }

  const failed = providerResults.find((result) => result.syncState === "failed");
  return {
    ok: !failed,
    providers: providerResults,
    error: failed?.error || ""
  };
}

export function readAgentSkillState(options = {}) {
  const filePath = agentSkillStatePath(options);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { version: 1, skills: {} };
  }
}

export function writeAgentSkillState(state = {}, options = {}) {
  const filePath = agentSkillStatePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(normalizeState(state), null, 2), { encoding: "utf8", mode: 0o600 });
}

export function agentSkillStatePath(options = {}) {
  if (options.statePath) return path.resolve(String(options.statePath));
  const dataDir = options.dataDir ? path.resolve(String(options.dataDir)) : path.join(os.homedir(), ".echo-voice");
  const agentId = normalizeAgentId(options.agentId || process.env.ECHO_AGENT_ID || "");
  return path.join(dataDir, agentId ? `agent-skills-${agentId}.json` : "agent-skills.json");
}

export function defaultSkillRootSpecs() {
  const echoRoot = path.resolve(process.env.ECHO_AGENT_SHARED_SKILL_ROOT || path.join(os.homedir(), ".echo-voice", "skills"));
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const claudeHome = process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  const roots = [
    {
      provider: "echo-shared",
      label: "Echo shared registry",
      root: echoRoot,
      sourceKind: "echo-shared",
      target: false
    },
    { provider: "codex", label: "Codex", root: path.join(codexHome, "skills"), sourceKind: "codex", target: true },
    {
      provider: "claude-code",
      label: "Claude Code",
      root: path.join(claudeHome, "skills"),
      sourceKind: "claude-code",
      target: true
    }
  ];
  for (const extraRoot of extraSkillRoots()) {
    roots.push({
      provider: "external",
      label: "External",
      root: extraRoot,
      sourceKind: "external",
      target: false
    });
  }
  return roots;
}

function managedSkillFromDiscovered(skill, desired, roots, options = {}) {
  const installedProviders = mergeProviders(skill.providers || []);
  const targetSummaries = targetProviderSummaries(roots);
  const targetProviderIds = new Set(targetSummaries.map((provider) => provider.provider));
  const installedTargetProviders = installedProviders
    .filter((provider) => targetProviderIds.has(provider.provider))
    .map((provider) => provider.provider);
  const sourceKinds = new Set((skill.sourceEntries || []).map((entry) => String(entry.kind || "").trim()));
  const targetProviders = desired?.targetProviders
    ? normalizeTargetProviders(desired.targetProviders, targetProviderIds)
    : installedTargetProviders.length
      ? installedTargetProviders
      : sourceKinds.has("echo-shared")
        ? targetSummaries.map((provider) => provider.provider)
        : [];
  const enabled = desired?.enabled === undefined ? true : desired.enabled === true;
  const showInComposer = desired?.showInComposer === undefined ? true : desired.showInComposer === true;
  const providerStatus = providerStatesForSkill(skill, roots, { enabled, targetProviders });
  const source = sourceSummary(skill.sourceEntries?.[0] || {}, skill);
  return {
    id: skill.id,
    name: skill.name,
    folder: skill.folder,
    description: skill.description,
    source,
    providers: providerStatus,
    enabled,
    showInComposer,
    targetProviders,
    syncState: aggregateSyncState(providerStatus),
    ...(options.includePaths ? { paths: skill.paths } : {})
  };
}

function publicInstalledSkill(skill, options = {}) {
  return {
    id: skill.id,
    name: skill.name,
    folder: skill.folder,
    description: skill.description,
    source: skill.source,
    providers: skill.providers,
    enabled: skill.enabled,
    showInComposer: skill.showInComposer,
    syncState: skill.syncState,
    targetProviders: skill.targetProviders,
    ...(options.includePaths && skill.paths ? { paths: skill.paths } : {})
  };
}

function listSkillsFromRoot(rootSpec = {}, options = {}) {
  const root = String(rootSpec.root || "").trim();
  if (!root) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => skillFromDirectory(rootSpec, entry.name, options))
    .filter(Boolean);
}

function skillFromDirectory(rootSpec, folder, options = {}) {
  const root = path.resolve(String(rootSpec.root || ""));
  const skillDir = path.join(root, folder);
  const filePath = path.join(skillDir, "SKILL.md");
  let source = "";
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = parseFrontmatter(source);
  const name = sanitizeSkillName(frontmatter.name || folder);
  if (!name) return null;
  const provider = normalizeProviderId(rootSpec.provider);
  const label = String(rootSpec.label || providerLabels[provider] || provider || "").trim();
  const id = stableSkillId(name);
  return {
    id,
    name,
    folder: sanitizeFolderName(folder || name),
    description: String(frontmatter.description || "").replace(/\s+/g, " ").trim().slice(0, 500),
    sourceEntries: [
      {
        kind: String(rootSpec.sourceKind || provider || "external").trim(),
        label,
        root,
        dir: skillDir,
        pathLabel: publicPathLabel(skillDir)
      }
    ],
    providers: [
      {
        provider,
        label,
        installed: true
      }
    ].filter((item) => item.provider),
    ...(options.includePaths ? { paths: [filePath] } : {})
  };
}

function providerStatesForSkill(skill, roots, desired = {}) {
  const installedByProvider = new Map((skill.providers || []).map((provider) => [provider.provider, provider]));
  const targets = targetProviderSummaries(roots);
  return targets.map((target) => {
    const installed = installedByProvider.has(target.provider);
    const enabled = Boolean(desired.enabled && desired.targetProviders.includes(target.provider));
    const managedPath = managedSkillPath(target.root, skill);
    const managedInstalled = managedPath ? fs.existsSync(path.join(managedPath, "SKILL.md")) : false;
    const provider = {
      provider: target.provider,
      label: target.label,
      installed: installed || managedInstalled,
      enabled,
      syncState: enabled ? (installed || managedInstalled ? "ready" : "pending") : "disabled"
    };
    if (!target.writable) {
      provider.syncState = enabled ? "failed" : "disabled";
      provider.error = "Skill root is not writable.";
    }
    return provider;
  });
}

function syncSkillToProvider(skill, sourcePath, sourceRoot, rootSpec = {}) {
  const provider = normalizeProviderId(rootSpec.provider);
  const label = String(rootSpec.label || providerLabels[provider] || provider || "").trim();
  const targetRoot = path.resolve(String(rootSpec.root || ""));
  try {
    const rootReal = ensureRootDirectory(targetRoot);
    const sourceReal = safeRealpath(sourcePath);
    const sourceRootReal = safeRealpath(sourceRoot);
    if (!sourceReal || !sourceRootReal || !isPathInsideOrSame(sourceReal, sourceRootReal)) {
      throw new Error("Skill source is outside advertised roots.");
    }
    if (sourceRootReal === rootReal) {
      return { provider, label, installed: true, enabled: true, syncState: "ready" };
    }
    const targetPath = managedSkillPath(rootReal, skill);
    const targetParent = path.dirname(targetPath);
    const parentReal = ensureRootDirectory(targetParent);
    if (!isPathInsideOrSame(parentReal, rootReal)) throw new Error("Skill target escaped backend root.");
    if (fs.existsSync(targetPath)) {
      const targetReal = safeRealpath(targetPath);
      if (!targetReal || !isPathInsideOrSame(targetReal, rootReal)) {
        throw new Error("Skill target escaped backend root.");
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    copyDirectory(sourceReal, targetPath, rootReal);
    const finalReal = safeRealpath(targetPath);
    if (!finalReal || !isPathInsideOrSame(finalReal, rootReal)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      throw new Error("Skill target escaped backend root.");
    }
    return { provider, label, installed: true, enabled: true, syncState: "ready" };
  } catch (error) {
    return {
      provider,
      label,
      installed: false,
      enabled: true,
      syncState: "failed",
      error: boundedError(error)
    };
  }
}

function removeManagedSkillFromProvider(skill, rootSpec = {}) {
  const provider = normalizeProviderId(rootSpec.provider);
  const label = String(rootSpec.label || providerLabels[provider] || provider || "").trim();
  try {
    const rootReal = safeRealpath(rootSpec.root);
    if (!rootReal) return { provider, label, installed: false, enabled: false, syncState: "disabled" };
    const targetPath = managedSkillPath(rootReal, skill);
    const targetReal = safeRealpath(targetPath);
    if (targetReal && !isPathInsideOrSame(targetReal, rootReal)) throw new Error("Skill target escaped backend root.");
    if (targetReal) fs.rmSync(targetReal, { recursive: true, force: true });
    return { provider, label, installed: false, enabled: false, syncState: "disabled" };
  } catch (error) {
    return { provider, label, installed: false, enabled: false, syncState: "failed", error: boundedError(error) };
  }
}

function copyDirectory(sourceDir, targetDir, allowedRoot) {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const parentReal = safeRealpath(path.dirname(targetPath));
    if (!parentReal || !isPathInsideOrSame(parentReal, allowedRoot)) throw new Error("Skill target escaped backend root.");
    if (entry.isSymbolicLink()) throw new Error("Symlinked Skill files are not materialized.");
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath, allowedRoot);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
      continue;
    }
  }
}

async function cloneGitRepository(source, cloneDir) {
  const args = ["clone", "--depth", "1"];
  if (source.ref) args.push("--branch", source.ref);
  args.push(source.gitUrl, cloneDir);
  await execFileAsync("git", args, {
    timeout: 120000,
    maxBuffer: 1024 * 1024
  });
}

function resolveImportedSkillDirectory(cloneDir, sourcePath = "") {
  const repoReal = safeRealpath(cloneDir);
  if (!repoReal) throw new Error("Imported repository is not available.");
  const requestedPath = String(sourcePath || "").trim();
  const skillDir = requestedPath ? path.join(repoReal, requestedPath) : repoReal;
  const skillReal = safeRealpath(skillDir);
  if (!skillReal || !isPathInsideOrSame(skillReal, repoReal)) {
    throw new Error("Skill path is outside imported repository.");
  }
  if (fs.existsSync(path.join(skillReal, "SKILL.md"))) return skillReal;
  throw new Error(requestedPath ? "Selected repository path does not contain SKILL.md." : "Repository root does not contain SKILL.md.");
}

function ensureRootDirectory(root) {
  const resolved = path.resolve(String(root || ""));
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const real = safeRealpath(resolved);
  if (!real) throw new Error("Skill root is not available.");
  return real;
}

function firstSourceDirectory(skill = {}) {
  const entries = Array.isArray(skill.sourceEntries) ? skill.sourceEntries : [];
  return entries.find((entry) => entry?.dir)?.dir || path.dirname((skill.paths || [])[0] || "");
}

function sourceRootForPath(sourcePath, roots = []) {
  const realSource = safeRealpath(sourcePath);
  if (!realSource) return null;
  return roots.find((rootSpec) => {
    const realRoot = safeRealpath(rootSpec.root);
    return realRoot && isPathInsideOrSame(realSource, realRoot);
  }) || null;
}

function sourceSummary(entry = {}, skill = {}) {
  return {
    kind: String(entry.kind || "external").trim(),
    label: String(entry.label || "Agent Skill").trim(),
    pathLabel: String(entry.pathLabel || publicPathLabel(path.dirname((skill.paths || [])[0] || ""))).trim().slice(0, 240)
  };
}

function summarizeManagedSkills(skills = []) {
  return {
    total: skills.length,
    enabled: skills.filter((skill) => skill.enabled).length,
    showInComposer: skills.filter((skill) => skill.enabled && skill.showInComposer).length,
    failed: skills.filter((skill) => skill.syncState === "failed").length
  };
}

function targetProviderSummaries(roots = []) {
  return roots
    .filter((rootSpec) => rootSpec && rootSpec.target !== false)
    .map((rootSpec) => {
      const provider = normalizeProviderId(rootSpec.provider);
      const root = path.resolve(String(rootSpec.root || ""));
      return {
        provider,
        label: String(rootSpec.label || providerLabels[provider] || provider || "").trim(),
        writable: isWritableRoot(root),
        rootLabel: publicPathLabel(root)
      };
    })
    .filter((provider) => provider.provider);
}

function isWritableRoot(root) {
  let current = path.resolve(String(root || ""));
  try {
    fs.accessSync(current, fs.constants.W_OK);
    return true;
  } catch {}
  while (current && current !== path.dirname(current)) {
    current = path.dirname(current);
    try {
      fs.accessSync(current, fs.constants.W_OK);
      return true;
    } catch {}
  }
  return false;
}

function managedSkillPath(root, skill = {}) {
  const folder = sanitizeFolderName(skill.folder || skill.name || skill.id || "skill");
  const suffix = String(skill.id || stableSkillId(folder)).replace(/[^a-z0-9]+/gi, "").slice(0, 12);
  return path.join(path.resolve(String(root || "")), `${managedFolderPrefix}${folder}-${suffix}`);
}

function aggregateSyncState(providers = []) {
  const enabled = providers.filter((provider) => provider.enabled);
  if (enabled.length === 0) return "disabled";
  if (enabled.some((provider) => provider.syncState === "failed")) return "failed";
  if (enabled.some((provider) => provider.syncState === "pending")) return "pending";
  return "ready";
}

function parseFrontmatter(source) {
  const text = String(source || "");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const frontmatter = text.slice(3, end).split(/\r?\n/);
  const result = {};
  for (const line of frontmatter) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return result;
}

function stableSkillId(name) {
  const normalized = sanitizeSkillName(name);
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `skill:${digest}`;
}

function sanitizeSkillName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sanitizeFolderName(value) {
  return sanitizeSkillName(value).replace(/[.]+/g, "-").slice(0, 100) || "skill";
}

function normalizeProviderId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeSkillId(value) {
  return String(value || "").trim().slice(0, 160);
}

function normalizeTargetProviders(value, allowedProviders) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(
    new Set(
      raw
        .map(normalizeProviderId)
        .filter((provider) => provider && (!allowedProviders || allowedProviders.has(provider)))
    )
  ).slice(0, 8);
}

function normalizeGitHubSkillSource(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: false, error: "GitHub Skill URL is required." };
  const urlText = raw.startsWith("github.com/") ? `https://${raw}` : raw;
  let url;
  try {
    url = new URL(urlText.startsWith("git@github.com:") ? `https://github.com/${urlText.slice("git@github.com:".length)}` : urlText);
  } catch {
    return { ok: false, error: "Only GitHub repository URLs are supported." };
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    return { ok: false, error: "Only github.com Skill sources are supported." };
  }
  const segments = url.pathname
    .replace(/\.git$/i, "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean);
  const owner = sanitizeGitHubPathSegment(segments[0]);
  const repo = sanitizeGitHubPathSegment(segments[1]);
  if (!owner || !repo) return { ok: false, error: "GitHub URL must include owner and repository." };
  if (segments.length > 2 && !["tree", "blob"].includes(segments[2])) {
    return { ok: false, error: "Use a repository URL or a GitHub tree URL." };
  }
  let ref = "";
  let skillPath = "";
  if (segments[2] === "tree" || segments[2] === "blob") {
    ref = sanitizeGitHubPathSegment(segments[3]);
    if (!ref) return { ok: false, error: "GitHub tree URL must include a branch or tag." };
    const pathSegments = segments.slice(4).map(sanitizeGitHubPathSegment).filter(Boolean);
    if (segments[2] === "blob" && pathSegments.at(-1)?.toLowerCase() === "skill.md") pathSegments.pop();
    skillPath = pathSegments.join("/");
  }
  const gitUrl = `https://github.com/${owner}/${repo}.git`;
  const normalizedUrl = `${gitUrl}#${ref || "HEAD"}:${skillPath}`;
  return { ok: true, gitUrl, owner, repo, ref, path: skillPath, normalizedUrl };
}

function sanitizeGitHubPathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeState(state = {}) {
  const skills = {};
  const inputSkills = state && typeof state.skills === "object" ? state.skills : {};
  for (const [id, value] of Object.entries(inputSkills)) {
    const skillId = normalizeSkillId(id);
    if (!skillId || !value || typeof value !== "object") continue;
    skills[skillId] = {
      enabled: value.enabled === true,
      showInComposer: value.showInComposer !== false,
      targetProviders: normalizeTargetProviders(value.targetProviders || [])
    };
  }
  return { version: 1, skills };
}

function normalizeAgentId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function mergeProviders(existing = [], incoming = []) {
  const byProvider = new Map();
  for (const provider of [...existing, ...incoming]) {
    if (provider?.provider) byProvider.set(provider.provider, { ...byProvider.get(provider.provider), ...provider });
  }
  return Array.from(byProvider.values());
}

function mergePaths(existing = [], incoming = []) {
  return Array.from(new Set([...existing, ...incoming].map((item) => String(item || "").trim()).filter(Boolean)));
}

function safeRealpath(filePath) {
  try {
    return fs.realpathSync(path.resolve(String(filePath || "")));
  } catch {
    return "";
  }
}

function isPathInsideOrSame(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicPathLabel(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const home = os.homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) return `~${path.sep}${path.relative(home, resolved)}`;
  return path.basename(resolved) || resolved;
}

function extraSkillRoots() {
  return String(process.env.ECHO_AGENT_SKILL_ROOTS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function boundedError(error) {
  return String(error?.message || error || "Skill sync failed.")
    .replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+/g, "[path]")
    .slice(0, 240);
}

function skillError(message) {
  return { ok: false, error: String(message || "Agent skill command failed.").slice(0, 240) };
}
