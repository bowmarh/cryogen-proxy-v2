#!/usr/bin/env node
'use strict';
// Copies the club's data from one Redis to another, for moving to a new database (for example one in an EU region). See docs/REDIS-PROVIDER.md.
//
//   SOURCE_REST_URL=... SOURCE_REST_TOKEN=... TARGET_REST_URL=... TARGET_REST_TOKEN=... node scripts/copy-redis.js --dry-run
//   (or SOURCE_REDIS_URL / TARGET_REDIS_URL for an ordinary Redis over TCP)
//
//   --dry-run     count what would be copied and change nothing
//   (no flag)     copy, leaving any key the target already has
//   --overwrite   copy again and replace keys the target already has (the last sync right before switching over)
//   --verify      compare every source key with the target and list any that differ
//   --prefix X    only keys starting with X (default cg:, every key this app uses)
//
// It only ever reads the source. Credentials come from the environment, never the command line, and are never printed.
const { connect, copy, verify } = require('../lib/redismigrate');

const env = (side, k) => process.env[`${side}_${k}`] || '';
const conn = side => (env(side, 'REDIS_URL') ? { tcpUrl: env(side, 'REDIS_URL') } : { restUrl: env(side, 'REST_URL'), restToken: env(side, 'REST_TOKEN') });
const flag = f => process.argv.includes(f), arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };

(async () => {
  let src, dst;
  try { src = connect(conn('SOURCE')); dst = connect(conn('TARGET')); }
  catch (e) { console.error(`Set SOURCE_REST_URL and SOURCE_REST_TOKEN (or SOURCE_REDIS_URL), and the same for TARGET_. ${e.message}`); process.exit(2); }
  const prefix = arg('--prefix') || 'cg:';
  console.log(`From ${src.label} to ${dst.label}, keys starting "${prefix}"`);
  if (src.label === dst.label) { console.error('The source and the target are the same database. Stopping.'); process.exit(2); }
  if (flag('--verify')) {
    const v = await verify({ src, dst, prefix });
    console.log(`${v.same} of ${v.keys} keys match.${v.differ.length ? ` ${v.differ.length} differ: ${v.differ.slice(0, 20).join(', ')}${v.differ.length > 20 ? ', ...' : ''}` : ' Nothing differs.'}`);
    process.exit(v.differ.length ? 1 : 0);
  }
  const s = await copy({ src, dst, prefix, dryRun: flag('--dry-run'), overwrite: flag('--overwrite'), log: m => process.stdout.write(`\r${m}   `) });
  console.log('');
  console.log(`Keys found: ${s.keys} (${Object.entries(s.byType).map(([t, n]) => `${n} ${t}`).join(', ') || 'none'}); with an expiry: ${s.expiring}.`);
  if (s.targetKeysBefore !== undefined) console.log(`The target already held ${s.targetKeysBefore} keys.`);
  if (s.problems.length) { console.error(s.problems.join('\n')); process.exit(1); }
  if (flag('--dry-run')) console.log('Dry run: nothing was written.');
  else console.log(`Copied ${s.copied}; left ${s.skippedExisting} the target already had. Now run again with --verify.`);
})().catch(e => { console.error('Stopped:', e.message); process.exit(1); });
