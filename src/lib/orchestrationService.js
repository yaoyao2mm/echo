import { EventEmitter } from "node:events";
import { orchestrationStore } from "./orchestrationStore.js";
import { cancelSession, createSession, enqueueSessionMessage, getSession } from "./codexStore.js";

const events = new EventEmitter();
let storeOverride = null;

function storeInstance() {
  return storeOverride || orchestrationStore();
}

export function setOrchestrationStoreForTest(store = null) {
  storeOverride = store;
}

export function createOrchestrationRun(input = {}) {
  const run = storeInstance().createRun(input);
  notifyRun(run.id);
  return run;
}

export function getOrchestrationRun(id, options = {}) {
  return storeInstance().getRun(id, options);
}

export function listOrchestrationRuns(options = {}) {
  return storeInstance().listRuns(options);
}

export function controlOrchestrationRun(id, action, options = {}) {
  const run = storeInstance().controlRun(id, action, options);
  if (action === "cancel" || action === "finish") {
    cancelActiveAttemptSessions(run.items.flatMap((item) => item.attempts || []), action === "finish"
      ? "Orchestration Run ended after recovery could not converge."
      : "Orchestration Run cancelled.");
  }
  notifyRun(run.id);
  return run;
}

export function retryOrchestrationItem(runId, itemId, options = {}) {
  const run = storeInstance().retryItem(runId, itemId, options);
  const item = run.items.find((candidate) => candidate.id === itemId);
  cancelActiveAttemptSessions(item?.attempts || [], "Orchestration Item retry requested.");
  notifyRun(run.id);
  return run;
}

export function recoverOrchestrationItem(runId, itemId, options = {}) {
  const run = storeInstance().recoverItem(runId, itemId, options);
  notifyRun(run.id);
  return run;
}

export function hasActiveOrchestrationRuns(targetAgentId) {
  return storeInstance().hasActiveRuns(targetAgentId);
}

export function claimOrchestrationWork(input = {}) {
  const store = storeInstance();
  store.reconcileExpiredLeases();
  for (const runId of store.reconcileRunStatuses()) notifyRun(runId);
  const attempt = store.claimReconciliation(input) || store.claimNextItem(input) || store.claimIntegration(input);
  if (!attempt) return null;
  const run = store.getRun(attempt.runId);
  return { attempt, run, item: attempt.itemId ? run.items.find((item) => item.id === attempt.itemId) || null : null };
}

export function bindOrchestrationAttemptSession(attemptId, input = {}) {
  const attempt = storeInstance().bindAttemptSession(attemptId, input);
  notifyRun(attempt.runId);
  return attempt;
}

export function createOrchestrationAttemptSession(attemptId, input = {}) {
  const store = storeInstance();
  const attempt = store.getAttempt(attemptId);
  if (!attempt) throw httpError("Orchestration Attempt not found.", 404);
  const run = store.getRun(attempt.runId);
  const item = run?.items.find((candidate) => candidate.id === attempt.itemId);
  if (!run || (!item && attempt.kind !== "integrate")) throw httpError("Orchestration Item not found.", 404);
  if (attempt.leaseOwner !== String(input.leaseOwner || "").trim()) throw httpError("Attempt lease owner does not match.", 409);
  if (attempt.sessionId) return getSession(attempt.sessionId);
  const previousSessionId = item?.attempts?.map((candidate) => candidate.sessionId).filter(Boolean).at(-1) || "";
  const previousSession = previousSessionId ? getSession(previousSessionId) : null;
  if (attempt.kind === "repair" && previousSession && !["cancelled", "closed", "stale"].includes(previousSession.status)) {
    const session = enqueueSessionMessage(previousSessionId, {
      text: repairPrompt(item),
      reuseSessionRuntime: true,
      projectId: run.projectId
    });
    store.bindAttemptSession(attempt.id, { leaseOwner: input.leaseOwner, sessionId: session.id });
    notifyRun(run.id);
    return session;
  }
  const sessionItem = item || { id: "integration", changeId: "integration", title: "Integration" };
  const session = createSession({
    projectId: run.projectId,
    prompt: attempt.kind === "integrate" ? integrationRepairPrompt(run) : implementPrompt(run, sessionItem),
    attachments: [],
    runtime: {
      backendId: run.runtimePolicy.backendId,
      model: run.runtimePolicy.model,
      permissionMode: run.runtimePolicy.permissionMode === "default" ? "" : run.runtimePolicy.permissionMode,
      worktreeMode: "always"
    },
    mode: "execute",
    ownerUser: run.ownerUser,
    targetAgentId: run.targetAgentId,
    internalExecution: {
      ...input.execution,
      ownerType: "orchestration",
      runId: run.id,
      itemId: sessionItem.id,
      worktreeKind: attempt.kind === "integrate" ? "integration" : "change",
      baseBranch: run.baseBranch,
      baseCommit: run.baseCommit
    }
  });
  store.bindAttemptSession(attempt.id, { leaseOwner: input.leaseOwner, sessionId: session.id });
  notifyRun(run.id);
  return session;
}

export function orchestrationAttemptSession(attemptId, input = {}) {
  const attempt = storeInstance().getAttempt(attemptId);
  if (!attempt || !attempt.sessionId || attempt.leaseOwner !== String(input.leaseOwner || "").trim()) return null;
  return getSession(attempt.sessionId);
}

