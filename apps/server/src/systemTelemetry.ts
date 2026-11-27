import { statfsSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import type { HostTelemetryDTO } from '@mj/shared';

function sampleCpuTimes(): Array<{ idle: number; total: number }> {
  return os.cpus().map((cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    const total = user + nice + sys + idle + irq;
    return { idle, total };
  });
}

async function measureCpuUsagePercent(): Promise<number | null> {
  const start = sampleCpuTimes();
  if (start.length === 0) return null;

  await new Promise((r) => setTimeout(r, 80));
  const end = sampleCpuTimes();

  let idleDelta = 0;
  let totalDelta = 0;

  for (let i = 0; i < Math.min(start.length, end.length); i++) {
    const s = start[i]!;
    const e = end[i]!;
    idleDelta += Math.max(0, e.idle - s.idle);
    totalDelta += Math.max(0, e.total - s.total);
  }

  if (totalDelta <= 0) return null;
  const used = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Number(Math.max(0, Math.min(100, used)).toFixed(1));
}

function readLocalStorageStats(): HostTelemetryDTO['storage'] {
  const mount = resolve(process.cwd()).slice(0, 3) || '/';
  try {
    const stats = statfsSync(process.cwd());
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const availableBytes = Number(stats.bavail) * blockSize;
    if (Number.isFinite(totalBytes) && totalBytes > 0) {
      return [{ mount, totalBytes, availableBytes }];
    }
  } catch {
    // statfs unsupported or restricted
  }
  return [];
}

function hasActiveNetworkInterface(): boolean {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const iface of entries) {
      if (!iface.internal) return true;
    }
  }
  return false;
}

/**
 * Reads genuine host OS telemetry via Node `os` / `fs.statfsSync`.
 * Never fabricates missing metrics (battery requires Tauri Windows Win32 API).
 */
export async function collectHostTelemetry(): Promise<HostTelemetryDTO> {
  const cpus = os.cpus();
  const cpuUsagePercent = await measureCpuUsagePercent();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memPct = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0;

  return {
    source: 'local-windows-host',
    platform: os.platform(),
    osRelease: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || 'Unknown CPU',
    cpuCores: cpus.length,
    cpuUsagePercent,
    memoryTotalBytes: totalMem,
    memoryUsedBytes: usedMem,
    memoryUsagePercent: memPct,
    uptimeSeconds: Math.floor(os.uptime()),
    storage: readLocalStorageStats(),
    battery: null,
    networkConnected: hasActiveNetworkInterface(),
    adminElevated: false,
    collectedAt: new Date().toISOString(),
  };
}
