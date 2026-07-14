import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { installSessions } from "../public/app/sessions.js";

test("conversation timeline keeps streamed follow-up user messages in order when messages snapshot is stale", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-order",
    status: "running",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:04.000Z",
    messages: [
      {
        role: "user",
        text: "第一轮问题",
        externalKey: "user:cmd_1",
        createdAt: "2026-05-04T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: 2,
        at: "2026-05-04T00:00:01.000Z",
        type: "item/completed",
        text: "第一轮回答",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_order",
            turnId: "turn_1",
            item: { id: "msg_1", type: "agentMessage", text: "第一轮回答" }
          }
        }
      },
      {
        id: 3,
        at: "2026-05-04T00:00:02.000Z",
        type: "user.message",
        text: "第二轮问题",
        raw: { source: "mobile", commandId: "cmd_2", messageId: "msg_user_2" }
      },
      {
        id: 4,
        at: "2026-05-04T00:00:03.000Z",
        type: "item/completed",
        text: "第二轮回答",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_order",
            turnId: "turn_2",
            item: { id: "msg_2", type: "agentMessage", text: "第二轮回答" }
          }
        }
      }
    ]
  });

  assert.deepEqual(
    timeline.filter((entry) => entry.kind === "message").map((entry) => [entry.role, entry.text]),
    [
      ["user", "第一轮问题"],
      ["assistant", "第一轮回答"],
      ["user", "第二轮问题"],
      ["assistant", "第二轮回答"]
    ]
  );
});

test("mobile worktree status exposes bounded recovery actions without local paths", () => {
  const app = createTimelineApp();
  app.sessionHasPendingWork = () => false;
  app.escapeHtml = (value) => String(value || "");

  const blocked = {
    id: "session-blocked",
    status: "active",
    execution: {
      mode: "worktree",
      lifecycleState: "apply-blocked",
      errorCode: "base-advanced",
      errorSummary: "主分支已有新提交"
    }
  };
  const entry = app.sessionStatusRailEntry(blocked);
  assert.equal(entry.healthLabel, "应用受阻");
  assert.match(app.renderWorktreeRailActions(blocked, entry), /修复后重试/);
  assert.equal(app.canChangeWorktreeSession(blocked), true);
  assert.doesNotMatch(entry.title, /private\/local/);

  const unavailable = { ...blocked, execution: { ...blocked.execution, lifecycleState: "unavailable" } };
  assert.match(app.renderWorktreeRailActions(unavailable, app.sessionStatusRailEntry(unavailable)), /改用主工作区/);
  const setupFailed = {
    ...blocked,
    execution: { ...blocked.execution, lifecycleState: "failed", setupStatus: "failed", errorSummary: "pnpm install failed" }
  };
  const setupActions = app.renderWorktreeRailActions(setupFailed, app.sessionStatusRailEntry(setupFailed));
  assert.match(setupActions, /data-worktree-action="setup">重试设置/);
  assert.match(setupActions, /data-worktree-action="discard">丢弃/);
  assert.equal(app.worktreeLifecycleLabel({ lifecycleState: "cleanup-failed" }), "清理失败");

  const orchestration = {
    ...blocked,
    execution: { ...blocked.execution, ownerType: "orchestration", runId: "run-1", itemId: "item-1" }
  };
  assert.equal(app.canChangeWorktreeSession(orchestration), false);
  assert.equal(app.renderWorktreeRailActions(orchestration, app.sessionStatusRailEntry(orchestration)), "");
});

test("mobile session rail shows durable desktop restart progress", () => {
  const app = createTimelineApp();
  app.shortCommit = (value) => String(value || "").slice(0, 7);
  const restarting = app.sessionStatusRailEntry({
    id: "restart-session",
    status: "active",
    restartOperation: {
      status: "restarting",
      expectedRevision: "abcdef0123456789"
    }
  });
  assert.equal(restarting.mode, "restart");
  assert.equal(restarting.gitLabel, "正在重启");
  assert.equal(restarting.healthLabel, "等待新实例上线");
  assert.equal(restarting.refText, "abcdef0");

  const resuming = app.sessionStatusRailEntry({
    id: "restart-session",
    restartOperation: { status: "resuming", actualRevision: "1234567890" }
  });
  assert.equal(resuming.gitLabel, "已重新连接");
  assert.equal(resuming.healthLabel, "正在恢复对话");
});

test("restart lifecycle diagnostics do not appear as current conversation failures", () => {
  const app = createTimelineApp();
  const job = {
    id: "restart-diagnostic-session",
    status: "active",
    lastError: "Desktop agent did not reconnect within the restart timeout.",
    messages: [{ role: "assistant", text: "Agent 仍在正常回复。", createdAt: "2026-07-13T00:00:00.000Z" }]
  };

  assert.equal(app.conversationErrorText(job), "");
  assert.equal(app.buildConversationTimeline(job, app.conversationErrorText(job)).some((entry) => entry.kind === "error"), false);
});

