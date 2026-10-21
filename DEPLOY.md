# Deploying MCPHub (Oracle Cloud Always Free)

This guide puts MCPHub on a free Oracle Cloud server with HTTPS, using only free software and a
free hostname. Allow about an hour the first time.

What you end up with: `https://<your-hostname>` serving the dashboard and the MCP endpoints, a free
Let's Encrypt certificate that renews itself, nightly database backups, and your own operator
account.

## 0. Staying at $0

| Item | Cost |
|---|---|
| Oracle Cloud Always Free server (Ampere A1) | Free within the Always Free limits |
| MCPHub, Docker, Caddy (HTTPS) | Free (open source) |
| HTTPS certificate (Let's Encrypt) | Free |
| Hostname (`<ip>.sslip.io`) | Free; no domain purchase needed |
| Playground (Anthropic API) | Off; it bills per use, so leave `ANTHROPIC_API_KEY` empty |

Rules:

- **Never click "Upgrade to Pay As You Go"** (or "Upgrade your account"). An Always Free account
  asks for a card to verify you are a real person, but it can't be charged unless you upgrade.
- **Create only resources marked "Always Free-eligible".** This guide uses one Ampere
  `VM.Standard.A1.Flex` instance with 1 OCPU and 6 GB of memory, well inside the free limits, and
  the default boot disk.
- **Don't add** block volumes, load balancers, reserved IPs or paid shapes.
- **Never buy a domain** for this, and **leave `ANTHROPIC_API_KEY` empty**.
- Oracle may **stop Always Free instances that stay almost idle for a week**. If yours is stopped,
  start it again in the console; your data stays on its disk.

Check Oracle's current Always Free limits when you sign up, in case they have changed.

## 1. On your Mac

1. Make sure everything you want to deploy is committed: `git status` should be clean. The deploy
   copies the last commit, not uncommitted changes.
2. You need an SSH key. If `ls ~/.ssh/id_ed25519.pub` shows nothing, create one:

```bash
ssh-keygen -t ed25519
```

3. Print the public key; you'll paste it into Oracle:

```bash
cat ~/.ssh/id_ed25519.pub
```

4. Open `deploy/oracle-init.sh` in this project and copy its whole contents; you'll paste it too.

## 2. Create the server

1. Sign up for **Oracle Cloud Free Tier**. Your **home region can't be changed later**, and free
   Ampere capacity varies by region, so pick a region close to you.
2. In the console: **Compute → Instances → Create instance**.
   - **Name**: `mcphub`.
   - **Image**: click *Change image* → **Canonical Ubuntu 24.04**.
   - **Shape**: click *Change shape* → *Ampere* → **VM.Standard.A1.Flex** → 1 OCPU, 6 GB memory.
     It must show the *Always Free-eligible* label.
   - **Networking**: keep the defaults (a new virtual cloud network) with **Assign a public IPv4
     address** on.
   - **Add SSH keys**: *Paste public keys* → paste the key from step 1.3.
   - **Boot volume**: keep the default size.
   - **Show advanced options → Management → Initialization script**: choose *Paste cloud-init
     script* and paste `deploy/oracle-init.sh`. It opens the web ports in the server's own
     firewall, installs Docker and prepares `/opt/mcphub`.
3. Click **Create**. If Oracle reports it is **out of capacity**, try again later or choose another
   availability domain; don't switch to a paid shape.
4. When the instance is *Running*, note its **Public IPv4 address**.
5. Let web traffic through Oracle's network firewall: on the instance page click the **subnet**
   link → **Security Lists** → **Default Security List** → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port Range **80** → *Add*.
   - Repeat with Destination Port Range **443**.

## 3. Log in and wait for setup

```bash
ssh ubuntu@SERVER_IP
```

Wait until the first-boot setup has finished (a few minutes):

```bash
cloud-init status --wait
```

It should end with `status: done`. **Log out and back in** (`exit`, then the `ssh` command again)
so you can use Docker without `sudo`, then check:

```bash
docker compose version
```

## 4. Copy MCPHub to the server

On your **Mac**, in the project folder. This sends exactly the last commit, with no secrets, data
or `node_modules`:

```bash
git archive --format=tar HEAD | ssh ubuntu@SERVER_IP "tar -x -C /opt/mcphub"
```

## 5. Configure

On the **server**:

```bash
cd /opt/mcphub/deploy && cp .env.example .env && chmod 600 .env
```

Generate the encryption key:

```bash
openssl rand -base64 32
```

**Save that key in your password manager now.** Without it, stored API keys can't be decrypted
and backups are useless. Then edit the settings:

```bash
nano .env
```

- `MCPHUB_DOMAIN`: your public IPv4 address with dashes, plus `.sslip.io`. For `203.0.113.10` use
  `203-0-113-10.sslip.io`. sslip.io is a free service that points that name at your address.
- `MCPHUB_ENCRYPTION_KEY`: the key you just generated.
- Leave `MCPHUB_ALLOW_SIGNUP=false` and `ANTHROPIC_API_KEY` empty.

Save with Ctrl+O, Enter, Ctrl+X.

## 6. Start

```bash
docker compose up -d --build
```

The first build takes several minutes. Then watch Caddy get the certificate:

```bash
docker compose logs -f caddy
```

Wait for a line saying the certificate was obtained, then press Ctrl+C. Check the app:

```bash
curl https://$(grep ^MCPHUB_DOMAIN .env | cut -d= -f2)/health
```

You should see `{"status":"ok"}`.

## 7. Create your account

Web sign-up stays closed on a fresh server, so nobody else can register first and become the
operator. Create your account from the server:

```bash
docker compose exec mcphub node packages/server/dist/cli/create-operator.js you@example.com
```

It prints a generated password once. Store it in your password manager, sign in at
`https://<your-hostname>/login`, then open **Account** (your email in the header) and turn on
two-factor sign-in.

## 8. Connect an AI client

Create an app in the dashboard, then copy its MCP URL from the app's **Connect** tab. For Claude
Code:

```bash
claude mcp add --transport http my-api https://YOUR_HOSTNAME/mcp/APP_ID
```

For Claude Desktop or Cursor, add a custom (remote) MCP server with the same URL. The client opens
a MCPHub sign-in page; click Allow.

## 9. Backups

The backup command takes a consistent copy while the server runs and keeps the newest 14:

```bash
docker compose exec -T mcphub node packages/server/dist/cli/backup.js 14
```

Run it every night at 03:15 by adding a cron job (`crontab -e`, then paste this line):

```text
15 3 * * * cd /opt/mcphub/deploy && docker compose exec -T mcphub node packages/server/dist/cli/backup.js 14 >> $HOME/mcphub-backup.log 2>&1
```

Backups on the same server don't survive losing the server. Every so often, copy them to your Mac
(free). On the server:

```bash
cd /opt/mcphub/deploy && docker compose cp mcphub:/data/backups ./backups
```

Then on your Mac:

```bash
scp -r ubuntu@SERVER_IP:/opt/mcphub/deploy/backups ~/mcphub-backups
```

**Restore** a backup that is in `/data/backups` (the encryption key must be the same one):

```bash
docker compose stop mcphub
```

```bash
docker compose run --rm --entrypoint sh mcphub -c "rm -f /data/mcpify.db-wal /data/mcpify.db-shm && cp /data/backups/mcpify-YYYYMMDD-HHMMSS.db /data/mcpify.db"
```

```bash
docker compose up -d
```

## 10. Updating

Take a backup (section 9), then on your Mac send the new commit:

```bash
git archive --format=tar HEAD | ssh ubuntu@SERVER_IP "rm -rf /opt/mcphub/packages && tar -x -C /opt/mcphub"
```

And on the server rebuild. Your data and `.env` are kept:

```bash
cd /opt/mcphub/deploy && docker compose up -d --build
```

## 11. Troubleshooting

- **`cloud-init status` says error, or you forgot to paste the script**: see what failed with
  `sudo tail -50 /var/log/cloud-init-output.log`, then run the script by hand. From your Mac, in
  the project folder: `scp deploy/oracle-init.sh ubuntu@SERVER_IP:` and on the server
  `sudo bash oracle-init.sh`. It is safe to run twice.
- **No certificate / browser warns about the connection**: check that `dig +short YOUR_HOSTNAME`
  prints your server's IP, that the Security List has the port 80 and 443 rules (section 2.5), and
  that `sudo iptables -L INPUT -n` shows ACCEPT rules for ports 80 and 443 above the REJECT line.
  If Let's Encrypt reports a rate limit for `sslip.io`, use a free DuckDNS name
  (`yourname.duckdns.org`) pointed at your IP instead, set it as `MCPHUB_DOMAIN`, and run
  `docker compose up -d` again.
- **The page shows "Bad Gateway"**: the app didn't start. `docker compose logs mcphub` names the
  missing setting (usually `MCPHUB_ENCRYPTION_KEY` or `MCPHUB_DOMAIN`).
- **The login page says the server isn't set up**: run the create-operator command (section 7).
- **The server stopped by itself**: Oracle stops idle Always Free instances. Start it from
  Compute → Instances; MCPHub starts again automatically.
- **Forgot your password**:

```bash
docker compose exec mcphub node packages/server/dist/cli/reset-password.js you@example.com
```

  Add `--disable-2fa` if you also lost your authenticator.

## 12. Removing it

To stop MCPHub but keep its data: `docker compose down`.

To remove the server, first copy your backups to your Mac (section 9), then Compute → Instances →
your instance → **Terminate**, and tick *permanently delete the attached boot volume*.

## Appendix: Hetzner instead (paid, about €4–5/month)

Sections 1 and 3–12 are the same. Instead of section 2, create a Hetzner Cloud server with Ubuntu
24.04, the cheapest shared vCPU type, Public IPv4 on, your SSH key, and a free Hetzner Firewall
allowing TCP 22, 80 and 443. Leave Backups, Volumes and extra IPs off: they are billed on top.
Hetzner bills hourly while the server exists; **powering it off doesn't stop billing, deleting
it does.** Hetzner logs you in as `root` and doesn't run the Oracle script, so after logging in run:

```bash
curl -fsSL https://get.docker.com | sh && mkdir -p /opt/mcphub
```

Then use `root@SERVER_IP` wherever this guide says `ubuntu@SERVER_IP`.

## What has and hasn't been tested

- Deployed end to end with this guide on Oracle Cloud Always Free (Ampere A1, Ubuntu 24.04):
  - the initialization script;
  - the Docker build on ARM;
  - Caddy obtaining a Let's Encrypt certificate for an `sslip.io` name, and the HTTP to HTTPS redirect;
  - `create-operator`, closed sign-up and the backup cron job.
- Tested on a Mac in production mode behind HTTPS (21 checks):
  - security headers, the built dashboard and fonts;
  - secure cookies and blocked cross-site requests;
  - a real API call and a real MCP client;
  - OAuth metadata and backups.
- Not yet tested on a real server: restoring a backup (section 9) and the update steps (section 10).
  Take a backup before trying either.
