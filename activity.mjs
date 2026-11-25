export const ActivityRpc = {
  id: "ethicnology.codex-activity",
  methods: {
    read: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: { type: "object" },
    },
  },
  events: {},
};

const agentStates = new Set([
  "pending_init", "running", "interrupted", "completed", "errored", "shutdown", "not_found",
]);
const actions = new Set(["spawn_agent", "send_input", "wait", "close_agent"]);
const maxAgents = 32;
const maxRecentTurns = 32;
const retentionMs = 60_000;

export function createActivity() {
  const active = new Map();
  const recent = new Map();

  return {
    start(sessionID) {
      const agents = new Map();
      recent.delete(sessionID);
      const turn = { agents, waiting: false, lastAction: undefined };
      active.set(sessionID, turn);

      return {
        record(item) {
          if (!actions.has(item.tool)) return;
          turn.lastAction = item.tool;
          if (item.tool === "wait") turn.waiting = item.status === "in_progress";
          const states = item.agents_states ?? {};
          const ids = new Set([...(item.receiver_thread_ids ?? []), ...Object.keys(states)]);
          for (const id of ids) {
            const previous = agents.get(id);
            if (!previous && agents.size >= maxAgents) continue;
            const reported = states[id]?.status;
            agents.set(id, {
              number: previous?.number ?? agents.size + 1,
              state: agentStates.has(reported) ? reported : previous?.state ?? "unknown",
              action: item.tool,
            });
          }
        },
        finish() {
          active.delete(sessionID);
          if (!turn.lastAction) return;
          recent.set(sessionID, { ...turn, until: Date.now() + retentionMs });
          if (recent.size > maxRecentTurns) recent.delete(recent.keys().next().value);
        },
      };
    },
    read(sessionID) {
      const current = active.get(sessionID);
      const previous = recent.get(sessionID);
      const turn = current ?? (previous?.until > Date.now() ? previous : undefined);
      return {
        running: Boolean(current),
        waiting: current?.waiting ?? false,
        agents: turn ? [...turn.agents.values()] : [],
        ...(turn?.lastAction ? { lastAction: turn.lastAction } : {}),
      };
    },
  };
}
