const openSpecRoots = ["openspec", ".openspec", ".OpenSpec", "OpenSpec"];

export function completedBaselineChangeIds({ changes = [], runItems = [], porcelain = "" } = {}) {
  const runChangeIds = new Set(runItems.map((item) => String(item?.changeId || "").trim()).filter(Boolean));
  const dirtyPaths = porcelainPaths(porcelain);
  return changes
    .filter((change) => runChangeIds.has(String(change?.id || "").trim()))
    .filter(openSpecChangeCompleted)
    .map((change) => String(change.id).trim())
    .filter((changeId) => !dirtyPaths.some((filePath) => openSpecChangeOwnsPath(changeId, filePath)));
}

export function readyIntegrationItems(items = []) {
  return [...items]
    .filter((item) => item?.status === "ready")
    .sort((left, right) => Number(left?.position || 0) - Number(right?.position || 0));
}

export function orchestrationItemFingerprint(item = {}) {
  return String(item?.snapshotFingerprint || item?.fingerprint || "").trim();
}

export function completeNonBlockingManualTasks(markdown = "") {
  let completedCount = 0;
  const output = String(markdown || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*[-*]\s+)\[ \](\s+)(.+?)\s*$/);
    if (!match || !isNonBlockingManualTask(match[3])) return line;
    completedCount += 1;
    return `${match[1]}[x]${match[2]}${match[3]}`;
  }).join("\n");
  return { markdown: output, completedCount };
}

function openSpecChangeCompleted(change) {
  if (!change) return false;
  if (change.archived || ["archived", "complete", "completed"].includes(change.status)) return true;
  const completed = Number(change.progress?.completedTasks || 0);
  const total = Number(change.progress?.totalTasks || 0);
  return total > 0 && completed >= total;
}

function porcelainPaths(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean)
    .flatMap((filePath) => filePath.includes(" -> ") ? filePath.split(" -> ").map((part) => part.trim()) : [filePath]);
}

function openSpecChangeOwnsPath(changeId, filePath) {
  return openSpecRoots.some((root) => {
    const prefix = `${root}/changes/${changeId}`;
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  });
}

function isNonBlockingManualTask(value) {
  const text = String(value || "").toLowerCase();
  const chineseManual = /(人工|手动|浏览器|移动端|桌面端|视觉).*(验证|验收|检查|确认|复核|走查)/;
  const englishManual = /\b(manual(?:ly)?|human)\b.*\b(check|verify|validation|review|acceptance|qa)\b/
    .test(text) || /\b(check|verify|validate|review|qa)\b.*\b(browser|visual|desktop|mobile)\b/.test(text);
  const namedCheck = /\b(browser[ -]?check|visual[ -]?(?:qa|check|verification)|manual[ -]?(?:qa|check|verification))\b/.test(text);
  return chineseManual.test(text) || englishManual || namedCheck;
}
