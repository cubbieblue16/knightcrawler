# KnightCrawler VPS Deploy Runbook

Target: Debian 12 VPS at 74.117.196.240, Docker 29, Cloudflared already wired.

## 1. Push fork to trigger GHCR build

```sh
git push origin main
```

That triggers all 10 service build workflows. Confirm at
https://github.com/cubbieblue16/knightcrawler/actions

Watch for green checks on:
- Build and Push Addon Service
- Build and Push Producer Service
- Build and Push Consumer Service
- Build and Push Debrid Collector Service
- Build and Push Metadata Service
- Build and Push Migrator Service
- (others as needed)

First run ~10-15 min total (no cache).

## 2. Make images public

By default GHCR images are private. Either:

a) Make each package public at
   https://github.com/users/cubbieblue16/packages → click each `knightcrawler-*` → Package settings → Change visibility → Public

b) OR keep private and `docker login ghcr.io` on VPS with a PAT (classic, `read:packages` scope).

Public is simpler.

## 3. Stage files on VPS

```sh
ssh root@74.117.196.240
mkdir -p /opt/knightcrawler
cd /opt/knightcrawler
git clone https://github.com/cubbieblue16/knightcrawler.git repo
cp repo/deployment/docker/docker-compose.vps.yaml docker-compose.yaml
cp repo/deployment/docker/stack.env.example stack.env

# Edit stack.env: set POSTGRES_PASSWORD, COLLECTOR_REAL_DEBRID_API_KEY, TZ
nano stack.env
```

## 4. Bring stack up

```sh
docker compose --env-file stack.env up -d
docker compose logs -f migrator
# wait for migrator: completed
docker compose logs -f metadata
# wait for metadata: completed
docker compose ps
# addon should be Up, healthy
```

If anything is restarting, check its logs:
```sh
docker compose logs --tail=100 addon
docker compose logs --tail=100 producer
```

## 5. Wire Cloudflare tunnel hostname

Open Cloudflare Zero Trust → Networks → Tunnels → your existing tunnel.

Add a public hostname:
- Subdomain: `knightcrawler` (or your choice)
- Domain: your domain
- Service: `http://knightcrawler-addon:7000`

Save. Within ~30s the hostname resolves.

## 6. Install in Stremio

Visit `https://knightcrawler.<your-domain>` in a browser.
- Pick debrid: TorBox (or whichever).
- Paste API key.
- Click INSTALL.

Stremio opens, addon registered.

## 7. Wait for ingest

Producer starts crawling EzTv, Nyaa, TPB, YTS, DMM, Torrentio immediately.
Consumer processes infohashes into ingested_torrents table.
DMM zipball (~1.5GB) hits first; expect initial CPU/network burst.

Useful checks:
```sh
docker compose exec postgres psql -U postgres -d knightcrawler -c "SELECT category, count(*) FROM ingested_torrents GROUP BY category;"
docker compose exec postgres psql -U postgres -d knightcrawler -c "SELECT count(*) FROM torrents;"
```

Streams for popular titles should appear within a couple hours; long tail fills over days.

## 8. Disk watch

Postgres volume grows fast (torrents + files tables). Current host is at 77% disk.

```sh
docker system df
du -sh /var/lib/docker/volumes/knightcrawler_postgres
df -h /
```

If you hit 90%, either prune old `ingested_torrents` rows where `processed=true`, or attach a larger volume and migrate.

## 9. Updating

When you push a fix to the fork:
```sh
# After CI builds finish:
ssh root@74.117.196.240
cd /opt/knightcrawler
docker compose pull
docker compose up -d
```

## 10. Portainer alternative

If you prefer to deploy through Portainer:
- Stacks → Add stack
- Build method: Repository
- Repository URL: https://github.com/cubbieblue16/knightcrawler
- Compose path: `deployment/docker/docker-compose.vps.yaml`
- Load env vars from `deployment/docker/stack.env` (or paste them inline)
- Deploy

Portainer pulls and brings up the stack the same way.

## Known follow-ups

- **Torbox collector**: addon already serves Torbox at stream-query time. The C# debrid-collector currently only pre-caches via RD. Adding a Torbox collector class follows the same pattern as `RealDebridClient.cs` if you want it pre-populating cached availability in the local DB. Not required for streaming to work.
- **AD/PM collectors**: same situation; addon-side works on-demand without them.
- **TGX crawler**: disabled (site dead). Re-enable in `producer/src/Configuration/scrapers.json` if a replacement domain emerges.
- **qBittorrent collector**: `QBIT_REPLICAS=0` keeps it dormant. Bump to 1 + uncomment the `qbittorrent` + `qbitcollector` services in compose if you want it.
