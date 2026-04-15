#!/usr/bin/env node
/**
 * nuggets-memory-pro — CLI
 *
 * Commands:
 *   nuggets-memory-pro login              Authenticate with email + API key
 *   nuggets-memory-pro upgrade [--plan]   Start Stripe checkout flow
 *   nuggets-memory-pro status             Show tier, anchor, store stats
 *   nuggets-memory-pro sync               Cloud sync (Pro)
 *   nuggets-memory-pro audit [--limit N]  Show audit log (Pro)
 *   nuggets-memory-pro nudges             Show nudge queue (Pro)
 *   nuggets-memory-pro logout             Clear credentials
 *   nuggets-memory-pro billing            Open Stripe billing portal
 */

import 'dotenv/config';
import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

import { getAuth } from '../pro/auth.js';
import { getStore } from '../nuggets/memory.js';
import { getAuditLog, reinitAuditLog } from '../nuggets/audit.js';
import { StripeCheckout, PLANS, type PlanKey } from '../pro/stripe.js';
import { CloudSync } from '../pro/cloud.js';
import { NudgeScheduler } from '../pro/nudge.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const banner = () =>
  console.log(
    chalk.bold.cyan('\n  ◆ Nuggets Memory Pro') +
    chalk.gray(' — HRR-powered AI memory\n')
  );

const proRequired = (feature: string) => {
  console.error(
    chalk.red(`\n  ✗ "${feature}" requires Nuggets Memory Pro.\n`) +
    chalk.yellow('  → Run: ') +
    chalk.bold('nuggets-memory-pro upgrade') +
    '\n'
  );
  process.exit(1);
};

function fmtDate(d: Date | null): string {
  return d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A';
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  const remaining = s - m * 60;
  return `${m}m ${remaining}s`;
}

// ─── login ────────────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with your Nuggets Memory Pro account')
  .option('--email <email>', 'Your account email')
  .option('--key <key>', 'Your Nuggets API key')
  .action(async (opts: { email?: string; key?: string }) => {
    banner();
    const { default: inquirer } = await import('inquirer');
    const auth = getAuth();

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'email',
        message: 'Account email:',
        default: opts.email ?? auth.email ?? '',
        validate: (v: string) => v.includes('@') || 'Enter a valid email',
      },
      {
        type: 'password',
        name: 'apiKey',
        message: 'API key (from https://app.nuggets-memory.pro/keys):',
        default: opts.key ?? '',
        validate: (v: string) => v.length > 10 || 'Enter a valid API key',
      },
    ]);

    const spinner = ora('Verifying credentials…').start();
    auth.setCredentials(answers.email as string, answers.apiKey as string);
    const ok = await auth.verify();

    if (ok) {
      spinner.succeed(chalk.green(`Logged in as ${answers.email} (${auth.tier} plan)`));
      reinitAuditLog(true).append({ op: 'login', actor: answers.email as string });
    } else {
      spinner.fail(chalk.red('Authentication failed. Check your API key.'));
      process.exit(1);
    }
  });

// ─── logout ───────────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Clear saved credentials')
  .action(() => {
    banner();
    const auth = getAuth();
    const email = auth.email;
    auth.clear();
    reinitAuditLog(false).append({ op: 'logout', actor: email });
    console.log(chalk.yellow('  Logged out. Memory store remains intact.'));
  });

// ─── upgrade ─────────────────────────────────────────────────────────────────

