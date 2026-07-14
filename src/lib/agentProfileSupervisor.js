export const gracefulDesktopRestartExitCode = 75;

export function profileWorkerRestartDelayMs(code) {
  return code === gracefulDesktopRestartExitCode ? 500 : 2000;
}

export function createAgentProfileSupervisor(options = {}) {
  const profiles = Array.isArray(options.profiles) ? options.profiles : [];
  const spawnWorker = options.spawnWorker;
  const schedule = options.schedule || setTimeout;
  const onWorkerError = options.onWorkerError || (() => {});
  const onWorkerExit = options.onWorkerExit || (() => {});
  const activeChildren = new Map();
  let started = false;
  let stopping = false;

  if (typeof spawnWorker !== "function") throw new TypeError("spawnWorker is required.");

  function start() {
    if (started || stopping) return;
    started = true;
    for (const profile of profiles) startWorker(profile);
  }

  function startWorker(profile) {
    if (stopping) return;
    const child = spawnWorker(profile);
    activeChildren.set(profile.agentId, child);
    child.on("error", (error) => onWorkerError({ profile, error }));
    child.on("exit", (code, signal) => {
      if (activeChildren.get(profile.agentId) === child) activeChildren.delete(profile.agentId);
      if (stopping) return;
      const delayMs = profileWorkerRestartDelayMs(code);
      const gracefulRestart = code === gracefulDesktopRestartExitCode;
      onWorkerExit({ profile, code, signal, delayMs, gracefulRestart });
      const timer = schedule(() => startWorker(profile), delayMs);
      timer?.unref?.();
    });
  }

  function stop(signal = "SIGTERM") {
    stopping = true;
    for (const child of activeChildren.values()) child.kill(signal);
    activeChildren.clear();
  }

  return {
    start,
    stop,
    activeWorkerCount: () => activeChildren.size
  };
}
