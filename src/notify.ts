import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { Config } from './config.js';

export interface NotifyPayload {
  runId: string;
  failureCount: number;
  collectionsAdded: number;
  productsCreated: number;
  productsUpdated: number;
  productsSkipped: number;
  productsFailed: number;
  durationMs: number;
  summaryPath: string;
  deadLetterPath: string;
  logPath: string;
}

export interface Notifier {
  notify(payload: NotifyPayload): Promise<void>;
}

class NoopNotifier implements Notifier {
  async notify(): Promise<void> {
    // intentionally empty
  }
}

class SlackNotifier implements Notifier {
  constructor(private readonly webhookUrl: string, private readonly logger: Logger) {}
  async notify(p: NotifyPayload): Promise<void> {
    const body = {
      text: this.format(p),
    };
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.logger.error({ status: res.status }, 'slack webhook failed');
      }
    } catch (err) {
      this.logger.error({ err }, 'slack webhook error');
    }
  }
  private format(p: NotifyPayload): string {
    const status = p.failureCount > 0 ? ':warning: FAILURES' : ':white_check_mark: SUCCESS';
    return [
      `*xyz-sync* ${status} — run \`${p.runId}\``,
      `Duration: ${(p.durationMs / 1000).toFixed(1)}s`,
      `Collections added: ${p.collectionsAdded}`,
      `Products: ${p.productsCreated} created, ${p.productsUpdated} updated, ${p.productsSkipped} skipped, ${p.productsFailed} failed`,
      `Summary: ${p.summaryPath}`,
      `Dead-letter: ${p.deadLetterPath}`,
    ].join('\n');
  }
}

class EmailNotifier implements Notifier {
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly cfg: Pick<Config, 'smtpHost' | 'smtpPort' | 'smtpUser' | 'smtpPass' | 'smtpFrom' | 'smtpTo'>,
    private readonly logger: Logger,
  ) {
    if (!cfg.smtpHost || !cfg.smtpFrom || !cfg.smtpTo) {
      throw new Error('SMTP_HOST, SMTP_FROM, SMTP_TO required for email notifier');
    }
    this.transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: cfg.smtpUser && cfg.smtpPass ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    });
  }

  async notify(p: NotifyPayload): Promise<void> {
    const subject =
      p.failureCount > 0
        ? `[xyz-sync] FAILURES — ${p.failureCount} (run ${p.runId})`
        : `[xyz-sync] success — run ${p.runId}`;

    const body = [
      `Run ID:   ${p.runId}`,
      `Duration: ${(p.durationMs / 1000).toFixed(1)}s`,
      '',
      'Collections:',
      `  added:           ${p.collectionsAdded}`,
      '',
      'Products:',
      `  created:  ${p.productsCreated}`,
      `  updated:  ${p.productsUpdated}`,
      `  skipped:  ${p.productsSkipped}`,
      `  failed:   ${p.productsFailed}`,
      '',
      `Summary:     ${p.summaryPath}`,
      `Dead-letter: ${p.deadLetterPath}`,
      `Log:         ${p.logPath}`,
    ].join('\n');

    try {
      await this.transporter.sendMail({
        from: this.cfg.smtpFrom!,
        to: this.cfg.smtpTo!,
        subject,
        text: body,
      });
      this.logger.info({ to: this.cfg.smtpTo }, 'email notification sent');
    } catch (err) {
      this.logger.error({ err }, 'email send failed');
    }
  }
}

export function createNotifier(cfg: Config, logger: Logger): Notifier {
  switch (cfg.notifyChannel) {
    case 'slack':
      if (!cfg.slackWebhookUrl) {
        logger.warn('NOTIFY_CHANNEL=slack but SLACK_WEBHOOK_URL not set — using noop');
        return new NoopNotifier();
      }
      return new SlackNotifier(cfg.slackWebhookUrl, logger);
    case 'email':
      if (!cfg.smtpHost || !cfg.smtpFrom || !cfg.smtpTo) {
        logger.warn('NOTIFY_CHANNEL=email but SMTP config incomplete — using noop');
        return new NoopNotifier();
      }
      return new EmailNotifier(cfg, logger);
    default:
      return new NoopNotifier();
  }
}
