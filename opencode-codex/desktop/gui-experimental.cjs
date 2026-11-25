"use strict";
// Composer pills for Codex subagents, subscription usage, and session host load.
// Uses only the modules supplied by OpenCode Desktop.
const { Plugin, ComposerPill, createKeyed } = require("@opencode/plugin/gui");
const { createSignal, onCleanup } = require("solid-js");

// Must match status.mjs on the server.
const StatusRpc = {
  id: "ethicnology.status",
  methods: { read: { input: { type: "object" }, output: { type: "object" } } },
  events: {},
};

const REFRESH_MS = 60_000;

// Must match activity.mjs on the server.
const ActivityRpc = {
  id: "ethicnology.codex-activity",
  methods: {
    read: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: { type: "object" },
    },
  },
  events: {},
};

const agentStates = {
  pending_init: "Starting", running: "Running", interrupted: "Interrupted",
  completed: "Completed", errored: "Failed", shutdown: "Closed", not_found: "Unavailable",
};
const agentActions = {
  spawn_agent: "Spawn requested", send_input: "Input sent", wait: "Wait requested", close_agent: "Close requested",
};

function addActivityPill(ctx) {
  const [snapshot, setSnapshot] = createSignal();
  createKeyed(
    () => {
      const session = ctx.sessions.current();
      return session?.directory && !session.pending ? session : undefined;
    },
    session => {
      let stopped = false;
      let next;
      let request;
      setSnapshot(undefined);
      onCleanup(() => {
        stopped = true;
        clearTimeout(next);
        request?.abort();
      });

      async function refresh() {
        request = new AbortController();
        const timeout = setTimeout(() => request.abort(), 8000);
        let delay = 15000;
        try {
          const result = await session.server.client.rpc(ActivityRpc).read(
            { sessionID: session.id },
            { location: { directory: session.directory }, signal: request.signal },
          );
          const value = result?.output ?? result;
          if (!stopped && !request.signal.aborted) {
            setSnapshot({ visit: session.visit, value });
            delay = value.running ? 2000 : 5000;
          }
        } catch {
          if (!stopped) setSnapshot(undefined);
        } finally {
          clearTimeout(timeout);
          if (!stopped) next = setTimeout(refresh, delay);
        }
      }

      void refresh();
    },
    { equals: (a, b) => a.key === b.key && a.visit === b.visit && a.directory === b.directory },
  );

  ctx.add(ComposerPill, {
    id: "codex-activity",
    show({ session }) {
      const current = snapshot();
      if (!current || current.visit !== session.visit) return;
      const { running, waiting, agents, lastAction } = current.value;
      if (!agents?.length) {
        if (waiting) return { label: "Codex waiting for subagents" };
        if (!Object.hasOwn(agentActions, lastAction)) return;
        return {
          label: running ? "Codex subagent activity" : "Recent Codex subagent activity",
          rows: [{ id: "last-action", label: agentActions[lastAction] }],
        };
      }
      const active = agents.filter(agent => agent.state === "running" || agent.state === "pending_init").length;
      const known = agents.every(agent => agent.state !== "unknown");
      const count = known ? `${active} active` : `${agents.length} reported`;
      return {
        label: running ? `Codex agents: ${count}` : `Codex agents: ${agents.length} recent`,
        title: running ? "Codex subagents" : "Last reported Codex subagent activity",
        rows: agents.map(agent => ({
          id: String(agent.number),
          label: `Agent ${agent.number} · ${agentStates[agent.state] ?? "Unknown"}`,
          detail: agentActions[agent.action],
        })),
      };
    },
  });
}

