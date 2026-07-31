#!/usr/bin/env node
/**
 * Feature flag management CLI.
 *
 * There's no platform-level admin auth in the app yet (only org-scoped
 * admins), so global flag creation/toggling is deliberately kept out of
 * the HTTP API and run instead as a script against the DB directly —
 * same trust model as the deployment scripts in scripts/, whoever can
 * run this already has DB access.
 *
 * Usage:
 *   node scripts/manage-feature-flags.js list
 *   node scripts/manage-feature-flags.js create <key> --description "..." [--enabled]
 *   node scripts/manage-feature-flags.js enable <key>
 *   node scripts/manage-feature-flags.js disable <key>
 *   node scripts/manage-feature-flags.js delete <key>
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--description') { out.description = args[++i]; }
    else if (args[i] === '--enabled') { out.enabled = true; }
    else { out._.push(args[i]); }
  }
  return out;
}

async function list() {
  const flags = await prisma.featureFlag.findMany({
    orderBy: { key: 'asc' },
    include: { _count: { select: { organisationOverrides: true } } },
  });
  if (flags.length === 0) {
    console.log('No feature flags defined yet.');
    return;
  }
  for (const f of flags) {
    console.log(
      `${f.enabled ? '✅' : '⬜'} ${f.key.padEnd(30)} ` +
      `${f.description || '(no description)'} ` +
      `[${f._count.organisationOverrides} org override(s)]`
    );
  }
}

async function create(key, { description, enabled }) {
  if (!key) throw new Error('Usage: create <key> [--description "..."] [--enabled]');
  const flag = await prisma.featureFlag.create({
    data: { key, description: description || null, enabled: Boolean(enabled) },
  });
  console.log(`Created flag "${flag.key}" (enabled: ${flag.enabled})`);
}

async function setEnabled(key, enabled) {
  if (!key) throw new Error('Usage: enable|disable <key>');
  const flag = await prisma.featureFlag.update({
    where: { key },
    data: { enabled },
  });
  console.log(`"${flag.key}" is now ${flag.enabled ? 'ENABLED' : 'DISABLED'} globally.`);
  console.log('Note: takes effect within ~10s (cache TTL), no restart needed.');
}

async function remove(key) {
  if (!key) throw new Error('Usage: delete <key>');
  await prisma.featureFlag.delete({ where: { key } });
  console.log(`Deleted flag "${key}" (and any org overrides for it, via cascade).`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const { _, description, enabled } = parseFlags(rest);

  switch (command) {
    case 'list':    return list();
    case 'create':  return create(_[0], { description, enabled });
    case 'enable':  return setEnabled(_[0], true);
    case 'disable': return setEnabled(_[0], false);
    case 'delete':  return remove(_[0]);
    default:
      console.log('Usage: node scripts/manage-feature-flags.js <list|create|enable|disable|delete> [args]');
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
