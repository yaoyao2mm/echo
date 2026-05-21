# Internet Deployment

Echo internet mode runs two processes:

- Relay server on your VPS or domain: hosts the phone PWA, handles auth, runs prompt refinement, stores session state, and queues local backend jobs.
- Desktop agent on your computer: polls the relay over HTTPS and runs queued work inside desktop-allowlisted local workspaces.

The relay never needs inbound access to your desktop. The desktop agent only opens outbound requests to the relay.

## 1. Relay `.env`

On the server:

```bash
ECHO_MODE=relay
ECHO_HOST=127.0.0.1
ECHO_PORT=3888
ECHO_PUBLIC_URL=https://voice.example.com
ECHO_TOKEN=replace-with-a-long-random-secret

ECHO_AUTH_ENABLED=true
ECHO_AUTH_USERNAME=owner
ECHO_AUTH_PASSWORD_SHA256=replace-with-sha256-of-strong-password

POSTPROCESS_PROVIDER=openai
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=gpt-4.1-mini
```

Generate a password hash with:

```bash
printf '%s' 'replace-with-a-strong-password' | shasum -a 256
```

Start the relay:

```bash
pnpm install
pnpm run relay
```

## 2. Nginx HTTPS Proxy

Point your domain DNS to the server, install a certificate, then proxy HTTPS traffic to the Node process:

```nginx
server {
    listen 443 ssl http2;
    server_name voice.example.com;

    ssl_certificate /etc/letsencrypt/live/voice.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/voice.example.com/privkey.pem;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3888;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 3. systemd Service

Example service at `/etc/systemd/system/echo-voice.service`:

```ini
[Unit]
Description=Echo Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/echo-voice
EnvironmentFile=/opt/echo-voice/.env
ExecStart=/usr/bin/env pnpm run relay
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now echo-voice
sudo systemctl status echo-voice
```

## 4. Deploy Updates

From your workstation:

```bash
pnpm run deploy:relay -- root@YOUR_SERVER /opt/echo-voice
```

The script performs a fast-forward pull, runs `pnpm install --prod --frozen-lockfile`, updates the systemd service to `pnpm run relay` when needed, and restarts `echo-voice.service`.

For GitHub Actions deployment, configure these repository secrets:

```text
ECHO_DEPLOY_HOST=YOUR_SERVER
ECHO_DEPLOY_USER=root
ECHO_DEPLOY_PATH=/opt/echo-voice
ECHO_DEPLOY_SERVICE=echo-voice.service
ECHO_DEPLOY_SSH_KEY=<private key with server access>
```

`ECHO_DEPLOY_KNOWN_HOSTS` is optional. If omitted, the workflow uses `ssh-keyscan`.

## 5. Desktop Agent

On the computer that should run local backends:

```bash
ECHO_RELAY_URL=https://voice.example.com \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/echo,other=/absolute/path/to/other \
pnpm run desktop
```

The phone can only choose these workspace ids. It cannot send arbitrary local paths or shell commands to the desktop.

To keep remote work out of your active checkout, enable desktop-controlled worktrees:

```bash
ECHO_CODEX_WORKTREE_MODE=always \
ECHO_CODEX_WORKTREE_ROOT=~/.echo-voice/worktrees \
ECHO_CODEX_WORKTREE_RETENTION_DAYS=14 \
pnpm run desktop
```

In this mode, each new session requires the selected allowlisted workspace to be a clean Git repository. The desktop agent creates an `echo/job-...` branch and runs the backend inside the worktree. Follow-up messages continue in that same worktree.

If you usually work with a VPN enabled, let the desktop agent follow the macOS system proxy:

```bash
ECHO_PROXY_URL=system pnpm run desktop
```

For macOS desktop app installs, put `ECHO_PROXY_URL=system` in `.env`, then run:

```bash
pnpm run desktop:mac -- settings
pnpm run desktop:mac -- restart
pnpm run desktop:mac -- doctor
```

`system` follows the macOS HTTP/HTTPS proxy. If your VPN client only exposes SOCKS, enable its HTTP or mixed proxy port and set `ECHO_PROXY_URL=http://127.0.0.1:PORT` instead.

## 6. Phone URL

Open:

```text
https://voice.example.com/?token=replace-with-a-long-random-secret
```

HTTPS is required for browser camera-based QR pairing. The token is your pairing secret, so keep it long, random, and private.

## Security Notes

- Use HTTPS in internet relay mode.
- Treat `ECHO_TOKEN` as a high-entropy pairing and agent secret. Never commit it.
- Browser login is an additional web gate on top of the token; desktop agent polling still uses `ECHO_TOKEN`.
- The relay server receives prompts, session events, logs, artifacts, approvals, and final results. Run it on infrastructure you trust.
- Local backend work runs on the desktop agent inside `ECHO_CODEX_WORKSPACES`; keep that allowlist narrow.
- The backend app-server or CLI stays local to the desktop agent and must not be exposed directly to the public internet.
- Back up, prune, or encrypt `~/.echo-voice/echo.sqlite` if session history is sensitive.
