# Running on a different Redis

By default the app talks to Upstash over its REST API (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`).

It can run on any ordinary Redis instead, such as Redis Cloud or a server you run yourself, over a normal TCP connection:

1. Set `REDIS_URL` in Vercel, for example `rediss://default:PASSWORD@host:PORT` (`rediss` for TLS, `redis` for plain), and set `REDIS_PREFER_TCP=1`. Without `REDIS_PREFER_TCP`, `REDIS_URL` is only used when there are no Upstash REST settings: the Vercel Upstash integration adds a `REDIS_URL` of its own, and that must not take over by accident.
2. Redeploy. Nothing else changes: the same commands go out, in one round trip per request, and the answers have the same shape.

Things to check before you switch:

- **Size.** Look at the database size in the Upstash console. A free 30 MB plan is only enough if the data is well under that. The daily backup copies are stored in Redis too.
- **Connections.** Each request opens one short connection and closes it. Check the plan's connection limit against how many requests can run at once.
- **Latency.** Pick a region near Vercel's function region.
- **Moving the data.** Nothing copies it for you. Export from Upstash (RDB or `redis-cli --scan` and `DUMP`/`RESTORE`) and import into the new database before switching, or the app starts empty. Keep the Upstash settings in place so you can switch back by removing `REDIS_URL`.

The health panel's "Shared storage" row reports whether the app can reach whichever Redis is in use.

## Moving the club's data to a new database (for example one in an EU region)

The app's Upstash database was created in a US region while the app runs in Europe, so every request crosses the Atlantic. A new database in an EU region is faster. The copy tool moves everything; it only ever reads the old database.

1. **Create the new database** in the Upstash console (Pay as You Go, an EU region, no Prod Pack, a monthly budget). Copy its REST URL and REST token.
2. **Make sure the old database can be read.** It must not be at its free limit (upgrade it to Pay as You Go first).
3. **Run on your own computer** (Node 20 or newer, this repository checked out). Put the four values in your terminal session, not in a file or a chat:
   ```
   export SOURCE_REST_URL=...   SOURCE_REST_TOKEN=...      # the old database (the Vercel integration's KV_REST_API_URL and token)
   export TARGET_REST_URL=...   TARGET_REST_TOKEN=...      # the new one
   node scripts/copy-redis.js --dry-run     # counts what would be copied, writes nothing
   node scripts/copy-redis.js               # copies; leaves any key the target already has
   node scripts/copy-redis.js --verify      # compares every key; lists any that differ
   ```
4. **Switch over at a quiet time.** Run `node scripts/copy-redis.js --overwrite` once more (a final sync of anything that changed), then `--verify`. In Vercel add two environment variables to the Production environment, `REDIS_REST_URL` and `REDIS_REST_TOKEN`, set to the new database, and redeploy. They win over the integration's own `KV_REST_API_*` settings, which you cannot edit.
5. **Check it.** Admin → System health → **Check now**: the "Shared storage" row names the database it is using. Anything written to the old database between the final sync and the redeploy is not in the new one, so keep that window short.
6. **Roll back** by deleting `REDIS_REST_URL` and `REDIS_REST_TOKEN` and redeploying: the app is back on the old database, which still has everything. Keep the old database for a week or two, then delete it.

The tool copies hashes, strings and lists with their expiry times (the types this app uses). If it finds any other type it stops before writing anything and tells you which key.
