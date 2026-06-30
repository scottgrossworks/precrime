FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
ENV PATH="/root/.local/bin:/root/.hermes/hermes-agent/venv/bin:${PATH}"

# System deps + Node 20
RUN apt-get update && apt-get install -y \
    curl git python3 python3-venv ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Clone Hermes repo
RUN git clone --depth 1 https://github.com/NousResearch/hermes-agent.git /root/.hermes/hermes-agent

# Create venv and install Hermes (base only — no Playwright/browser tools needed)
RUN cd /root/.hermes/hermes-agent && \
    python3 -m venv venv && \
    venv/bin/pip install -e "." mcp

# Create Hermes directory structure and symlink binary
RUN mkdir -p /root/.hermes/{cron,sessions,logs,pairing,hooks,image_cache,audio_cache,memories,skills} && \
    mkdir -p /root/.local/bin && \
    ln -sf /root/.hermes/hermes-agent/venv/bin/hermes /root/.local/bin/hermes

# Hermes config (pre-wired for Docker + precrime-mcp)
COPY docker/hermes-config.yaml /root/.hermes/config.yaml

# Custom SOUL and precrime skill
COPY docker/SOUL.md /root/.hermes/SOUL.md
COPY docker/skills/precrime /root/.hermes/skills/precrime

# Entrypoint: npm install + prisma generate + launch hermes
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /precrime

ENTRYPOINT ["/entrypoint.sh"]