function when(iso) {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : `resets ${date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
}

function hostLabel(system) {
  const percent = value => Number.isFinite(value) ? `${Math.max(0, Math.min(100, Math.round(value)))}%` : "—";
  const used = (available, total) => Number.isFinite(available) && Number.isFinite(total) && total > 0
    ? percent(100 * (1 - available / total))
    : "—";
  const cpu = percent(system?.cpu?.usedPercent);
  const ram = used(system?.ram?.availableGiB, system?.ram?.totalGiB);
  const disk = used(system?.disk?.freeGiB, system?.disk?.totalGiB);
  return `CPU ${cpu} · RAM ${ram} · DISK ${disk}`;
}

function rows(status) {
  const usage = status.detail?.usage ?? {};
  const system = status.detail?.system;
  const pct = w => (w?.remaining == null ? "?" : `${w.remaining}% left`);
  const list = [
    { id: "claude-5h", label: `Claude 5h: ${pct(usage.claude?.fiveHour)}`, detail: when(usage.claude?.fiveHour?.resetsAt) },
    { id: "claude-7d", label: `Claude 7d: ${pct(usage.claude?.weekly)}`, detail: when(usage.claude?.weekly?.resetsAt) },
    { id: "codex-7d", label: `Codex 7d: ${pct(usage.codex?.weekly)}`, detail: when(usage.codex?.weekly?.resetsAt) },
  ];
  if (system) {
    const g = v => (v == null ? "?" : `${v < 10 ? v.toFixed(1) : Math.round(v)} GiB`);
    list.push(
      { id: "cpu", label: `CPU: ${system.cpu?.usedPercent ?? "?"}%`, detail: `${system.cpu?.cores ?? "?"} cores` },
      { id: "ram", label: `RAM: ${g(system.ram?.availableGiB)} available`, detail: system.ram?.sliceHeadroomGiB == null ? undefined : `slice headroom ${g(system.ram.sliceHeadroomGiB)}` },
      { id: "disk", label: `Disk: ${g(system.disk?.freeGiB)} free`, detail: system.disk?.path },
    );
  }
  for (const [name, message] of Object.entries(usage.errors ?? {})) {
    list.push({ id: `error-${name}`, label: `${name}: unavailable`, detail: message, tone: "warning" });
  }
  return list;
}

const plugin = Plugin.define({
  setup(ctx) {
    if (typeof createKeyed === "function") addActivityPill(ctx);
    const [statuses, setStatuses] = createSignal({});
    const [tick, setTick] = createSignal(0);
    const inflight = new Set();
    const timer = setInterval(() => setTick(t => t + 1), REFRESH_MS);
    ctx.signal?.addEventListener("abort", () => clearInterval(timer), { once: true });

    function refresh(session) {
      const server = session.server;
      const key = `${server.id}\n${session.directory}`;
      if (inflight.has(key)) return;
      inflight.add(key);
      Promise.resolve()
        // Read the live client each time: a restarted server gets a new client under the same id.
        .then(() => server.client.rpc(StatusRpc).read({}, { location: { directory: session.directory }, signal: ctx.signal }))
        .then(result => setStatuses(all => ({ ...all, [key]: { status: result?.output ?? result, at: Date.now() } })))
        .catch(error => setStatuses(all => ({ ...all, [key]: { error: String(error?.message ?? error), at: Date.now() } })))
        .finally(() => inflight.delete(key));
    }

    ctx.add(ComposerPill, {
      id: "status",
      show: input => {
        tick();
        const session = input.session;
        const key = `${session.server.id}\n${session.directory}`;
        const entry = statuses()[key];
        if (!entry || Date.now() - entry.at >= REFRESH_MS) queueMicrotask(() => refresh(session));
        if (!entry) return { label: "Status…", title: "Usage and host load" };
        if (entry.error) {
          return {
            label: "Status unavailable",
            tone: "warning",
            title: "Usage and host load",
            rows: [{ id: "error", label: "Status RPC failed", detail: entry.error, tone: "warning" }],
          };
        }
        const status = entry.status ?? {};
        return {
          label: hostLabel(status.detail?.system),
          tone: status.tone === "danger" || status.tone === "warning" ? status.tone : undefined,
          title: `Usage and load on ${session.server.name ?? session.server.id}`,
          rows: rows(status),
        };
      },
    });
  },
});

Object.defineProperty(exports, "__esModule", { value: true });
exports.default = plugin;
