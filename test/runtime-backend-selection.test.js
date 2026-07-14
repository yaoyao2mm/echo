import assert from "node:assert/strict";
import test from "node:test";
import { permissionRuntimeForBackend, resolveRuntimeForAgent, sanitizeRuntimeForAgent } from "../src/lib/codexRuntime.js";

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

test("sanitizeRuntimeForAgent does not enable optional worktree mode without an explicit request", () => {
  const runtime = sanitizeRuntimeForAgent(
    { backendId: "codex" },
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      worktreeMode: "optional"
    }
  );

  assert.equal(runtime.worktreeMode, "off");
});

test("runtime defaults to full access when a Workspace has no permission preference", () => {
  const capability = {
    backendId: "codex",
    provider: "codex",
    backends: [
      { backendId: "codex", provider: "codex" },
      { backendId: "claude-code", provider: "claude-code" }
    ]
  };

  const codex = resolveRuntimeForAgent({ backendId: "codex" }, capability);
  assert.equal(codex.permissionMode, "full");
  assert.equal(codex.sandbox, "danger-full-access");
  assert.equal(codex.approvalPolicy, "never");

  const claude = resolveRuntimeForAgent({ backendId: "claude-code" }, capability);
  assert.equal(claude.permissionMode, "full");
  assert.equal(claude.sandbox, "danger-full-access");
  assert.equal(claude.approvalPolicy, "never");
  assert.equal(claude.providerPermissionMode, "bypassPermissions");
});

test("sanitizeRuntimeForAgent keeps desktop-advertised Codex model and max effort", () => {
  const runtime = sanitizeRuntimeForAgent(
    {
      backendId: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max"
    },
    {
      backendId: "codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      supportedModels: [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT 5.6 Sol",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
        }
      ]
    }
  );

  assert.equal(runtime.model, "gpt-5.6-sol");
  assert.equal(runtime.reasoningEffort, "max");
});

test("sanitizeRuntimeForAgent rejects Codex models that the desktop did not advertise", () => {
  const runtime = sanitizeRuntimeForAgent(
    { backendId: "codex", model: "gpt-unadvertised", reasoningEffort: "max" },
    {
      backendId: "codex",
      provider: "codex",
      supportedModels: [{ id: "gpt-5.6-sol", supportedReasoningEfforts: ["max"] }]
    }
  );

  assert.equal(runtime.model, "");
  assert.equal(runtime.reasoningEffort, "");
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

test("sanitizeRuntimeForAgent ignores unknown permission strings and uses full access", () => {
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
  assert.equal(runtime.permissionMode, "full");
  assert.equal(runtime.sandbox, "danger-full-access");
  assert.equal(runtime.approvalPolicy, "never");
});

test("provider-neutral permissions map explicitly to Codex and Claude runtimes", () => {
  assert.deepEqual(permissionRuntimeForBackend("full", { backendId: "codex", provider: "codex" }), {
    permissionMode: "full",
    profile: "full",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    providerPermissionMode: "full"
  });
  assert.deepEqual(permissionRuntimeForBackend("full", { backendId: "claude-code", provider: "claude-code" }), {
    permissionMode: "full",
    profile: "full",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    providerPermissionMode: "bypassPermissions"
  });
});

test("strict runtime resolution never falls back to another backend or permission", () => {
  const capability = {
    backendId: "codex",
    provider: "codex",
    supportedModels: [{ id: "gpt-5.5" }],
    backends: [
      { backendId: "codex", provider: "codex", supportedModels: [{ id: "gpt-5.5" }] },
      {
        backendId: "limited",
        provider: "custom-runtime",
        supportedPermissionModes: ["strict"],
        supportedModels: [{ id: "limited-model" }]
      }
    ]
  };
  assert.throws(
    () => resolveRuntimeForAgent({ backendId: "codex", model: "limited-model", permissionMode: "full" }, capability),
    (error) => error.code === "runtime.model.unsupported"
  );
  assert.throws(
    () => resolveRuntimeForAgent({ backendId: "limited", model: "limited-model", permissionMode: "full" }, capability),
    (error) => error.code === "runtime.permission.unsupported"
  );
});
