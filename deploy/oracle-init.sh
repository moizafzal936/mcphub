#!/bin/bash
# First-boot setup for an Oracle Cloud Ubuntu instance. Paste this whole file into:
#   Create instance > Show advanced options > Management > Initialization script > Paste cloud-init script
# It runs once, as root. Check it finished with: cloud-init status --wait
set -eux

# Oracle's Ubuntu images reject everything except SSH in their own firewall (iptables), on top of
# the cloud Security List. Let web traffic in, before the REJECT rule, and keep it after reboots.
for port in 443 80; do
  pos=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
  iptables -I INPUT "${pos:-1}" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi

# Docker, from Docker's official install script. The login user may run it without sudo.
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu

# Where MCPHub's files go, owned by the login user so copying and updating need no sudo.
mkdir -p /opt/mcphub
chown ubuntu:ubuntu /opt/mcphub

# Bring the system up to date once; Ubuntu installs security updates automatically after this.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