test("top Git status keeps details out of the transcript and exposes bounded on-demand evidence", () => {
  const app = createTimelineApp();
  app.escapeHtml = (value) => String(value || "");
  app.shortCommit = (value) => String(value || "").slice(0, 7);
  const session = {
    id: "session-git-details",
    status: "active",
    execution: { mode: "main" },
    events: [
      {
        type: "git.summary",
        raw: {
          gitSummary: {
            branch: "main",
            commit: "abcdef123456",
            changedFileCount: 3,
            changedFiles: ["a.js", "b.js", "c.js"],
            changedDuringTurn: { changedFileCount: 1, changedFiles: ["c.js"] }
          }
        }
      }
    ]
  };

  const entry = app.sessionStatusRailEntry(session);
  assert.equal(entry.gitLabel, "Git 变更 3");
  assert.equal(entry.gitSummary.changedDuringTurn.changedFileCount, 1);
  const details = app.renderSessionGitDetails(entry.gitSummary);
  assert.match(details, /本轮改动 1 个文件/);
  assert.match(details, /c\.js/);
  assert.match(details, /工作区共有 3 个未提交文件/);
});

test("tool transcript disclosures stay collapsed until the user opens them", () => {
  const app = createTimelineApp();
  const completed = app.renderCommandTranscriptPart({ command: "pnpm test", output: "ok", status: "succeeded" });
  const failed = app.renderCommandTranscriptPart({ command: "pnpm test", output: "failed", status: "failed" });

  assert.match(completed, /<details class="thread-part-disclosure thread-part-type-tool-group"/);
  assert.doesNotMatch(completed, /data-part-type="tool-group"[^>]* open/);
  assert.doesNotMatch(failed, /data-part-type="tool-group"[^>]* open/);
});

test("consecutive tool transcript entries collapse into one disclosure", () => {
  const app = createTimelineApp();
  const events = [
    [1, "2026-07-12T06:50:01.000Z", "command-1", "rg -n worktree", "matched"],
    [2, "2026-07-12T06:50:02.000Z", "command-2", "pnpm run check:js", "passed"],
    [3, "2026-07-12T06:50:03.000Z", "command-3", "pnpm test", "379 passed"]
  ].map(([id, at, itemId, command, output]) => ({
    id,
    at,
    type: "item/completed",
    raw: {
      method: "item/completed",
      params: { item: { id: itemId, type: "commandExecution", command, status: "completed", aggregatedOutput: output } }
    }
  }));
  const timeline = app.buildConversationTimeline({
    id: "session-tool-group",
    status: "active",
    createdAt: "2026-07-12T06:50:00.000Z",
    updatedAt: "2026-07-12T06:50:04.000Z",
    messages: [
      { role: "user", text: "检查这些改动", createdAt: "2026-07-12T06:50:00.000Z" },
      { role: "assistant", text: "检查完成。", createdAt: "2026-07-12T06:50:04.000Z" }
    ],
    events
  });

  const group = timeline.find((entry) => entry.kind === "tool-group");
  assert.equal(group.parts.length, 3);
  const rendered = timeline.map(app.renderConversationEntry).join("");
  assert.equal((rendered.match(/thread-part-type-tool-group/g) || []).length, 1);
  assert.match(rendered, /工具活动 3 项/);
  assert.equal((rendered.match(/data-part-type="command"/g) || []).length, 3);

  const failed = app.renderToolTranscriptGroup([
    { type: "command", command: "pnpm test", status: "failed", output: "failed" },
    { type: "command", command: "git status", status: "succeeded", output: "clean" }
  ]);
  assert.doesNotMatch(failed, /data-part-type="tool-group"[^>]* open/);

  const running = app.renderToolTranscriptGroup([
    { type: "command", command: "pnpm test", status: "running", output: "" },
    { type: "command", command: "git status", status: "succeeded", output: "clean" }
  ]);
  assert.doesNotMatch(running, /data-part-type="tool-group" open/);
});

test("conversation timeline uses the complete relay draft when retained delta events are truncated", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-draft",
    status: "running",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:04.000Z",
    finalMessage: "这是完整的前半段，后半段还在继续",
    messages: [
      {
        role: "user",
        text: "写一段长回复",
        externalKey: "user:cmd_1",
        createdAt: "2026-05-04T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: 101,
        at: "2026-05-04T00:00:03.000Z",
        type: "item/agentMessage/delta",
        text: "后半段",
        raw: {
          method: "item/agentMessage/delta",
          params: { threadId: "thr_draft", turnId: "turn_draft", itemId: "msg_draft" }
        }
      },
      {
        id: 102,
        at: "2026-05-04T00:00:04.000Z",
        type: "item/agentMessage/delta",
        text: "还在继续",
        raw: {
          method: "item/agentMessage/delta",
          params: { threadId: "thr_draft", turnId: "turn_draft", itemId: "msg_draft" }
        }
      }
    ]
  });

  assert.equal(timeline.at(-1).role, "assistant");
  assert.equal(timeline.at(-1).text, "这是完整的前半段，后半段还在继续");
});

