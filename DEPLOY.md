# Deploying PDF Studio (VM + domain + HTTPS)

This is a step-by-step guide to run PDF Studio on your own server with a custom
domain and automatic SSL. It uses **Docker Compose + Caddy** (Caddy fetches and
renews the Let's Encrypt certificate for you).

The commands below are written for **Ubuntu** (tested on 24.04 LTS), but they work
almost the same on any Linux with Docker. Run everything **on the server** unless a
step says otherwise.

---

## What you need

- A Linux server / VM with a **public IP** (e.g. an Azure/AWS/GCP/Hetzner VM).
- A **domain name** you control (to get a real SSL certificate).
- Ports **80** and **443** reachable from the internet (see step 2).

---

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

`newgrp docker` (or logging out and back in) lets you run `docker` without `sudo`.

## 2. Open ports 80 and 443

Caddy needs ports **80** and **443** open to get and serve the certificate.

- **On the server firewall** (if UFW is enabled):
  ```bash
  sudo ufw allow 80,443/tcp
  ```
- **On your cloud provider**, also open 80 and 443 in the security group / firewall:
  - **Azure**: VM → *Networking* → *Add inbound port rule* (one for 80, one for 443, TCP, Allow).
  - **AWS**: the instance's *Security Group* → add inbound rules for 80 and 443.

## 3. Point your domain at the server (DNS)

Create an **A record** at your DNS provider:

| Field | Value |
|---|---|
| Type | `A` |
| Name / Host | `pdf` (so the full name is `pdf.yourdomain.com`) |
| Value | your server's **public IP** |
| TTL | lowest available (e.g. 300s) |

> **Using Cloudflare?** Set **Proxy status to "DNS only"** (grey cloud, not orange).
> If Cloudflare proxies the record, Caddy can't complete the certificate challenge.

Verify it resolves (may take a minute to propagate):

```bash
dig +short pdf.yourdomain.com
```

It should print your server's IP.

## 4. Get the code

```bash
git clone https://github.com/juanpabloortizo/pdf-studio.git
cd pdf-studio
```

## 5. Create the API key

The REST API (`/v1/*`) is protected by an API key. Generate a strong one into a
`.env` file (this file is git-ignored — never commit it):

```bash
echo "API_KEY=$(openssl rand -hex 32)" > .env
```

## 6. Set your domain in the Caddyfile

```bash
sed -i 's/pdf.yourdomain.com/pdf.YOURDOMAIN.com/' Caddyfile
```

(Replace `pdf.YOURDOMAIN.com` with your real subdomain.)

## 7. Protect the admin panel with a password

The public API is open (key-protected), but the **panel, visual editor, `/api/*`
and `/docs` sit behind an extra HTTP password** (defense in depth). Generate a
password hash:

```bash
docker run --rm caddy caddy hash-password --plaintext 'YOUR_PANEL_PASSWORD'
```

Copy the printed hash (starts with `$2a$...`), then edit the Caddyfile and replace
`REPLACE_WITH_THE_HASH` with it:

```bash
nano Caddyfile
```

Save with **Ctrl+O**, Enter, then **Ctrl+X**.

> Don't want the extra password? Delete the `basic_auth { ... }` block from the
> Caddyfile. The app still has its own login, so the panel is never fully open.

## 8. Start everything

```bash
docker compose up -d --build
```

The first build takes a few minutes (it downloads Chromium for PDF rendering).

> **No extra steps needed for the database.** The image ships **Node 22**
> (`node:22-bookworm-slim`), which avoids a known `better-sqlite3` native crash
> (SIGSEGV) seen on newer Linux kernels under Node 20. A fresh `docker compose up
> --build` just works — you don't have to configure or rebuild anything by hand.

## 9. Verify

Watch Caddy obtain the certificate:

```bash
docker compose logs caddy | grep -i "certificate obtained"
```

You should see `certificate obtained successfully` for your domain. Then check the
public health endpoint:

```bash
curl -s https://pdf.yourdomain.com/health
```

It should return `{"ok":true}`.

## 10. First run — create your account

Open **https://pdf.yourdomain.com** in your browser:

1. Enter the panel username `admin` + the password from step 7 (the Caddy lock).
2. The app then asks you to **create the owner account** (email + password). That's
   your login from now on; from it you manage the API key, templates, etc.

Done — you're live over HTTPS. 🎉

---

## Updating to a new version

When you push new code to the repo, update the server with:

```bash
cd ~/pdf-studio
git pull
docker compose up -d --build
```

Your data and templates persist in `./data` and `./templates` (mounted as volumes),
so updates never lose anything.

## Using the API

```bash
curl -X POST https://pdf.yourdomain.com/v1/create \
  -H "X-API-KEY: <your key>" -H "Content-Type: application/json" \
  -d '{"template_id":"<tpl_id>","export_type":"pdf","data":{"client":"Sample Client"}}' \
  --output out.pdf
```

Interactive docs live at `https://pdf.yourdomain.com/docs` (behind the panel login).

---

## Does the service "go to sleep"?

**No.** This setup runs on a plain VM with `restart: unless-stopped`, so both
containers run 24/7 and restart automatically after a crash or a server reboot.
There are no cold starts (that behavior only affects PaaS "app service" products,
which this is not). If you later add an **external** database or API with a
long-lived connection pool, note that some clouds (e.g. Azure) drop idle outbound
TCP connections after a few minutes — enable TCP keepalives / connection recycling
in that client. PDF Studio's own storage is local SQLite, so it isn't affected.

## Troubleshooting

**`502 Bad Gateway` and the app container keeps restarting**
Check the app logs and container state:
```bash
docker compose ps
docker compose logs pdf-studio
```
If the container shows a very short uptime and exit code **139 (SIGSEGV)**, the
native `better-sqlite3` module is crashing on your kernel. This project already
ships a **Node 22** base image (`node:22-bookworm-slim`), which fixes it — make
sure you've pulled the latest code and rebuilt (`git pull && docker compose up -d --build`).

**Caddy can't get a certificate**
- Confirm `dig +short pdf.yourdomain.com` returns your server IP.
- Confirm ports 80 and 443 are open (firewall **and** cloud security group).
- If on Cloudflare, confirm the record is **DNS only** (grey cloud).
- Inspect: `docker compose logs caddy`.

**Check what's running**
```bash
docker compose ps
docker compose logs -f          # all services, live
```
