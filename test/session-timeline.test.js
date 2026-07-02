import assert from "node:assert/strict";
import test from "node:test";
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
