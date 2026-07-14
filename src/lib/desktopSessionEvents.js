export async function postDesktopSessionEvents({
  sessionId,
  events = [],
  postEvents,
  updateLocalState,
  queueRetry
} = {}) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  if (normalizedEvents.length > 0) updateLocalState?.(sessionId, normalizedEvents);

  try {
    const posted = await postEvents(sessionId, normalizedEvents);
    if (posted?.ok === false) {
      queueRetry?.(sessionId, normalizedEvents, new Error("Relay rejected Codex session events."));
      return null;
    }
    return posted;
  } catch (error) {
    queueRetry?.(sessionId, normalizedEvents, error);
    return null;
  }
}