test("session stream render coalesces consecutive partial SSE pages", () => {
  let frame = null;
  let rendered = null;
  const initial = {
    id: "session-stream-coalesce",
    status: "running",
    finalMessage: "",
    events: [{ id: 1, type: "user.message", text: "写一个长回复" }],
    messages: [{ role: "user", text: "写一个长回复", createdAt: "2026-05-04T00:00:00.000Z" }]
  };
  const app = createTimelineApp({
    state: {
      selectedCodexJobId: initial.id,
      selectedCodexSession: initial,
      sessionStreamRenderFrame: 0,
      pendingSessionStreamRender: null
    },
    window: {
      location: { origin: "http://localhost" },
      requestAnimationFrame(callback) {
        frame = callback;
        return 1;
      },
      cancelAnimationFrame() {}
    }
  });
  app.renderCodexJob = (session) => {
    rendered = session;
    app.state.selectedCodexSession = session;
  };
  app.sessionHasPendingWork = () => true;
  app.scheduleSessionListRefresh = () => {};

  app.queueCodexSessionStreamRender(
    {
      id: initial.id,
      status: "running",
      finalMessage: "前半段",
      lastEventId: 2,
      events: [{ id: 2, type: "item/agentMessage/delta", text: "前半段" }]
    },
    { partial: true }
  );
  app.queueCodexSessionStreamRender(
    {
      id: initial.id,
      status: "running",
      finalMessage: "前半段后半段",
      lastEventId: 3,
      events: [{ id: 3, type: "item/agentMessage/delta", text: "后半段" }]
    },
    { partial: true }
  );

  assert.equal(rendered, null);
  frame();

  assert.deepEqual(
    rendered.events.map((event) => event.id),
    [1, 2, 3]
  );
  assert.equal(rendered.finalMessage, "前半段后半段");
});

test("session list refresh updates selected pending state when detail load is skipped", async () => {
  const app = createTimelineApp({
    state: {
      selectedCodexJobId: "session-stale-queued",
      selectedCodexSession: {
        id: "session-stale-queued",
        projectId: "echo",
        status: "queued",
        pendingCommandCount: 1,
        queuedCommandCount: 1,
        leasedCommandCount: 0,
        messages: [{ role: "user", text: "hi" }],
        events: [{ id: 1, type: "user.message", text: "hi" }]
      },
      composingNewSession: false,
      showArchivedSessions: false,
      runtimePreferences: {}
    }
  });
  let statusRailSession = null;
  let detailLoads = 0;
  app.elements.codexJobs = createFakeElement();
  app.currentProjectId = () => "echo";
  app.sessionBelongsToCurrentProject = (session) => Boolean(session?.id && session.projectId === "echo");
  app.preferredSession = (jobs) => jobs[0];
  app.renderSessionButton = (job) => ({ job });
  app.closeCodexSessionStream = () => {};
  app.applyRuntimeDraft = () => {};
  app.renderEmptySessionDetail = () => {};
  app.refreshActiveSessionHeader = () => {};
  app.updateComposerAvailability = () => {};
  app.updateStopButton = () => {};
  app.renderSessionStatusRail = (session) => {
    statusRailSession = session;
  };
  app.showCodexJob = async () => {
    detailLoads += 1;
  };

  await app.renderProjectSessionList(
    [
      {
        id: "session-stale-queued",
        projectId: "echo",
        status: "active",
        pendingCommandCount: 0,
        queuedCommandCount: 0,
        leasedCommandCount: 0,
        updatedAt: "2026-05-04T00:00:05.000Z"
      }
    ],
    { skipSelectedDetailLoad: true }
  );

  assert.equal(detailLoads, 0);
  assert.equal(app.state.selectedCodexSession.status, "active");
  assert.equal(app.state.selectedCodexSession.pendingCommandCount, 0);
  assert.equal(app.state.selectedCodexSession.queuedCommandCount, 0);
  assert.deepEqual(app.state.selectedCodexSession.events.map((event) => event.id), [1]);
  assert.equal(statusRailSession.status, "active");
});

test("conversation timeline ignores delayed deltas from completed turns after a follow-up", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-delayed-old-delta",
    status: "running",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:04.000Z",
    finalMessage: "第一轮回答",
    messages: [
      {
        role: "user",
        text: "第一轮问题",
        externalKey: "user:cmd_1",
        createdAt: "2026-05-04T00:00:00.000Z"
      },
      {
        role: "assistant",
        text: "第一轮回答",
        externalKey: "assistant:turn_1:msg_1",
        createdAt: "2026-05-04T00:00:01.000Z"
      }
    ],
    events: [
      {
        id: 2,
        at: "2026-05-04T00:00:01.000Z",
        type: "item/completed",
        text: "第一轮回答",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_order",
            turnId: "turn_1",
            item: { id: "msg_1", type: "agentMessage", text: "第一轮回答" }
          }
        }
      },
      {
        id: 3,
        at: "2026-05-04T00:00:02.000Z",
        type: "turn/completed",
        text: "Turn completed.",
        raw: {
          method: "turn/completed",
          params: { threadId: "thr_order", turn: { id: "turn_1", status: "completed" } }
        }
      },
      {
        id: 4,
        at: "2026-05-04T00:00:03.000Z",
        type: "user.message",
        text: "第二轮问题",
        raw: { source: "mobile", commandId: "cmd_2", messageId: "msg_user_2" }
      },
      {
        id: 5,
        at: "2026-05-04T00:00:04.000Z",
        type: "item/agentMessage/delta",
        text: "旧回答的迟到片段",
        raw: {
          method: "item/agentMessage/delta",
          params: { threadId: "thr_order", turnId: "turn_1" }
        }
      }
    ]
  });

  assert.deepEqual(
    timeline.filter((entry) => entry.kind === "message").map((entry) => [entry.role, entry.text]),
    [
      ["user", "第一轮问题"],
      ["assistant", "第一轮回答"],
      ["user", "第二轮问题"]
    ]
  );
});

