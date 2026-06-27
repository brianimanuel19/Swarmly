FROM rust:1.75-slim
RUN apt-get update && apt-get install -y curl git nodejs npm python3 pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN npm install -g @coral-xyz/anchor-cli @solana/web3.js
# Install Solana CLI
RUN sh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)" 2>/dev/null || true
RUN useradd -ms /bin/bash app
WORKDIR /workspace
RUN chown -R app:app /workspace
USER app
HEALTHCHECK --interval=30s --timeout=3s CMD rustc --version || exit 1
