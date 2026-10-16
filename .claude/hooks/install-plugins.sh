#!/bin/bash
# Installs Claude Code plugins for cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! claude plugin list 2>/dev/null | grep -q 'hostinger@claude-plugins-official'; then
  claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
  claude plugin install hostinger@claude-plugins-official
fi