test("conversation timeline labels assistant messages with the session backend", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-claude",
    status: "active",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:01.000Z",
    runtime: {
      backendId: "claude-code",
      provider: "deepseek-via-claude",
      backendName: "Claude Code"
    },
    messages: [
      {
        role: "user",
        text: "帮我看下这个问题",
        createdAt: "2026-05-04T00:00:00.000Z"
      },
      {
        role: "assistant",
        text: "我来看。",
        createdAt: "2026-05-04T00:00:01.000Z"
      }
    ],
    events: []
  });

  const assistantMessage = timeline.find((entry) => entry.role === "assistant");
  assert.equal(assistantMessage.roleLabel, "Claude");
});

test("conversation timeline shows backend recovery context source", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-recovered",
    status: "active",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:02.000Z",
    messages: [
      {
        role: "user",
        text: "继续收掉恢复策略",
        createdAt: "2026-05-08T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: 10,
        at: "2026-05-08T00:00:01.000Z",
        type: "thread.recovered",
        text: "Claude Code native resume was unavailable; Echo rebuilt context from Echo session memory.",
        raw: {
          method: "thread/recovered",
          recovery: {
            strategy: "echo-memory-rebuild",
            source: "echo-session-memory",
            summaryIncluded: true,
            historyMessageCount: 2
          }
        }
      }
    ]
  });

  assert.equal(
    timeline.some((entry) => entry.kind === "system" && entry.text === "已用 Echo 会话摘要重建上下文"),
    true
  );
});

test("conversation timeline renders user screenshot attachments as file pills", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-user-attachment",
    status: "running",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:01.000Z",
    messages: [
      {
        role: "user",
        text: "看一下这个截图",
        createdAt: "2026-05-08T00:00:00.000Z",
        attachments: [
          {
            type: "image",
            name: "screen.jpg",
            mimeType: "image/jpeg",
            downloadPath: "/api/codex/attachments/att_screen"
          }
        ]
      }
    ],
    events: []
  });

  const user = timeline.find((entry) => entry.role === "user");
  const html = app.renderConversationEntry(user);
  assert.match(html, /thread-attachment-pill/);
  assert.match(html, /screen\.jpg/);
  assert.doesNotMatch(html, /thread-attachment-image/);
  assert.doesNotMatch(html, /<img\b/);
});

test("conversation timeline renders assistant image artifacts", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-image",
    status: "active",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:02.000Z",
    messages: [
      {
        role: "user",
        text: "生成一张图",
        createdAt: "2026-05-08T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: 20,
        at: "2026-05-08T00:00:01.000Z",
        type: "item/completed",
        text: "图片已生成。",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_image",
            turnId: "turn_image",
            item: {
              id: "msg_image",
              type: "agentMessage",
              text: "图片已生成。",
              imageArtifacts: [
                {
                  id: "artifact_image",
                  kind: "assistant_image",
                  label: "preview.png",
                  mimeType: "image/png",
                  downloadPath: "/api/codex/artifacts/artifact_image"
                }
              ]
            }
          }
        }
      }
    ]
  });

  const assistant = timeline.find((entry) => entry.role === "assistant");
  assert.equal(assistant.text, "图片已生成。");
  assert.equal(assistant.attachments[0].downloadPath, "/api/codex/artifacts/artifact_image");

  const html = app.renderConversationEntry(assistant);
  assert.match(html, /thread-attachment-image/);
  assert.match(html, /\/api\/codex\/artifacts\/artifact_image/);
});

test("agent markdown renderer supports tables, code, links, task lists, and draft fences", () => {
  const app = createMarkdownTimelineApp();
  const rendered = app.renderAgentMarkdown(
    [
      "### 结果",
      "",
      "- [x] 完成",
      "- [ ] 复查",
      "",
      "| 文件 | 状态 |",
      "| --- | --- |",
      "| public/app/sessions.js | modified |",
      "",
      "```js",
      "console.log('ok');",
      "```",
      "",
      "[OpenAI](https://openai.com)"
    ].join("\n")
  );

  assert.equal(rendered.degraded, false);
  assert.match(rendered.html, /<h3>结果<\/h3>/);
  assert.match(rendered.html, /<table>/);
  assert.match(rendered.html, /rich-code-block/);
  assert.match(rendered.html, /data-language="js"/);
  assert.match(rendered.html, /rich-task-list-item-checked/);
  assert.match(rendered.html, /target="_blank"/);
  assert.match(rendered.html, /rel="noreferrer noopener"/);

  const draft = app.renderAgentMarkdown("```diff\n+ added", { draft: true });
  assert.equal(draft.degraded, false);
  assert.match(draft.html, /class="language-diff"/);
  assert.match(draft.html, /\+ added/);
});

