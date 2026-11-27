import net from 'node:net';
import tls from 'node:tls';
import {
  sanitizeDiagnosticText,
  type AlertEventReason,
  type AlertingStatusDTO,
  type BudgetStatusSummary,
} from '@mj/shared';

export interface AlertingConfig {
  appEnv: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  resendApiKey?: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  emailFrom?: string;
  emailTo?: string;
  errorRateThresholdPct: number;
  minSampleRequests: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

export interface EmailDispatchPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export interface OutcomeSample {
  ts: number;
  ok: boolean;
  code?: string;
}

export interface PersistedAlertMonitorState {
  samples: OutcomeSample[];
  lastReasonAlertAtMs: Partial<Record<AlertEventReason, number>>;
  lastAlertAt: string | null;
  lastAlertReason: AlertEventReason | null;
  lastDeliveryStatus: AlertingStatusDTO['lastDeliveryStatus'];
  alertsSentCount: number;
}

export interface AlertMonitorStateStore {
  load: () => Promise<PersistedAlertMonitorState | null>;
  save: (state: PersistedAlertMonitorState) => Promise<void>;
}

export interface AlertMonitorOptions {
  fetchImpl?: typeof fetch;
  sendSmtpEmailImpl?: (config: AlertingConfig, payload: EmailDispatchPayload) => Promise<void>;
  stateStore?: AlertMonitorStateStore;
  nowMs?: () => number;
  onLog?: (message: string) => void;
}

const REASON_TITLES: Record<AlertEventReason, string> = {
  crash: 'MJ Assistant Backend Crash / Fatal Error',
  high_error_rate: 'MJ Assistant High API Error Rate',
  uptime_down: 'MJ Assistant Health / Database Degraded',
  daily_budget_exceeded: 'MJ Assistant Daily Spend Budget Crossed',
};

function sanitizeAlertText(text: string): string {
  return sanitizeDiagnosticText(text).slice(0, 1200);
}

async function readSmtpResponse(socket: net.Socket | tls.TLSSocket): Promise<{ code: number; line: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      // Multi-line SMTP response continues with `XXX-` and terminates on `XXX `
      if (last && /^\d{3}\s/.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), line: last });
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error('SMTP socket timed out'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
  });
}

async function sendSmtpCommand(
  socket: net.Socket | tls.TLSSocket,
  command: string,
  expectedCodes: number[],
): Promise<void> {
  socket.write(`${command}\r\n`);
  const res = await readSmtpResponse(socket);
  if (!expectedCodes.includes(res.code)) {
    throw new Error(`SMTP command failed with code ${res.code}`);
  }
}

