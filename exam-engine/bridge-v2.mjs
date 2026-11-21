const API = "/api/physics-exam/bridge";

export async function readConfirmedWrongbook(sessionId) {
  const url = sessionId ? API + "?sessionId=" + encodeURIComponent(sessionId) : API;
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "无法读取课前测确认记录");
  return data;
}

export function applyBridgeSnapshot(state, snapshot) {
  state.sessionId = snapshot.wrongbook?.sessionId || "";
  state.lesson = snapshot.lesson || {};
  state.grades = Array.isArray(snapshot.grades) ? snapshot.grades : [];
  state.knowledge = snapshot.knowledge && typeof snapshot.knowledge === "object" ? snapshot.knowledge : {};
  state.wrongbook = snapshot.wrongbook && typeof snapshot.wrongbook === "object"
    ? snapshot.wrongbook
    : { columns: [], rows: [], confirmed: false };
  state.panelBridge = {
    available: Boolean(snapshot.available),
    reason: String(snapshot.reason || ""),
    panelRevision: snapshot.panelRevision ?? null,
    confirmationVersion: snapshot.confirmationVersion ?? null,
    confirmedAt: snapshot.confirmedAt || "",
  };
  return state.panelBridge;
}
