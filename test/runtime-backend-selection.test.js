import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRuntimeForAgent } from "../src/lib/codexRuntime.js";

test("sanitizeRuntimeForAgent selects the requested backend from desktop-advertised backends", () => {
  const runtime = sanitizeRuntimeForAgent(
    {
      backendId: "claude-code",
      model: "deepseek-v4-pro[1m]",
      permissionMode: "strict",
      worktreeMode: "always"
    },
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      model: "gpt-5.5",
      supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
      allowedPermissionModes: ["strict", "approve", "full"],
      worktreeMode: "optional",
      backends: [
        {
          backendId: "codex",
          provider: "codex",
          backendName: "Codex",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          model: "gpt-5.5",
          supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
          allowedPermissionModes: ["strict", "approve", "full"],
          worktreeMode: "optional"
        },
        {
          backendId: "claude-code",
          provider: "deepseek-via-claude",
          backendName: "Claude Code",
          sandbox: "read-only",
          approvalPolicy: "on-request",
          model: "deepseek-v4-flash",
          supportedModels: [
            { id: "deepseek-v4-flash", displayName: "DeepSeek-V4-Flash" },
            { id: "deepseek-v4-pro[1m]", displayName: "DeepSeek-V4-Pro[1M]" }
          ],
          allowedPermissionModes: ["strict"],
          worktreeMode: "optional"
        }
      ]
    }
  );

  assert.equal(runtime.backendId, "claude-code");
  assert.equal(runtime.provider, "deepseek-via-claude");
  assert.equal(runtime.backendName, "Claude Code");
  assert.equal(runtime.model, "deepseek-v4-pro[1m]");
  assert.equal(runtime.sandbox, "read-only");
  assert.equal(runtime.approvalPolicy, "on-request");
  assert.equal(runtime.worktreeMode, "always");
});

test("sanitizeRuntimeForAgent keeps the requested backend when multiple backends expose the requested model", () => {
  const runtime = sanitizeRuntimeForAgent(
    {
      backendId: "claude-code",
      model: "shared-coding-model"
    },
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      model: "shared-coding-model",
      supportedModels: [{ id: "shared-coding-model", displayName: "Shared Coding Model" }],
      backends: [
        {
          backendId: "codex",
          provider: "codex",
          backendName: "Codex",
          model: "shared-coding-model",
          supportedModels: [{ id: "shared-coding-model", displayName: "Shared Coding Model" }],
          allowedPermissionModes: ["strict", "approve", "full"]
        },
        {
          backendId: "claude-code",
          provider: "deepseek-via-claude",
          backendName: "Claude Code",
          model: "shared-coding-model",
          supportedModels: [{ id: "shared-coding-model", displayName: "Shared Coding Model" }],
          allowedPermissionModes: ["strict"]
        }
      ]
    }
  );

  assert.equal(runtime.backendId, "claude-code");
  assert.equal(runtime.provider, "deepseek-via-claude");
  assert.equal(runtime.model, "shared-coding-model");
});

test("sanitizeRuntimeForAgent keeps mobile permission mode independent of desktop allowed list", () => {
  const runtime = sanitizeRuntimeForAgent(
    {
      backendId: "claude-code",
      permissionMode: "full"
    },
    {
      backends: [
        {
          backendId: "claude-code",
          provider: "deepseek-via-claude",
          backendName: "Claude Code",
          sandbox: "read-only",
          approvalPolicy: "on-request",
          allowedPermissionModes: ["strict"]
        }
      ]
    }
  );

  assert.equal(runtime.backendId, "claude-code");
  assert.equal(runtime.permissionMode, "full");
  assert.equal(runtime.sandbox, "danger-full-access");
  assert.equal(runtime.approvalPolicy, "never");
});

test("sanitizeRuntimeForAgent ignores unknown permission strings and uses the backend default", () => {
  const runtime = sanitizeRuntimeForAgent(
    {
      backendId: "claude-code",
      permissionMode: "shell-root"
    },
    {
      backends: [
        {
          backendId: "claude-code",
          provider: "deepseek-via-claude",
          backendName: "Claude Code",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          permissionMode: "approve",
          allowedPermissionModes: ["strict"]
        }
      ]
    }
  );

  assert.equal(runtime.backendId, "claude-code");
  assert.equal(runtime.permissionMode, "approve");
  assert.equal(runtime.sandbox, "workspace-write");
  assert.equal(runtime.approvalPolicy, "on-request");
});
