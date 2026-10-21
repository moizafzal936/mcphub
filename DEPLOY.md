# Deploying MCPHub

This guide puts MCPHub on one small Linux server with HTTPS, using only free software and a free
hostname. Allow about an hour the first time.

What you end up with: `https://<your-hostname>` serving the dashboard and the MCP endpoints, a
free Let's Encrypt certificate that renews itself, daily database backups, and your own operator
account.

## 0. Cost: read this first

Everything in this guide is free **except the server itself if you choose Hetzner**.

| Item | Cost |
|---|---|
| MCPHub, Docker, Caddy (HTTPS) | Free (open source) |
| HTTPS certificate (Let's Encrypt) | Free |
| Hostname (`<ip>.sslip.io`) | Free; no domain purchase needed |
| Hetzner Cloud server | **Not free**: the cheapest shared server is roughly €4–5 a month including its IPv4 address. Check the current price on the order page. |
| Oracle Cloud "Always Free" server | Free, if you follow the rules below |
| Playground (Anthropic API) | Off by default; it bills per use, so leave `ANTHROPIC_API_KEY` empty |

Rules that keep it that way:

- **Never buy a domain** for this; the free `sslip.io` hostname works.
- **Leave `ANTHROPIC_API_KEY` empty.**
- **Hetzner** bills by the hour while the server exists, up to the monthly price. *Powering the
  server off does not stop billing; only deleting it does* (section 12). Never enable Backups,
  Snapshots, Volumes, Floating IPs, Load Balancers or extra IPs: each is billed on top. Hetzner
  may ask you to verify your identity or payment method when you sign up.
- **Oracle**: create only shapes marked "Always Free-eligible", and never click "Upgrade to Pay As
  You Go". An Always Free account asks for a card to verify you, but doesn't charge it unless you
  upgrade. Check Oracle's current Always Free limits before you start.

If spending nothing at all matters more than which provider you use, choose Oracle (section 2B).

## 1. On your Mac

1. Make sure everything you want to deploy is committed: `git status` should be clean. The deploy
   copies the last commit, not uncommitted changes.
2. You need an SSH key. If `ls ~/.ssh/id_ed25519.pub` shows nothing, create one:

```bash
ssh-keygen -t ed25519
```

3. Print the public key; you'll paste it into the server provider:

```bash
cat ~/.ssh/id_ed25519.pub
```

## 2A. Server option: Hetzner (paid, about €4–5/month)

In the Hetzner Cloud Console, create a project, then **Add Server**:

- **Location**: any EU location (they are usually cheapest).
- **Image**: Ubuntu 24.04.
- **Type**: Shared vCPU, the cheapest x86 or Arm option. Either works.
- **Networking**: keep Public IPv4 and IPv6 on (most networks still need IPv4 to reach you).
- **SSH keys**: add the public key from step 1.
- **Volumes, Backups, Placement groups**: leave all off (they cost extra).
- **Firewalls**: create one (free) allowing inbound TCP **22, 80 and 443** only.
- Name it `mcphub`, **check the price in the summary**, then create it.

Note the server's IPv4 address. You log in as `root`:

```bash
ssh root@SERVER_IP
```

## 2B. Server option: Oracle Cloud Always Free ($0)

1. Sign up for an Oracle Cloud Free Tier account and keep it on Always Free.
2. **Compute → Instances → Create instance**:
   - **Image**: Canonical Ubuntu 24.04.
   - **Shape**: Ampere `VM.Standard.A1.Flex` with 1 OCPU and 6 GB memory. It must be labelled
     *Always Free-eligible*. If Oracle says it is out of capacity, try again later or pick another
     availability domain; don't switch to a paid shape.
   - **Networking**: default network, with a public IPv4 address.
   - **SSH keys**: paste the public key from step 1.
3. Open ports 80 and 443 in Oracle's network firewall: on the instance page open the subnet →
   **Security List** → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination port `80`;
   repeat for `443`.
4. Log in as `ubuntu`. Oracle's Ubuntu image also blocks ports in its own firewall; open them:

```bash
ssh ubuntu@SERVER_IP
```

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
```

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
```

```bash
sudo netfilter-persistent save
```

On Oracle, put `sudo` in front of the commands in the rest of this guide, and use
`ubuntu@SERVER_IP` wherever it says `root@SERVER_IP`.

## 3. Install Docker on the server

Logged in to the server:

```bash
apt-get update && apt-get -y upgrade
```

```bash
curl -fsSL https://get.docker.com | sh
```

Check it works:

```bash
docker compose version
```

## 4. Copy MCPHub to the server

On your **Mac**, in the project folder. This sends exactly the last commit, with no secrets, data
or `node_modules`:

```bash
git archive --format=tar HEAD | ssh root@SERVER_IP "mkdir -p /opt/mcphub && tar -x -C /opt/mcphub"
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

- `MCPHUB_DOMAIN`: your IPv4 address with dashes, plus `.sslip.io`. For `203.0.113.10` use
  `203-0-113-10.sslip.io`. sslip.io is a free service that points that name at your address.
- `MCPHUB_ENCRYPTION_KEY`: the key you just generated.
- Leave `MCPHUB_ALLOW_SIGNUP=false` and `ANTHROPIC_API_KEY` empty.

Save with Ctrl+O, Enter, Ctrl+X.

## 6. Start

```bash
docker compose up -d --build
```

The first build takes a few minutes on a small server. Then watch Caddy get the certificate:

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
15 3 * * * cd /opt/mcphub/deploy && docker compose exec -T mcphub node packages/server/dist/cli/backup.js 14 >> /var/log/mcphub-backup.log 2>&1
```

Backups on the same server don't survive losing the server. Every so often, copy them to your Mac
(free). On the server:

```bash
cd /opt/mcphub/deploy && docker compose cp mcphub:/data/backups ./backups
```

Then on your Mac:

```bash
scp -r root@SERVER_IP:/opt/mcphub/deploy/backups ~/mcphub-backups
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
git archive --format=tar HEAD | ssh root@SERVER_IP "rm -rf /opt/mcphub/packages && tar -x -C /opt/mcphub"
```

And on the server rebuild. Your data and `.env` are kept:

```bash
cd /opt/mcphub/deploy && docker compose up -d --build
```

## 11. Troubleshooting

- **No certificate / browser warns about the connection**: check that
  `dig +short YOUR_HOSTNAME` prints your server's IP, and that ports 80 and 443 are open (Hetzner
  Firewall; on Oracle both the Security List and the iptables rules). If Let's Encrypt reports a
  rate limit for `sslip.io`, use a free DuckDNS name (`yourname.duckdns.org`) pointed at your IP
  instead, set it as `MCPHUB_DOMAIN`, and run `docker compose up -d` again.
