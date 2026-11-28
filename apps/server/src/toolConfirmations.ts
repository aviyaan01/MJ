import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TOOL_CONFIRMATION_TIMEOUT_MS,
  parseVoiceConfirmationDecision,
  type PendingToolConfirmationDTO,
} from '@mj/shared';
import type { ToolConfirmDecision, ToolExecutionResult } from '@mj/ai';

interface WaitablePendingEntry {
  kind: 'waitable';
  dto: PendingToolConfirmationDTO;
  resolve: (decision: ToolConfirmDecision) => void;
  timer: NodeJS.Timeout;
}

interface ActionPendingEntry {
  kind: 'action';
  dto: PendingToolConfirmationDTO;
  executeOnApprove: () => Promise<ToolExecutionResult>;
  onCancelAudit: (timedOut: boolean) => Promise<void>;
  timer: NodeJS.Timeout;
}

type PendingEntry = WaitablePendingEntry | ActionPendingEntry;

export type ResolveConfirmationResult =
  | {
      resolved: true;
      mode: 'waitable';
      decision: 'approved' | 'cancelled';
      dto: PendingToolConfirmationDTO;
    }
  | {
      resolved: true;
      mode: 'action';
      decision: 'approved' | 'cancelled';
      dto: PendingToolConfirmationDTO;
      execution: ToolExecutionResult;
    }
  | {
      resolved: false;
      status: 'unrecognized_voice_reply';
      dto: PendingToolConfirmationDTO;
    }
  | {
      resolved: false;
      status: 'timed_out';
    }
  | {
      resolved: false;
      status: 'not_found';
    };

/**
 * Tracks pending user confirmations for `confirm`-risk AI tools with a strict
 * 20-second timeout (configurable for deterministic testing).
 */