test("agent markdown renderer classifies workspace files without trusting agent metadata", () => {
  const app = createMarkdownTimelineApp();
  app.currentWorkspace = () => ({ path: "/workspace/echo" });
  const rendered = app.renderAgentMarkdown(
    "[relative](src/server.js:42) [absolute](/workspace/echo/docs/model.md#L7) [outside](/tmp/secret.txt) [escape](../secret.txt)"
  );

  assert.match(rendered.html, /href="#echo-workspace-file=src%2Fserver.js%23L42"/);
  assert.match(rendered.html, /href="#echo-workspace-file=docs%2Fmodel.md%23L7"/);
  assert.doesNotMatch(rendered.html, /target="_blank"[^>]*>relative/);
  assert.doesNotMatch(rendered.html, /<a[^>]+href="\/tmp\/secret\.txt"/);
  assert.doesNotMatch(rendered.html, /<a[^>]+href="\.\.\/secret\.txt"/);
  assert.doesNotMatch(rendered.html, /data-[\w-]+=/);
});

test("agent markdown renderer disables raw html, dangerous links, and markdown images", () => {
  const app = createMarkdownTimelineApp();
  const rendered = app.renderAgentMarkdown(
    [
      "<script>alert(1)</script>",
      '<a href="https://example.com" onclick="alert(1)" style="color:red">raw</a>',
      "[bad](javascript:alert(1))",
      "![tracking](https://example.com/pixel.png)"
    ].join("\n")
  );

  assert.equal(rendered.degraded, false);
  assert.doesNotMatch(rendered.html, /<script/i);
  assert.doesNotMatch(rendered.html, /<a\b[^>]*onclick=/i);
  assert.doesNotMatch(rendered.html, /<a\b[^>]*style=/i);
  assert.doesNotMatch(rendered.html, /href="javascript:/i);
  assert.doesNotMatch(rendered.html, /<img\b/i);
  assert.match(rendered.html, /tracking/);
});

test("conversation rendering uses assistant markdown and keeps user text plain", () => {
  const app = createMarkdownTimelineApp();
  const assistantHtml = app.renderConversationEntry({
    kind: "message",
    role: "assistant",
    roleLabel: "Codex",
    text: "**Done**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
    at: "2026-05-08T00:00:00.000Z"
  });
  assert.match(assistantHtml, /rich-transcript/);
  assert.match(assistantHtml, /<strong>Done<\/strong>/);
  assert.match(assistantHtml, /<table>/);
  assert.equal([...app.state.conversationRawMessages.values()][0], "**Done**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");

  const userHtml = app.renderConversationEntry({
    kind: "message",
    role: "user",
    text: "**Do not render** <b>x</b>",
    at: "2026-05-08T00:00:01.000Z"
  });
  assert.doesNotMatch(userHtml, /rich-transcript/);
  assert.doesNotMatch(userHtml, /<strong>Do not render<\/strong>/);
  assert.match(userHtml, /\*\*Do not render\*\* &lt;b&gt;x&lt;\/b&gt;/);
});

test("assistant markdown rendering falls back to escaped plain text when libraries are unavailable", () => {
  const app = createTimelineApp({ window: { location: { origin: "http://localhost" } } });
  app.escapeHtml = escapeHtmlForTest;

  const html = app.renderConversationEntry({
    kind: "message",
    role: "assistant",
    roleLabel: "Codex",
    text: "**raw** <b>x</b>",
    at: "2026-05-08T00:00:00.000Z"
  });

  assert.doesNotMatch(html, /rich-transcript/);
  assert.match(html, /\*\*raw\*\* &lt;b&gt;x&lt;\/b&gt;/);
});

test("interaction other input is hidden until the other option is selected", () => {
  const app = createTimelineApp();
  const html = app.renderInteractionQuestion({
    id: "mode",
    question: "选择模式",
    isOther: true,
    options: [
      { label: "自动", description: "默认流程" },
      { label: "手动", description: "用户指定" }
    ]
  });

  assert.match(html, /interaction-option-other/);
  assert.match(html, /interaction-other-field" data-other-field-for="mode" hidden/);
  assert.match(html, /data-other-for="mode"[^>]*disabled/);

  const input = { dataset: { otherFor: "mode" }, disabled: true };
  const field = { hidden: true };
  const form = {
    querySelectorAll: () => [input],
    querySelector(selector) {
      if (selector.includes(":checked")) return { value: "__other__" };
      if (selector.includes("data-other-field-for")) return field;
      return null;
    }
  };
  app.updateInteractionOtherInputs(form);
  assert.equal(input.disabled, false);
  assert.equal(field.hidden, false);
});

test("structured transcript maps backend events to neutral parts and orders them with messages", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-parts",
    status: "active",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:08.000Z",
    messages: [
      { role: "user", text: "运行检查", createdAt: "2026-07-10T00:00:00.000Z" },
      { role: "assistant", text: "检查完成。", createdAt: "2026-07-10T00:00:07.000Z" }
    ],
    approvals: [
      { id: "approval-1", status: "pending", createdAt: "2026-07-10T00:00:03.000Z" }
    ],
    interactions: [
      { id: "interaction-1", status: "pending", createdAt: "2026-07-10T00:00:04.000Z" }
    ],
    events: [
      {
        id: 10,
        at: "2026-07-10T00:00:01.000Z",
        type: "item/started",
        raw: {
          method: "item/started",
          params: { item: { id: "command-1", type: "commandExecution", command: ["pnpm", "test"], status: "running" } }
        }
      },
      {
        id: 11,
        at: "2026-07-10T00:00:02.000Z",
        type: "item/completed",
        raw: {
          method: "item/completed",
          params: {
            item: {
              id: "command-1",
              type: "commandExecution",
              command: ["pnpm", "test"],
              status: "completed",
              aggregatedOutput: "23 tests passed"
            }
          }
        }
      },
      {
        id: 12,
        at: "2026-07-10T00:00:02.500Z",
        type: "item/completed",
        raw: {
          method: "item/completed",
          params: {
            item: {
              id: "files-1",
              type: "fileChange",
              status: "completed",
              changes: [{ path: "public/app/sessions.js", changeType: "modified" }]
            }
          }
        }
      },
      {
        id: 13,
        at: "2026-07-10T00:00:05.000Z",
        type: "test.summary",
        raw: { testSummary: { level: "quick", status: "passed", command: "pnpm test", failures: [] } }
      },
      {
        id: 14,
        at: "2026-07-10T00:00:06.000Z",
        type: "git.summary",
        raw: {
          gitSummary: {
            branch: "main",
            commit: "abcdef123456",
            changedFileCount: 1,
            changedFiles: ["public/app/sessions.js"]
          }
        }
      },
      { id: 15, at: "2026-07-10T00:00:06.500Z", type: "context.compaction.started", raw: {} }
    ]
  });

  const parts = timeline.flatMap((entry) => entry.parts || []);
  assert.deepEqual(
    parts.map((part) => part.type),
    ["text", "command", "file-change", "approval", "interaction", "test-result", "status", "text"]
  );
  assert.equal(parts.find((part) => part.type === "command").status, "succeeded");
  assert.equal(parts.find((part) => part.type === "command").output, "23 tests passed");
  assert.deepEqual(parts.find((part) => part.type === "file-change").changes, [
    { path: "public/app/sessions.js", changeType: "modified" }
  ]);
  assert.equal(parts.some((part) => part.type === "git-summary"), false);
  assert.equal(parts.find((part) => part.type === "status").label, "上下文压缩中");

  const rendered = timeline.map(app.renderConversationEntry).join("");
  assert.match(rendered, /data-part-type="command"/);
  assert.match(rendered, /data-part-type="file-change"/);
  assert.match(rendered, /data-part-type="test-result"/);
  assert.doesNotMatch(rendered, /data-part-type="git-summary"/);
  assert.match(rendered, /<details class="thread-part-disclosure thread-part-type-tool-group"/);
  assert.match(rendered, /使用终端/);
  assert.match(rendered, /data-transcript-decision="approval" data-decision-id="approval-1"/);
  assert.match(rendered, /data-transcript-decision="interaction" data-decision-id="interaction-1"/);
});