program
  .command('upgrade')
  .description('Upgrade to Nuggets Memory Pro via Stripe')
  .option('--plan <plan>', 'Plan: individual ($9/mo) or team ($29/mo)', 'individual')
  .action(async (opts: { plan: string }) => {
    banner();
    const auth = getAuth();
    const { default: inquirer } = await import('inquirer');

    // Select plan
    let plan = opts.plan as PlanKey;
    if (!['individual', 'team'].includes(plan)) {
      const ans = await inquirer.prompt([
        {
          type: 'list',
          name: 'plan',
          message: 'Choose a plan:',
          choices: [
            {
              name: `Individual — $9/month\n      ${PLANS.individual.features.join(', ')}`,
              value: 'individual',
            },
            {
              name: `Team — $29/month\n      ${PLANS.team.features.join(', ')}`,
              value: 'team',
            },
          ],
        },
      ]);
      plan = ans.plan as PlanKey;
    }

    console.log(
      chalk.bold(`\n  Plan: ${PLANS[plan].label} — ${PLANS[plan].price}`) +
      chalk.gray('\n  Features:')
    );
    PLANS[plan].features.forEach(f => console.log(chalk.gray(`    • ${f}`)));
    console.log();

    const spinner = ora('Creating checkout session…').start();

    try {
      const checkout = new StripeCheckout(auth);
      const start = Date.now();

      const tier = await checkout.upgrade(
        plan,
        (url) => {
          spinner.text = `Opening browser to complete payment…`;
          console.log(chalk.cyan(`\n  → Checkout URL: ${url}\n`));
          import('open').then(m => m.default(url)).catch(() => {});
          spinner.text = `Waiting for payment confirmation… (${formatElapsed(0)} elapsed)`;
        },
        (elapsed) => {
          spinner.text = `Waiting for payment… (${formatElapsed(elapsed)} elapsed)`;
        }
      );

      spinner.succeed(
        chalk.green(`\n  ✓ Upgraded to ${tier} plan!`) + '\n' +
        chalk.gray('  Your Pro features are now active.\n')
      );
      reinitAuditLog(true).append({ op: 'upgrade', actor: auth.email, meta: { plan, tier } });
    } catch (err: unknown) {
      spinner.fail(chalk.red(`Upgrade failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show subscription tier, memory stats, and anchor hash')
  .action(async () => {
    banner();
    const auth = getAuth();
    const store = getStore();
    const { tier, email, expiresAt, verifiedAt } = auth.statusSummary();

    await auth.verify().catch(() => {});

    const tierColor = tier === 'free' ? chalk.yellow : tier === 'team' ? chalk.cyan : chalk.green;
    const isPro = auth.isPro;

    console.log(chalk.bold('  Subscription'));
    console.log(`  ${chalk.gray('Tier:')}     ${tierColor(tier.toUpperCase())}`);
    console.log(`  ${chalk.gray('Email:')}    ${email ?? chalk.gray('(not logged in)')}`);
    if (isPro) {
      console.log(`  ${chalk.gray('Expires:')}  ${fmtDate(expiresAt)}`);
      console.log(`  ${chalk.gray('Verified:')} ${fmtDate(verifiedAt)}`);
    }

    console.log(chalk.bold('\n  Memory Store'));
    console.log(`  ${chalk.gray('Slots:')}   ${store.size}`);
    console.log(`  ${chalk.gray('Anchor:')}  ${chalk.dim(store.anchor)}`);

    if (isPro) {
      const audit = getAuditLog(true);
      const { total, byOp } = audit.summary();
      console.log(chalk.bold('\n  Audit Log'));
      console.log(`  ${chalk.gray('Total events:')} ${total}`);
      const topOps = Object.entries(byOp)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);
      for (const [op, count] of topOps) {
        console.log(`  ${chalk.gray(op + ':')} ${count}`);
      }
    } else {
      console.log(
        chalk.gray('\n  → Upgrade for cloud sync, audit logs, and nudges:') +
        chalk.bold(' nuggets-memory-pro upgrade\n')
      );
    }
  });

// ─── sync ─────────────────────────────────────────────────────────────────────

program
  .command('sync')
  .description('[PRO] Sync local memory with cloud')
  .action(async () => {
    banner();
    const auth = getAuth();
    if (!auth.isPro) proRequired('sync');

    const store = getStore();
    const audit = getAuditLog(true);
    const cloud = new CloudSync(store, auth, audit);

    const spinner = ora('Syncing memory with cloud…').start();
    try {
      const result = await cloud.sync();
      spinner.succeed(
        chalk.green('Sync complete') +
        chalk.gray(` — pushed ${result.pushed}, pulled ${result.pulled} slots`)
      );
    } catch (err: unknown) {
      spinner.fail(chalk.red(`Sync failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ─── audit ────────────────────────────────────────────────────────────────────

program
  .command('audit')
  .description('[PRO] Show recent audit log events')
  .option('--limit <n>', 'Number of events to show', '20')
  .action((opts: { limit: string }) => {
    banner();
    const auth = getAuth();
    if (!auth.isPro) proRequired('audit');

    const limit = parseInt(opts.limit, 10);
    const events = getAuditLog(true).recent(limit);

    if (events.length === 0) {
      console.log(chalk.gray('  No audit events yet.'));
      return;
    }

    console.log(chalk.bold(`  Last ${events.length} events:\n`));
    for (const e of events) {
      const ts = new Date(e.ts).toLocaleTimeString();
      console.log(
        `  ${chalk.gray(ts)}  ${chalk.cyan(e.op.padEnd(20))}` +
        (e.key ? chalk.white(` key=${e.key}`) : '') +
        (e.anchor ? chalk.dim(` [${e.anchor.slice(0, 8)}]`) : '')
      );
    }
    console.log();
  });

// ─── nudges ───────────────────────────────────────────────────────────────────

program
  .command('nudges')
  .description('[PRO] Show proactive nudge queue')
  .action(() => {
    banner();
    const auth = getAuth();
    if (!auth.isPro) proRequired('nudges');

    const store = getStore();
    const audit = getAuditLog(true);
    const scheduler = new NudgeScheduler(store, audit);
    const due = scheduler.getDueNudges();

    console.log(chalk.bold(`  Nudge Queue (${due.length} due)\n`));

    if (due.length === 0) {
      console.log(chalk.gray('  No nudges due right now.\n'));
      return;
    }

    console.log(scheduler.formatNudges(due));
    console.log();
  });

// ─── billing ──────────────────────────────────────────────────────────────────

program
  .command('billing')
  .description('[PRO] Open Stripe billing portal to manage subscription')
  .action(async () => {
    banner();
    const auth = getAuth();
    if (!auth.isPro) proRequired('billing');

    const spinner = ora('Opening billing portal…').start();
    try {
      const checkout = new StripeCheckout(auth);
      const url = await checkout.manageBilling();
      spinner.succeed(chalk.green('Billing portal opened'));
      console.log(chalk.cyan(`  → ${url}`));
      const { default: open } = await import('open');
      await open(url);
    } catch (err: unknown) {
      spinner.fail(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ─── Main ─────────────────────────────────────────────────────────────────────

program
  .name('nuggets-memory-pro')
  .description('Freemium AI memory plugin — HRR-powered, Claude-native')
  .version('1.0.0')
  .parse(process.argv);

if (!process.argv.slice(2).length) {
  banner();
  program.outputHelp();
}