export async function sendEmailViaSmtp(
  config: AlertingConfig,
  payload: EmailDispatchPayload,
): Promise<void> {
  if (!config.smtpHost) {
    throw new Error('SMTP host not configured');
  }

  let socket: net.Socket | tls.TLSSocket = config.smtpSecure
    ? tls.connect({ host: config.smtpHost, port: config.smtpPort, servername: config.smtpHost })
    : net.connect({ host: config.smtpHost, port: config.smtpPort });

  socket.setTimeout(10_000);

  try {
    await new Promise<void>((resolve, reject) => {
      const event = config.smtpSecure ? 'secureConnect' : 'connect';
      socket.once(event, () => resolve());
      socket.once('error', reject);
    });

    const greeting = await readSmtpResponse(socket);
    if (greeting.code !== 220) {
      throw new Error(`Unexpected SMTP greeting ${greeting.code}`);
    }

    await sendSmtpCommand(socket, 'EHLO mj-assistant.local', [250]);

    if (!config.smtpSecure && config.smtpPort === 587) {
      await sendSmtpCommand(socket, 'STARTTLS', [220]);
      socket = tls.connect({ socket, servername: config.smtpHost });
      socket.setTimeout(10_000);
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', () => resolve());
        socket.once('error', reject);
      });
      await sendSmtpCommand(socket, 'EHLO mj-assistant.local', [250]);
    }

    if (config.smtpUser && config.smtpPass) {
      const plainToken = Buffer.from(`\u0000${config.smtpUser}\u0000${config.smtpPass}`).toString(
        'base64',
      );
      await sendSmtpCommand(socket, `AUTH PLAIN ${plainToken}`, [235]);
    }

    await sendSmtpCommand(socket, `MAIL FROM:<${payload.from}>`, [250]);
    for (const recipient of payload.to) {
      await sendSmtpCommand(socket, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await sendSmtpCommand(socket, 'DATA', [354]);

    const safeBody = payload.text
      .split(/\r?\n/)
      .map((line) => (line.startsWith('.') ? `.${line}` : line))
      .join('\r\n');

    const rawMessage = [
      `From: <${payload.from}>`,
      `To: ${payload.to.map((r) => `<${r}>`).join(', ')}`,
      `Subject: ${payload.subject.replace(/[\r\n]+/g, ' ')}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      safeBody,
      '.',
    ].join('\r\n');

    await sendSmtpCommand(socket, rawMessage, [250]);
    await sendSmtpCommand(socket, 'QUIT', [221]).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

export class AlertMonitor {
  private readonly samples: OutcomeSample[] = [];
  private readonly lastReasonAlertAtMs = new Map<AlertEventReason, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly sendSmtpEmailImpl: (
    config: AlertingConfig,
    payload: EmailDispatchPayload,
  ) => Promise<void>;
  private readonly stateStore?: AlertMonitorStateStore;
  private readonly nowMs: () => number;
  private readonly onLog: (message: string) => void;
  private persistChain: Promise<void> = Promise.resolve();

  private lastAlertAt: string | null = null;
  private lastAlertReason: AlertEventReason | null = null;
  private lastDeliveryStatus: AlertingStatusDTO['lastDeliveryStatus'] = 'idle';
  private alertsSentCount = 0;

  constructor(
    private readonly config: AlertingConfig,
    options: AlertMonitorOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sendSmtpEmailImpl = options.sendSmtpEmailImpl ?? sendEmailViaSmtp;
    this.stateStore = options.stateStore;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.onLog = options.onLog ?? ((msg) => console.warn(msg));
  }

  public async hydrate(): Promise<void> {
    if (!this.stateStore) return;
    try {
      const saved = await this.stateStore.load();
      if (!saved) return;

      const now = this.nowMs();
      this.samples.length = 0;
      if (Array.isArray(saved.samples)) {
        for (const s of saved.samples) {
          if (s && typeof s.ts === 'number' && typeof s.ok === 'boolean') {
            this.samples.push({ ts: s.ts, ok: s.ok, ...(s.code ? { code: s.code } : {}) });
          }
        }
      }
      this.pruneWindow(now);

      this.lastReasonAlertAtMs.clear();
      if (saved.lastReasonAlertAtMs && typeof saved.lastReasonAlertAtMs === 'object') {
        for (const [reason, ts] of Object.entries(saved.lastReasonAlertAtMs)) {
          if (typeof ts === 'number' && Number.isFinite(ts)) {
            this.lastReasonAlertAtMs.set(reason as AlertEventReason, ts);
          }
        }
      }

      if (typeof saved.lastAlertAt === 'string' || saved.lastAlertAt === null) {
        this.lastAlertAt = saved.lastAlertAt;
      }
      if (saved.lastAlertReason !== undefined) {
        this.lastAlertReason = saved.lastAlertReason;
      }
      if (saved.lastDeliveryStatus) {
        this.lastDeliveryStatus = saved.lastDeliveryStatus;
      }
      if (typeof saved.alertsSentCount === 'number' && Number.isFinite(saved.alertsSentCount)) {
        this.alertsSentCount = saved.alertsSentCount;
      }
    } catch {
      // ignore hydration failures and start cleanly
    }
  }

  private snapshotState(): PersistedAlertMonitorState {
    const cooldowns: Partial<Record<AlertEventReason, number>> = {};
    for (const [reason, ts] of this.lastReasonAlertAtMs.entries()) {
      cooldowns[reason] = ts;
    }
    return {
      samples: this.samples.map((s) => ({ ...s })),
      lastReasonAlertAtMs: cooldowns,
      lastAlertAt: this.lastAlertAt,
      lastAlertReason: this.lastAlertReason,
      lastDeliveryStatus: this.lastDeliveryStatus,
      alertsSentCount: this.alertsSentCount,
    };
  }

  private schedulePersist(): void {
    if (!this.stateStore) return;
    const store = this.stateStore;
    const snapshot = this.snapshotState();
    this.persistChain = this.persistChain
      .then(() => store.save(snapshot))
      .catch(() => undefined);
  }

  public async flushPersistence(): Promise<void> {
    await this.persistChain;
  }

  public isTelegramConfigured(): boolean {
    return Boolean(this.config.telegramBotToken && this.config.telegramChatId);
  }

  public isEmailConfigured(): boolean {
    const hasRecipients = Boolean(this.config.emailFrom && this.getEmailRecipients().length > 0);
    if (!hasRecipients) return false;
    return Boolean(this.config.resendApiKey || this.config.smtpHost);
  }

  private getEmailRecipients(): string[] {
    return (this.config.emailTo ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.includes('@'));
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.config.windowMinutes * 60_000;
    while (this.samples.length > 0 && this.samples[0]!.ts < cutoff) {
      this.samples.shift();
    }
  }

  private canTrigger(reason: AlertEventReason, now: number): boolean {
    const lastTs = this.lastReasonAlertAtMs.get(reason);
    if (lastTs === undefined) return true;
    const cooldownMs =
      reason === 'crash'
        ? Math.min(this.config.cooldownMinutes, 5) * 60_000
        : this.config.cooldownMinutes * 60_000;
    return now - lastTs >= cooldownMs;
  }

  public getStatus(): AlertingStatusDTO {
    const now = this.nowMs();
    this.pruneWindow(now);
    const total = this.samples.length;
    const errors = this.samples.filter((s) => !s.ok).length;
    const errorRatePct = total > 0 ? Number(((errors / total) * 100).toFixed(1)) : 0;

    return {
      emailConfigured: this.isEmailConfigured(),
      telegramConfigured: this.isTelegramConfigured(),
      errorRateThresholdPct: this.config.errorRateThresholdPct,
      minSampleRequests: this.config.minSampleRequests,
      windowMinutes: this.config.windowMinutes,
      currentWindowRequests: total,
      currentWindowErrors: errors,
      currentErrorRatePct: errorRatePct,
      cooldownMinutes: this.config.cooldownMinutes,
      lastAlertAt: this.lastAlertAt,
      lastAlertReason: this.lastAlertReason,
      lastDeliveryStatus: this.lastDeliveryStatus,
      alertsSentCount: this.alertsSentCount,
    };
  }

  public async recordApiOutcome(entry: {
    ok: boolean;
    code?: string;
    expectedFailover?: boolean;
  }): Promise<void> {
    // Expected auto-failover (e.g. Gemini quota exhausted -> Ollama/Groq) must not pollute error-rate alerts.
    if (!entry.ok && entry.expectedFailover) {
      return;
    }

    const now = this.nowMs();
    this.samples.push({ ts: now, ok: entry.ok, code: entry.code });
    this.pruneWindow(now);
    this.schedulePersist();

    if (entry.ok) return;

    const total = this.samples.length;
    const errors = this.samples.filter((s) => !s.ok).length;
    const errorRatePct = total > 0 ? (errors / total) * 100 : 0;

    if (
      total >= this.config.minSampleRequests &&
      errorRatePct >= this.config.errorRateThresholdPct
    ) {
      const recentCodes = Array.from(
        new Set(
          this.samples
            .filter((s) => !s.ok && s.code)
            .map((s) => sanitizeDiagnosticText(s.code!)),
        ),
      ).slice(0, 5);

      await this.dispatchAlert(
        'high_error_rate',
        [
          `API error rate reached ${errorRatePct.toFixed(1)}% (${errors}/${total} failed in last ${this.config.windowMinutes}m, threshold ${this.config.errorRateThresholdPct}%).`,
          recentCodes.length > 0 ? `Recent codes: ${recentCodes.join(', ')}` : 'Recent codes: UPSTREAM_ERROR',
        ].join('\n'),
      );
    }
  }

  public async notifyCrash(sourceLabel: string, error: unknown): Promise<void> {
    const rawDetail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : typeof error === 'string'
          ? error
          : 'Unexpected process error';

    await this.dispatchAlert(
      'crash',
      `Crash/fatal error captured in ${sourceLabel}.\nDetail: ${sanitizeAlertText(rawDetail)}`,
    );
  }

  public async notifyUptimeDegraded(reason: string): Promise<void> {
    await this.dispatchAlert(
      'uptime_down',
      `Health monitor reported degraded availability.\nDetail: ${sanitizeAlertText(reason)}`,
    );
  }

  public async notifyDailyBudgetCrossed(budgetStatus: BudgetStatusSummary): Promise<void> {
    if (budgetStatus.dailyLevel !== 'daily_cap_exceeded') return;
    const cap = budgetStatus.dailyCapUsd ?? 0;
    await this.dispatchAlert(
      'daily_budget_exceeded',
      `Daily estimated spend ($${budgetStatus.dailySpendUsd.toFixed(4)}) crossed daily budget ($${cap.toFixed(2)}).`,
    );
  }

  private async dispatchAlert(reason: AlertEventReason, detailBody: string): Promise<void> {
    const now = this.nowMs();
    if (!this.canTrigger(reason, now)) {
      return;
    }

    const emailEnabled = this.isEmailConfigured();
    const telegramEnabled = this.isTelegramConfigured();
    if (!emailEnabled && !telegramEnabled) {
      return;
    }

    this.lastReasonAlertAtMs.set(reason, now);
    const timestamp = new Date(now).toISOString();
    const subject = `[MJ Alert] ${REASON_TITLES[reason]} (${this.config.appEnv})`;
    const text = sanitizeAlertText(
      [
        subject,
        `Time: ${timestamp}`,
        `Environment: ${this.config.appEnv}`,
        '',
        detailBody,
        '',
        'Note: Logs and alerts exclude API keys, cookies, credentials, and prompt contents.',
      ].join('\n'),
    );

    const results: Array<{ channel: 'telegram' | 'email'; ok: boolean }> = [];

    if (telegramEnabled) {
      const ok = await this.sendTelegram(text);
      results.push({ channel: 'telegram', ok });
    }

    if (emailEnabled) {
      const ok = await this.sendEmail(subject, text);
      results.push({ channel: 'email', ok });
    }

    const succeeded = results.filter((r) => r.ok).length;
    this.lastAlertAt = timestamp;
    this.lastAlertReason = reason;
    if (succeeded === results.length) {
      this.lastDeliveryStatus = 'sent';
      this.alertsSentCount += 1;
    } else if (succeeded > 0) {
      this.lastDeliveryStatus = 'partial_failure';
      this.alertsSentCount += 1;
    } else {
      this.lastDeliveryStatus = 'failed';
    }
    this.schedulePersist();
  }

  private async sendTelegram(messageText: string): Promise<boolean> {
    const token = this.config.telegramBotToken;
    const chatId = this.config.telegramChatId;
    if (!token || !chatId) return false;

    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: messageText,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        this.onLog(`[MJ Alert] Telegram delivery failed (status=${res.status}).`);
        return false;
      }
      return true;
    } catch {
      this.onLog('[MJ Alert] Telegram delivery network failure.');
      return false;
    }
  }

  private async sendEmail(subject: string, text: string): Promise<boolean> {
    const from = this.config.emailFrom;
    const to = this.getEmailRecipients();
    if (!from || to.length === 0) return false;

    if (this.config.resendApiKey) {
      try {
        const res = await this.fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.resendApiKey}`,
          },
          body: JSON.stringify({ from, to, subject, text }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          this.onLog(`[MJ Alert] Email delivery via Resend failed (status=${res.status}).`);
          return false;
        }
        return true;
      } catch {
        this.onLog('[MJ Alert] Email delivery via Resend network failure.');
        return false;
      }
    }

    if (this.config.smtpHost) {
      try {
        await this.sendSmtpEmailImpl(this.config, { from, to, subject, text });
        return true;
      } catch (err) {
        const detail = err instanceof Error ? sanitizeDiagnosticText(err.message) : 'SMTP error';
        this.onLog(`[MJ Alert] SMTP email delivery failed: ${detail}`);
        return false;
      }
    }

    return false;
  }
}
