import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const workspaceEnvKey = "ECHO_CODEX_WORKSPACES";
const envFilePath = path.resolve(process.cwd(), ".env");

const startupHadWorkspaceEnvValue = Object.prototype.hasOwnProperty.call(process.env, workspaceEnvKey);
dotenv.config();

const startupWorkspaceEnvValue = String(process.env[workspaceEnvKey] || "");
const startupWorkspaceEnvFileValue = readWorkspaceEnvFileValue();
const followWorkspaceEnvFile =
  !startupHadWorkspaceEnvValue ||
  (startupWorkspaceEnvFileValue.found && startupWorkspaceEnvValue === startupWorkspaceEnvFileValue.value);

export function configuredWorkspaces(fallback = process.cwd()) {
  const rawValue = currentWorkspaceEnvValue();
  const parsed = parseWorkspaces(rawValue);
  if (parsed.length > 0) return parsed;
  return Array.isArray(fallback) ? fallback : parseWorkspaces(fallback);
}

export function currentWorkspaceEnvValue() {
  if (followWorkspaceEnvFile) {
    const fileValue = readWorkspaceEnvFileValue();
    if (fileValue.fileExists) return fileValue.found ? fileValue.value : "";
  }
  return String(process.env[workspaceEnvKey] || "");
}

export function workspaceConfigFilePath() {
  return envFilePath;
}

export function parseWorkspaces(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label, rawPath] = item.includes("=") ? item.split("=", 2) : ["", item];
      const workspacePath = path.resolve(expandHome(rawPath.trim()));
      return {
        id: slug(label || path.basename(workspacePath) || "workspace"),
        label: label || path.basename(workspacePath) || workspacePath,
        path: workspacePath
      };
    });
}

function readWorkspaceEnvFileValue() {
  try {
    const parsed = dotenv.parse(fs.readFileSync(envFilePath, "utf8"));
    return {
      fileExists: true,
      found: Object.prototype.hasOwnProperty.call(parsed, workspaceEnvKey),
      value: String(parsed[workspaceEnvKey] || "")
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not read Echo workspace configuration:", error.message);
    }
    return { fileExists: false, found: false, value: "" };
  }
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}