test("message parts take precedence while entry text remains available for compatibility", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-message-parts",
    status: "active",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    messages: [
      {
        role: "assistant",
        text: "原始结果",
        createdAt: "2026-07-10T00:00:01.000Z",
        parts: [
          { type: "text", text: "结构化正文" },
          { type: "status", label: "已恢复", status: "succeeded" },
          { type: "provider-specific-secret", value: "ignored" }
        ]
      }
    ],
    events: []
  });

  assert.equal(timeline[0].text, "原始结果");
  assert.deepEqual(timeline[0].parts.map((part) => part.type), ["text", "status"]);
  assert.equal(timeline[0].parts[0].text, "结构化正文");
  assert.match(app.renderConversationEntry(timeline[0]), /已恢复/);
});

test("interaction controls preserve long copy, other answers, submit, and cancel payloads", async () => {
  const posts = [];
  const app = createTimelineApp();
  app.apiPost = async (path, payload) => posts.push({ path, payload });
  app.showCodexJob = async () => {};
  app.toast = () => {};
  app.handleAuthError = () => false;
  const longLabel = "一个需要在窄屏中自然换行但不能遮挡按钮的很长选项".repeat(4);
  const interaction = {
    id: "interaction-plan",
    payload: {
      questions: [
        {
          id: "mode",
          header: "Plan Mode",
          question: "选择执行方式",
          isOther: true,
          options: [{ label: longLabel, description: "保持现有权限语义" }]
        }
      ]
    }
  };
  const html = app.renderInteractionQuestion(interaction.payload.questions[0]);
  assert.match(html, new RegExp(longLabel));
  assert.match(html, /interaction-other-field[^>]*hidden/);

  const form = {
    querySelector(selector) {
      if (selector.includes(":checked")) return { value: "__other__" };
      if (selector.includes("data-other-for")) return { value: "手动执行" };
      return null;
    }
  };
  assert.deepEqual(app.collectInteractionAnswers(interaction, form), { mode: { answers: ["手动执行"] } });
  await app.submitInteractionAnswer("session-1", interaction, form);
  await app.decideInteraction("session-1", interaction.id, { decision: "cancel" });
  assert.deepEqual(posts.map((post) => post.payload), [
    { answers: { mode: { answers: ["手动执行"] } } },
    { decision: "cancel" }
  ]);
});

