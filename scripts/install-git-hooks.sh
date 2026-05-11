#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
HOOK_FILE="$HOOKS_DIR/pre-commit"

cat > "$HOOK_FILE" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

gitleaks protect --staged --redact --config .gitleaks.toml -v
EOF

chmod +x "$HOOK_FILE"

echo "pre-commit hook installed at $HOOK_FILE"
