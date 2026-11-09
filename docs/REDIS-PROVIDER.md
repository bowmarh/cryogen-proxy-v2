# Running on a different Redis

By default the app talks to Upstash over its REST API (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`).

It can run on any ordinary Redis instead, such as Redis Cloud or a server you run yourself, over a normal TCP connection:

1. Set `REDIS_URL` in Vercel, for example `rediss://default:PASSWORD@host:PORT` (`rediss` for TLS, `redis` for plain). When it is set it wins over the Upstash settings.
2. Redeploy. Nothing else changes: the same commands go out, in one round trip per request, and the answers have the same shape.

Things to check before you switch:

- **Size.** Look at the database size in the Upstash console. A free 30 MB plan is only enough if the data is well under that. The daily backup copies are stored in Redis too.
- **Connections.** Each request opens one short connection and closes it. Check the plan's connection limit against how many requests can run at once.
- **Latency.** Pick a region near Vercel's function region.
- **Moving the data.** Nothing copies it for you. Export from Upstash (RDB or `redis-cli --scan` and `DUMP`/`RESTORE`) and import into the new database before switching, or the app starts empty. Keep the Upstash settings in place so you can switch back by removing `REDIS_URL`.

The health panel's "Shared storage" row reports whether the app can reach whichever Redis is in use.
