# Deploy Discord Bot to Fly.io (24/7)

This guide shows how to deploy the current bot to Fly.io so it stays online.

## 1. Requirements
- Fly.io account: https://fly.io
- Fly CLI installed
  - Windows (PowerShell): `iwr https://fly.io/install.ps1 -UseBasicParsing | iex`
  - macOS/Linux: `curl -L https://fly.io/install.sh | sh`
- Git repository for your bot (recommended) or local folder.

## 2. Login
```
flyctl auth login
```
A browser will open; authorize your session.

## 3. Create App
From project root (where Dockerfile is):
```
flyctl launch --name <unique-app-name> --region mia --no-deploy
```
Notes:
- Replace `<unique-app-name>` with something unique (e.g. `eclipse-discord-bot-xyz`).
- Choose a region near Discord gateway users (e.g., `mia` (Miami), `iad` (Virginia), `scl` (Santiago), `gru` (São Paulo)).
- `--no-deploy` lets you edit `fly.toml` before first deploy.

A `fly.toml` file will be generated.

## 4. Set Secrets (Never hardcode the token)
```
flyctl secrets set DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
# Optional: if you use guild-specific slash registration
flyctl secrets set GUILD_ID=YOUR_GUILD_ID
```
Secrets are injected as environment variables inside the container.

## 5. (Optional) Persistent State
If you later add a JSON file or database, consider using a volume. For now roster data is in-memory and resets on deploy/restart.

Create a 1GB volume (optional example):
```
flyctl volumes create data --size 1 --region mia
```
Then add to `fly.toml`:
```
[mounts]
  source="data"
  destination="/app/data"
```
And write/read persistent files under `/app/data`.

## 6. Deploy
```
flyctl deploy
```
This will:
1. Build Docker image (using the provided Dockerfile)
2. Push it to Fly registry
3. Start a VM instance running `node index.js`

## 7. View Logs
```
flyctl logs
```
Use Ctrl+C to exit streaming.

## 8. App Status & Scaling
Check status:
```
flyctl status
```
Ensure only one instance for a Discord bot (avoid duplicate gateway sessions):
```
flyctl scale count 1
```
(Scaling to multiple instances can cause connection issues unless you implement sharding.)

## 9. Redeploy After Changes
Commit your code changes locally, then:
```
flyctl deploy
```
Logs again with:
```
flyctl logs
```

## 10. Updating Secrets
If token changes:
```
flyctl secrets set DISCORD_TOKEN=NEW_TOKEN
flyctl deploy
```
Secrets update triggers a redeploy.

## 11. Stop / Resume
Scale to zero (bot offline):
```
flyctl scale count 0
```
Bring back:
```
flyctl scale count 1
```

## 12. Remove App (Destroy)
```
flyctl apps destroy <unique-app-name>
```
Confirm when prompted.

## 13. Example fly.toml (Minimal)
Below is an example if you want to customize. The default generated is fine.
```
app = "eclipse-discord-bot-xyz"
primary_region = "mia"

[build]
  # Using Dockerfile (default)

[env]
  NODE_ENV = "production"

[processes]
  app = "node index.js"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 8080
```
The bot does not need exposed HTTP ports; Fly may still set one. It’s harmless. You can remove services section if not accepting HTTP traffic (Fly will keep VM alive without an inbound port if just a background process, but leaving it is OK).

## 14. Common Issues
| Problem | Cause | Fix |
|---------|-------|-----|
| Bot offline after deploy | Token missing | Run `flyctl secrets set DISCORD_TOKEN=...` and redeploy |
| Multiple instances warnings | More than 1 VM | `flyctl scale count 1` |
| Memory OOM | Free tier limits | Optimize code or upgrade plan |
| Slash commands missing | GUILD_ID not set or global propagation delay | Set GUILD_ID as secret or wait up to 1h for global | 

## 15. Next Steps
- Add persistence: write roster to `/app/data/state.json` and load on startup.
- Add health metrics/log channel.
- Implement graceful shutdown (listen to `process.on('SIGINT')`).

---
Deployment ready. Run: `flyctl launch --no-deploy`, set secrets, then `flyctl deploy`.