export function completeOrchestrationAttempt(attemptId, input = {}) {
  assertAttemptAgent(attemptId, input);
  const attempt = storeInstance().completeAttempt(attemptId, input);
  notifyRun(attempt.runId);
  return attempt;
}

export function renewOrchestrationAttempt(attemptId, input = {}) {
  assertAttemptAgent(attemptId, input);
  const attempt = storeInstance().renewAttemptLease(attemptId, input);
  if (attempt) notifyRun(attempt.runId);
  return attempt;
}

export function addOrchestrationArtifact(input = {}) {
  const artifact = storeInstance().addArtifact(input);
  notifyRun(artifact.runId);
  return artifact;
}

export function markOrchestrationItemReady(itemId, input = {}) {
  const item = storeInstance().markItemReady(itemId, input);
  notifyRun(item.runId);
  return item;
}

export function completeOrchestrationIntegration(attemptId, input = {}) {
  assertAttemptAgent(attemptId, input);
  const run = storeInstance().completeIntegration(attemptId, input);
  notifyRun(run.id);
  return run;
}

export function reconcileOrchestrationBaseline(attemptId, input = {}) {
  assertAttemptAgent(attemptId, input);
  const run = storeInstance().reconcileBaseline(attemptId, input);
  notifyRun(run.id);
  return run;
}

export function subscribeOrchestrationRun(id, listener) {
  const name = eventName(id);
  events.on(name, listener);
  return () => events.off(name, listener);
}

function notifyRun(id) {
  events.emit(eventName(id), id);
}

function cancelActiveAttemptSessions(attempts, reason) {
  for (const attempt of attempts) {
    if (!attempt.sessionId) continue;
    const session = getSession(attempt.sessionId);
    if (!session || !["queued", "starting", "running"].includes(session.status)) continue;
    try { cancelSession(attempt.sessionId, { reason }); } catch {}
  }
}

function eventName(id) {
  return `orchestration-run-changed-${String(id || "").trim()}`;
}

function implementPrompt(run, item) {
  return [
    `请 apply OpenSpec change \`${item.changeId}\`。`,
    "",
    "要求：",
    `- 只处理 change \`${item.changeId}\`，不要实现其它 OpenSpec change。`,
    "- 先读取该 change 的 proposal、tasks、design（如有）和 specs delta。",
    "- 实施适合上线的全部改动，并更新该 change 的 tasks 勾选。",
    "- 纯人工、浏览器、移动端或视觉验收属于统一提交后的非阻塞复核：不要运行 e2e，直接将这类 task 勾选完成并在结果中说明。",
    "- 运行相关非 e2e 测试和 OpenSpec strict validation。",
    "- 不要 archive、push、merge 或操作当前 checkout。",
    "- 完成后简短汇报改动和校验。"
  ].join("\n");
}

function repairPrompt(item) {
  const latestFailure = [...(item.attempts || [])].reverse().find((attempt) => attempt.failureClass || attempt.errorSummary);
  const failedArtifacts = (item.artifacts || [])
    .filter((artifact) => artifact.status === "failed")
    .slice(-6)
    .map((artifact) => `- ${artifact.kind}: ${artifact.summary}`);
  return [
    `请作为 Echo Recovery Agent 收敛 OpenSpec change \`${item.changeId}\`。`,
    `最新失败分类：${latestFailure?.failureClass || "unknown"}`,
    `最新失败摘要：${latestFailure?.errorSummary || item.errorSummary || "未提供"}`,
    ...(failedArtifacts.length ? ["失败证据：", ...failedArtifacts] : []),
    "先判断失败来自实现、过时的规划/验收项，还是缺失的项目环境，再采取最小且可验证的修复。",
    "可以修正已经过时或不适用的 OpenSpec proposal、design、tasks 或 spec delta，但必须保留真实产品意图并说明理由。",
    "复用当前 Worktree，不要 archive、push、merge 或修改用户当前 checkout。",
    "纯人工、浏览器、移动端或视觉验收不阻塞本次编排；不要运行 e2e，直接勾选这类 task。",
    "修复后重新运行相关非 e2e 测试和 OpenSpec strict validation。"
  ].join("\n");
}

function integrationRepairPrompt(run) {
  return [
    `修复 OpenSpec 编排 \`${run.id}\` 的 Integration Worktree 冲突。`,
    "只解决当前 cherry-pick 冲突，保留所有已验收 change 的意图。",
    "不要修改用户当前 checkout，不要 push、merge 或 archive。",
    "解决冲突后保持 Git index 可供 cherry-pick --continue。"
  ].join("\n");
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function assertOrchestrationAttemptAgent(attemptId, input = {}) {
  return assertAttemptAgent(attemptId, input);
}

function assertAttemptAgent(attemptId, input = {}) {
  const attempt = storeInstance().getAttempt(attemptId);
  const run = attempt ? storeInstance().getRun(attempt.runId) : null;
  if (!attempt || !run) throw httpError("Orchestration Attempt not found.", 404);
  if (attempt.leaseOwner !== String(input.leaseOwner || "").trim()) throw httpError("Attempt lease owner does not match.", 409);
  return { attempt, run };
}