- **The page shows "Bad Gateway"**: the app didn't start. `docker compose logs mcphub` names the
  missing setting (usually `MCPHUB_ENCRYPTION_KEY` or `MCPHUB_DOMAIN`).
- **The login page says the server isn't set up**: run the create-operator command (section 7).
- **Forgot your password**:

```bash
docker compose exec mcphub node packages/server/dist/cli/reset-password.js you@example.com
```

  Add `--disable-2fa` if you also lost your authenticator.

## 12. Stopping and deleting (stops all billing)

To stop MCPHub but keep its data: `docker compose down` (on Hetzner, **the server still costs
money** while it exists).

To stop paying entirely, first copy your backups to your Mac (section 9), then:

- **Hetzner**: Cloud Console → your server → **Delete**. Billing stops when it is deleted.
- **Oracle**: Compute → Instances → your instance → **Terminate**, including the boot volume.

## What has and hasn't been tested

- Tested on a Mac in production mode behind HTTPS (21 checks):
  - security headers, the built dashboard and fonts;
  - closed sign-up and `create-operator`;
  - secure cookies and blocked cross-site requests;
  - a real API call and a real MCP client;
  - OAuth metadata and backups.
- Not yet tested: building the Docker image and Caddy obtaining a real certificate. No Docker was
  available on the development Mac, so your first deploy is the first run of those. Sections 6
  and 11 tell you how to check each one.
