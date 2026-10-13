# The image of `isolated`'s docker backend (ib4k §3b). Built ONLY by
#   node scripts/contract-harness.mjs isolated-image build
# which tags it webctl-iso/node22:<first 12 hex of this file's sha256> and labels it with the
# full hash and the builder's uid. A run resolves that tag to an image ID once, checks the
# label, and runs by ID; it never builds and never pulls.
#
# ⛔ The base is pinned by DIGEST: node 22.23.3 (>= engines 22.12), Debian trixie, slim.
# ⛔ Every tool beyond the base is one explicit line, with the consumer need it answers
# (ib4k §3b, the tool survey). A lane that needs another asks through the coordinator.
FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4

# git: the consumers' pin check (ls-tree, rev-parse), downgrade arms (checkout), PASS line (describe)
# procps: ps, for diagnostics in a shared harness
RUN apt-get update \
 && apt-get install -y --no-install-recommends git procps \
 && rm -rf /var/lib/apt/lists/*