test("conversation timeline de-duplicates mirrored assistant image artifact refs", () => {
  const app = createTimelineApp();
  const artifact = {
    id: "artifact_image",
    kind: "assistant_image",
    label: "Assistant image",
    mimeType: "image/png",
    downloadPath: "/api/codex/artifacts/artifact_image"
  };
  const timeline = app.buildConversationTimeline({
    id: "session-image-duplicate",
    status: "active",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:02.000Z",
    messages: [],
    events: [
      {
        id: 20,
        at: "2026-05-08T00:00:01.000Z",
        type: "item/completed",
        text: "图片已生成。",
        raw: {
          method: "item/completed",
          imageArtifacts: [artifact],
          params: {
            threadId: "thr_image",
            turnId: "turn_image",
            item: {
              id: "msg_image",
              type: "agentMessage",
              text: "图片已生成。",
              imageArtifacts: [artifact]
            }
          }
        }
      }
    ]
  });

  const assistant = timeline.find((entry) => entry.role === "assistant");
  assert.equal(assistant.attachments.length, 1);

  const html = app.renderConversationEntry(assistant);
  assert.equal((html.match(/<img\b/g) || []).length, 1);
  assert.equal((html.match(/thread-attachment-image-link/g) || []).length, 1);
});

test("conversation timeline renders image generation item artifacts", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-image-generation",
    status: "active",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:02.000Z",
    messages: [],
    events: [
      {
        id: 20,
        at: "2026-05-08T00:00:01.000Z",
        type: "item/completed",
        text: "图片已生成。",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_image_generation",
            turnId: "turn_image_generation",
            item: {
              id: "img_gen_1",
              type: "imageGeneration",
              text: "图片已生成。",
              imageArtifacts: [
                {
                  id: "artifact_image_generation",
                  kind: "assistant_image",
                  label: "Assistant image",
                  mimeType: "image/png",
                  downloadPath: "/api/codex/artifacts/artifact_image_generation"
                }
              ]
            }
          }
        }
      }
    ]
  });

  const assistant = timeline.find((entry) => entry.role === "assistant");
  assert.equal(assistant.text, "图片已生成。");
  assert.equal(assistant.attachments[0].downloadPath, "/api/codex/artifacts/artifact_image_generation");

  const html = app.renderConversationEntry(assistant);
  assert.match(html, /thread-attachment-image/);
  assert.match(html, /\/api\/codex\/artifacts\/artifact_image_generation/);
});

test("conversation timeline merges assistant image artifacts into stored assistant messages", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-image-message-merge",
    status: "active",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:02.000Z",
    messages: [
      {
        role: "user",
        text: "给我发送一张测试图片",
        externalKey: "user:cmd_1",
        createdAt: "2026-05-08T00:00:00.000Z"
      },
      {
        role: "assistant",
        text: "图片已生成。",
        externalKey: "assistant:turn_image_generation:img_gen_1",
        createdAt: "2026-05-08T00:00:01.000Z"
      }
    ],
    events: [
      {
        id: 20,
        at: "2026-05-08T00:00:01.000Z",
        type: "item/completed",
        text: "图片已生成。",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_image_generation",
            turnId: "turn_image_generation",
            item: {
              id: "img_gen_1",
              type: "imageGeneration",
              text: "图片已生成。",
              imageArtifacts: [
                {
                  id: "artifact_image_generation",
                  kind: "assistant_image",
                  label: "Assistant image",
                  mimeType: "image/png",
                  downloadPath: "/api/codex/artifacts/artifact_image_generation"
                }
              ]
            }
          }
        }
      }
    ]
  });

  const assistantMessages = timeline.filter((entry) => entry.kind === "message" && entry.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].text, "图片已生成。");
  assert.equal(assistantMessages[0].attachments[0].downloadPath, "/api/codex/artifacts/artifact_image_generation");

  const html = app.renderConversationEntry(assistantMessages[0]);
  assert.match(html, /thread-attachment-image/);
  assert.match(html, /\/api\/codex\/artifacts\/artifact_image_generation/);
});

test("conversation timeline keeps image artifacts when duplicate assistant text already exists", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-image-duplicate-text",
    status: "active",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:02.000Z",
    messages: [],
    events: [
      {
        id: 19,
        at: "2026-05-08T00:00:00.500Z",
        type: "item/completed",
        text: "图片已生成。",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_image_generation",
            turnId: "turn_image_generation",
            item: { id: "msg_placeholder", type: "agentMessage", text: "图片已生成。" }
          }
        }
      },
      {
        id: 20,
        at: "2026-05-08T00:00:01.000Z",
        type: "item/completed",
        text: "图片已生成。",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_image_generation",
            turnId: "turn_image_generation",
            item: {
              id: "img_gen_1",
              type: "imageGeneration",
              text: "图片已生成。",
              imageArtifacts: [
                {
                  id: "artifact_image_generation",
                  kind: "assistant_image",
                  label: "Assistant image",
                  mimeType: "image/png",
                  downloadPath: "/api/codex/artifacts/artifact_image_generation"
                }
              ]
            }
          }
        }
      }
    ]
  });

  const assistantMessages = timeline.filter((entry) => entry.kind === "message" && entry.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].attachments[0].downloadPath, "/api/codex/artifacts/artifact_image_generation");
});

