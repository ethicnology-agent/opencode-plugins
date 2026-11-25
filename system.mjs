// Host load readers for the OpenCode status indicator (Linux /proc and statfs only).
import { readFile, statfs } from "node:fs/promises";
import { cpus } from "node:os";

const GiB = 1024 ** 3;

async function cpuTimes() {
  const line = (await readFile("/proc/stat", "utf8")).split("\n", 1)[0];
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = values[3] + (values[4] ?? 0); // idle + iowait
  return { idle, total: values.reduce((a, b) => a + b, 0) };
}

async function memAvailable() {
  const info = await readFile("/proc/meminfo", "utf8");
  const kB = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? NaN) * 1024;
  return { available: kB("MemAvailable"), total: kB("MemTotal") };
}

async function sliceHeadroom(slice) {
  // cgroup v2 user slice, e.g. melos.slice; returns null when not present.
  const base = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/${slice}`;
  try {
    const [current, max] = await Promise.all(["memory.current", "memory.max"].map(f => readFile(`${base}/${f}`, "utf8")));
    if (max.trim() === "max") return null;
    return Number(max) - Number(current);
  } catch { return null; }
}

// Stateful sampler: CPU usage is the busy share between two consecutive reads.
export function createSystemSampler({ disk = "/", slice = "melos.slice" } = {}) {
  let previous;
  return async function sample() {
    const [times, mem, fs, headroom] = await Promise.all([cpuTimes(), memAvailable(), statfs(disk), sliceHeadroom(slice)]);
    let cpu = null;
    if (previous && times.total > previous.total) {
      cpu = Math.round(100 * (1 - (times.idle - previous.idle) / (times.total - previous.total)));
    }
    previous = times;
    return {
      cpu: { usedPercent: cpu, cores: cpus().length },
      ram: { availableGiB: mem.available / GiB, totalGiB: mem.total / GiB, sliceHeadroomGiB: headroom == null ? null : headroom / GiB },
      disk: { path: disk, freeGiB: (fs.bavail * fs.bsize) / GiB, totalGiB: (fs.blocks * fs.bsize) / GiB },
    };
  };
}

// danger below the 5 GiB host floor, warning below 2x the floor or CPU >= 90%.
export function systemTone(s, floorGiB = 5) {
  const lows = [s.ram.availableGiB, s.disk.freeGiB, s.ram.sliceHeadroomGiB].filter(v => v != null);
  if (lows.some(v => v < floorGiB)) return "danger";
  if (lows.some(v => v < 2 * floorGiB) || (s.cpu.usedPercent ?? 0) >= 90) return "warning";
  return undefined;
}

export function formatSystem(s) {
  const g = v => `${v < 10 ? v.toFixed(1) : Math.round(v)}G`;
  const cpu = s.cpu.usedPercent == null ? "?" : `${s.cpu.usedPercent}%`;
  return `CPU ${cpu} · RAM ${g(s.ram.availableGiB)} free · Disk ${g(s.disk.freeGiB)} free`;
}
