import os from "node:os";
import path from "node:path";

const systemPathSegments = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const homePathSegments = [
  [".local", "bin"],
  ["Library", "pnpm"],
  [".cargo", "bin"],
  [".bun", "bin"],
  [".deno", "bin"]
];
const developerPathSegments = [
  "/opt/homebrew/opt/python/libexec/bin",
  "/opt/homebrew/opt/python@3/libexec/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/opt/python/libexec/bin",
  "/usr/local/opt/python@3/libexec/bin",
  "/usr/local/bin",
  "/usr/local/sbin"
];

export function buildAgentProcessEnv(sourceEnv = process.env, overrides = {}) {
  const userInfo = os.userInfo();
  const next = { ...sourceEnv, ...overrides };
  const home = next.HOME || os.homedir();
  return {
    ...next,
    HOME: home,
    USER: next.USER || userInfo.username,
    LOGNAME: next.LOGNAME || userInfo.username,
    SHELL: next.SHELL || "/bin/zsh",
    PATH: normalizeAgentPath(next.PATH, home),
    LANG: next.LANG || "en_US.UTF-8"
  };
}

export function normalizeAgentPath(value, home = os.homedir()) {
  const rawSegments = uniquePathSegments(value);
  const developerSegments = defaultAgentDeveloperPathSegments(home);
  const developerSet = new Set(developerSegments);
  const systemSet = new Set(systemPathSegments);
  const withoutDeveloperSegments = rawSegments.filter((segment) => !developerSet.has(segment));
  const systemIndex = withoutDeveloperSegments.findIndex((segment) => systemSet.has(segment));
  const normalized =
    systemIndex >= 0
      ? [
          ...withoutDeveloperSegments.slice(0, systemIndex),
          ...developerSegments,
          ...withoutDeveloperSegments.slice(systemIndex)
        ]
      : [...withoutDeveloperSegments, ...developerSegments];

  for (const segment of systemPathSegments) {
    if (!normalized.includes(segment)) normalized.push(segment);
  }

  return uniquePathSegments(normalized.join(path.delimiter)).join(path.delimiter);
}

export function defaultAgentDeveloperPathSegments(home = os.homedir()) {
  const normalizedHome = String(home || "").trim();
  const homeSegments = normalizedHome
    ? homePathSegments.map((segments) => path.join(normalizedHome, ...segments))
    : [];
  return [...homeSegments, ...developerPathSegments];
}

function uniquePathSegments(value) {
  const seen = new Set();
  const segments = [];
  for (const segment of String(value || "").split(path.delimiter)) {
    const normalized = segment.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    segments.push(normalized);
  }
  return segments;
}