test("conversation image previews add auth query for direct browser loads", () => {
  const app = createTimelineApp({
    state: {
      token: "pair token",
      sessionToken: "echo1.payload.sig",
      authEnabled: true
    },
    window: {
      location: { origin: "https://echo.example" }
    }
  });

  const imagePath = app.authenticatedResourcePath("/api/codex/artifacts/artifact_image");
  assert.equal(imagePath, "/api/codex/artifacts/artifact_image?token=pair+token&session=echo1.payload.sig");

  const html = app.renderConversationAttachments(
    [{ type: "image", name: "Assistant image", downloadPath: "/api/codex/artifacts/artifact_image" }],
    { role: "assistant" }
  );
  assert.match(html, /src="\/api\/codex\/artifacts\/artifact_image\?token=pair\+token&session=echo1\.payload\.sig"/);
  assert.match(html, /href="\/api\/codex\/artifacts\/artifact_image\?token=pair\+token&session=echo1\.payload\.sig"/);
});

test("conversation timeline folds legacy assistant base64 image text", () => {
  const app = createTimelineApp();
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const timeline = app.buildConversationTimeline({
    id: "session-legacy-base64-image",
    status: "active",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:02.000Z",
    messages: [
      {
        role: "user",
        text: "发一张图片",
        createdAt: "2026-05-08T00:00:00.000Z"
      },
      {
        role: "assistant",
        text: pngBase64,
        createdAt: "2026-05-08T00:00:01.000Z"
      }
    ],
    events: []
  });

  const assistant = timeline.find((entry) => entry.role === "assistant");
  assert.equal(assistant.text, "图片已生成。");

  const html = app.renderConversationEntry(assistant);
  assert.doesNotMatch(html, new RegExp(pngBase64.slice(0, 24)));
  assert.match(html, /图片已生成。/);
});

test("turn activity distinguishes queued and leased desktop commands", () => {
  const app = createTimelineApp();

  assert.equal(
    app.turnActivityForSession({
      id: "queued-session",
      status: "active",
      pendingCommandCount: 1,
      queuedCommandCount: 1,
      leasedCommandCount: 0,
      events: []
    }).text,
    "等待桌面接收任务"
  );

  assert.equal(
    app.turnActivityForSession({
      id: "blocked-session",
      status: "queued",
      pendingCommandCount: 1,
      queuedCommandCount: 1,
      leasedCommandCount: 0,
      queueBlocker: {
        type: "project_busy",
        projectId: "memory",
        blockedBySessionId: "running-session",
        blockedByTitle: "检查工程状态"
      },
      events: []
    }).text,
    "等待同工程任务完成"
  );

  assert.equal(
    app.turnActivityForSession({
      id: "leased-session",
      status: "running",
      runtime: {
        backendId: "codex",
        provider: "codex",
        backendName: "Codex"
      },
      pendingCommandCount: 1,
      queuedCommandCount: 0,
      leasedCommandCount: 1,
      events: []
    }).text,
    "桌面已接收，Codex 正在处理"
  );
});

test("turn activity never exposes terminal commands or output", () => {
  const app = createTimelineApp();
  const activity = app.turnActivityForSession({
    id: "running-command-session",
    status: "running",
    runtime: { backendId: "codex", provider: "codex", backendName: "Codex" },
    pendingCommandCount: 1,
    queuedCommandCount: 0,
    leasedCommandCount: 1,
    events: [
      {
        type: "item/completed",
        raw: {
          method: "item/completed",
          params: {
            item: {
              type: "commandExecution",
              status: "completed",
              command: ["/bin/zsh", "-lc", "git status --short"],
              aggregatedOutput: "M public/app/sessions.js"
            }
          }
        }
      }
    ]
  });

  assert.equal(activity.text, "桌面已接收，Codex 正在处理");
  assert.doesNotMatch(`${activity.text} ${activity.title}`, /git status|sessions\.js|已完成/);
});

function createTimelineApp(options = {}) {
  const app = {
    document: {},
    elements: {},
    navigator: {},
    state: options.state || {},
    window: options.window || { location: { origin: "http://localhost" } },
    humanizeCodexError: (value) => value || "",
    formatMessageTime: (value) => value || "",
    escapeHtml: (value) => String(value || "")
  };
  installSessions(app);
  return app;
}

function createMarkdownTimelineApp() {
  const app = createTimelineApp({
    window: {
      location: { origin: "http://localhost" },
      markdownit: MarkdownIt
    }
  });
  app.escapeHtml = escapeHtmlForTest;
  app.agentMarkdownSanitizer = {
    sanitize(html) {
      return String(html || "")
        .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
        .replace(/\s+style\s*=\s*"[^"]*"/gi, "")
        .replace(/\s+style\s*=\s*'[^']*'/gi, "")
        .replace(/\s+href\s*=\s*"javascript:[^"]*"/gi, "")
        .replace(/\s+href\s*=\s*'javascript:[^']*'/gi, "")
        .replace(/<img\b[^>]*>/gi, "");
    }
  };
  return app;
}

function escapeHtmlForTest(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createFakeElement() {
  return {
    innerHTML: "",
    textContent: "",
    hidden: false,
    append() {},
    querySelectorAll: () => [],
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}
  };
}