export class ToolConfirmationManager {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timedOutTombstones = new Map<string, number>();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_CONFIRMATION_TIMEOUT_MS;
  }

  public getTimeoutMs(): number {
    return this.timeoutMs;
  }

  private pruneTombstones(nowMs = Date.now()): void {
    for (const [id, expiresAtMs] of this.timedOutTombstones.entries()) {
      if (expiresAtMs <= nowMs) {
        this.timedOutTombstones.delete(id);
      }
    }
  }

  private buildDto(params: {
    toolName: string;
    args: Record<string, unknown>;
    summary: string;
    requiredPermission: string;
    conversationId?: string;
    channel: 'chat' | 'voice';
    callId?: string;
  }): PendingToolConfirmationDTO {
    const nowMs = Date.now();
    return {
      confirmationId: randomUUID(),
      toolName: params.toolName,
      args: params.args,
      summary: params.summary,
      requiredPermission: params.requiredPermission,
      ...(params.conversationId ? { conversationId: params.conversationId } : {}),
      channel: params.channel,
      ...(params.callId ? { callId: params.callId } : {}),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.timeoutMs).toISOString(),
      timeoutSeconds: Math.max(1, Math.round(this.timeoutMs / 1000)),
    };
  }

  public createWaitablePending(params: {
    toolName: string;
    args: Record<string, unknown>;
    summary: string;
    requiredPermission: string;
    conversationId?: string;
    channel: 'chat' | 'voice';
    callId?: string;
  }): {
    dto: PendingToolConfirmationDTO;
    waitForDecision: () => Promise<ToolConfirmDecision>;
    cancelSilently: () => void;
  } {
    const dto = this.buildDto(params);
    let resolveFn: (decision: ToolConfirmDecision) => void = () => {};
    let settled = false;

    const promise = new Promise<ToolConfirmDecision>((resolve) => {
      resolveFn = resolve;
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.pending.delete(dto.confirmationId);
      this.timedOutTombstones.set(dto.confirmationId, Date.now() + 60_000);
      this.pruneTombstones();
      resolveFn('timed_out');
    }, this.timeoutMs);
    timer.unref();

    const entry: WaitablePendingEntry = {
      kind: 'waitable',
      dto,
      resolve: (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(dto.confirmationId);
        resolveFn(decision);
      },
      timer,
    };

    this.pending.set(dto.confirmationId, entry);

    return {
      dto,
      waitForDecision: () => promise,
      cancelSilently: () => {
        if (settled) return;
        entry.resolve('cancelled');
      },
    };
  }

  public createActionPending(params: {
    toolName: string;
    args: Record<string, unknown>;
    summary: string;
    requiredPermission: string;
    conversationId?: string;
    channel: 'chat' | 'voice';
    callId?: string;
    executeOnApprove: () => Promise<ToolExecutionResult>;
    onCancelAudit: (timedOut: boolean) => Promise<void>;
  }): PendingToolConfirmationDTO {
    const dto = this.buildDto(params);

    const timer = setTimeout(() => {
      if (!this.pending.has(dto.confirmationId)) return;
      this.pending.delete(dto.confirmationId);
      this.timedOutTombstones.set(dto.confirmationId, Date.now() + 60_000);
      this.pruneTombstones();
      void params.onCancelAudit(true).catch(() => {});
    }, this.timeoutMs);
    timer.unref();

    this.pending.set(dto.confirmationId, {
      kind: 'action',
      dto,
      executeOnApprove: params.executeOnApprove,
      onCancelAudit: params.onCancelAudit,
      timer,
    });

    return dto;
  }

  public async resolveConfirmation(params: {
    confirmationId: string;
    decision?: 'approve' | 'cancel';
    spokenText?: string;
  }): Promise<ResolveConfirmationResult> {
    this.pruneTombstones();
    const entry = this.pending.get(params.confirmationId);
    if (!entry) {
      if (this.timedOutTombstones.has(params.confirmationId)) {
        return { resolved: false, status: 'timed_out' };
      }
      return { resolved: false, status: 'not_found' };
    }

    let chosenDecision: 'approve' | 'cancel' | null = params.decision ?? null;
    if (!chosenDecision && params.spokenText) {
      chosenDecision = parseVoiceConfirmationDecision(params.spokenText);
    }

    if (!chosenDecision) {
      return {
        resolved: false,
        status: 'unrecognized_voice_reply',
        dto: entry.dto,
      };
    }

    clearTimeout(entry.timer);
    this.pending.delete(params.confirmationId);

    if (entry.kind === 'waitable') {
      const waitableDecision = chosenDecision === 'approve' ? 'approved' : 'cancelled';
      entry.resolve(waitableDecision);
      return {
        resolved: true,
        mode: 'waitable',
        decision: waitableDecision,
        dto: entry.dto,
      };
    }

    if (chosenDecision === 'cancel') {
      await entry.onCancelAudit(false);
      return {
        resolved: true,
        mode: 'action',
        decision: 'cancelled',
        dto: entry.dto,
        execution: {
          ok: false,
          toolName: entry.dto.toolName,
          status: 'cancelled',
          error: `User cancelled confirmation for "${entry.dto.toolName}".`,
        },
      };
    }

    const execution = await entry.executeOnApprove();
    return {
      resolved: true,
      mode: 'action',
      decision: 'approved',
      dto: entry.dto,
      execution,
    };
  }

  public cancelByCallId(callId: string): boolean {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.dto.callId === callId) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if (entry.kind === 'waitable') {
          entry.resolve('cancelled');
        } else {
          void entry.onCancelAudit(false).catch(() => {});
        }
        return true;
      }
    }
    return false;
  }

  public listPending(): PendingToolConfirmationDTO[] {
    return Array.from(this.pending.values()).map((entry) => entry.dto);
  }

  public clearAll(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      if (entry.kind === 'waitable') {
        entry.resolve('cancelled');
      }
    }
    this.pending.clear();
    this.timedOutTombstones.clear();
  }
}
