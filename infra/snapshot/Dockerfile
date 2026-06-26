# Daytona sandbox snapshot image (checklist C2).
#
# This is the base every workspace sandbox is created from. The PINNED DIGEST of
# this image is the reproducibility anchor (contract §1, plan §7): an automation
# captured against a digest reproduces on a fresh sandbox from the SAME digest.
#
# Provides: node, python3 + pip, Codex CLI, and PDF tooling (poppler-utils,
# pypdf/pdfplumber, pandoc). Keep additions deliberate — every tool here is part
# of the reproducibility surface.
#
# Build + record the digest, then set DAYTONA_SNAPSHOT + DAYTONA_SNAPSHOT_DIGEST
# in .env. See README.md in this directory.

FROM node:22-bookworm

# ---- System packages: PDF/document tooling ----
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      poppler-utils \
      pandoc \
      ca-certificates \
      curl \
      git \
      tar \
      gzip \
    && rm -rf /var/lib/apt/lists/*

# ---- Python PDF libraries (system-wide; Debian needs the break flag) ----
RUN pip3 install --no-cache-dir --break-system-packages \
      pypdf \
      pdfplumber \
      requests

# ---- Codex CLI (the agent runtime) ----
RUN npm install -g @openai/codex

# ---- Agent guidance baked into the image (checklist C3) ----
COPY AGENTS.md /root/AGENTS.md

# Canonical workspace layout (contract §1). The server also ensures these.
RUN mkdir -p /workspace/knowledge /workspace/automations /workspace/artifacts
RUN chmod 777 /workspace/knowledge /workspace/automations /workspace/artifacts

WORKDIR /workspace

# Sanity: fail the build if a required tool is missing from PATH.
RUN node --version && python3 --version && pdftotext -v 2>&1 | head -1 \
    && pandoc --version | head -1 && codex --version
