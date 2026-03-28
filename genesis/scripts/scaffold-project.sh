#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# Step: Scaffold greenfield project
# Input: stdin JSON (from impact.stdout)
# Output: JSON with scaffold data + sideband file
# Requires: gh CLI authenticated, GENESIS_STACK env (optional)
# Repo creation/clone stays here because the current DevClaw/OpenClaw surface
# does not expose a deterministic repo lifecycle API equivalent to gh+git.

GENESIS_LOG="${GENESIS_LOG:-$HOME/.openclaw/workspace/logs/genesis.log}"
mkdir -p "$(dirname "$GENESIS_LOG")"
exec 2> >(tee -a "$GENESIS_LOG" >&2)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/sideband-lib.sh"
source "$SCRIPT_DIR/delivery-target-lib.sh"
source "$SCRIPT_DIR/stack-detection-lib.sh"
source "$SCRIPT_DIR/genesis-telemetry.sh"
genesis_load_env_file "$HOME/.openclaw/.env"

MAX_REPO_NAME_LEN=80
MAX_REPO_DESC_LEN=340

sanitize_repo_name() {
  local raw cleaned
  raw="${1:-}"
  cleaned="$(printf '%s' "$raw" | iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null || printf '%s' "$raw")"
  cleaned="$(printf '%s' "$cleaned" \
    | tr '[:upper:]' '[:lower:]' \
    | tr '[:space:]_' '-' \
    | sed -E 's/[^a-z0-9._-]+/-/g; s/[._-]+/-/g; s/^-+//; s/-+$//')"
  cleaned="$(printf '%s' "$cleaned" | cut -c1-"$MAX_REPO_NAME_LEN" | sed -E 's/-+$//')"
  printf '%s' "$cleaned"
}

GENERIC_NAMES_BLOCKLIST="novo|new|app|api|web|test|temp|tmp|projeto|project|demo|sample|example|my-app|my-project|untitled|criar|create|build"

validate_repo_name() {
  local name="$1"
  [[ -z "$name" ]] && return 1
  echo "$name" | grep -qxE "$GENERIC_NAMES_BLOCKLIST" && {
    echo "WARNING: Generic repo name '$name' rejected by blocklist" >&2
    return 1
  }
  [[ "${#name}" -lt 3 ]] && {
    echo "WARNING: Repo name '$name' too short" >&2
    return 1
  }
  return 0
}

sanitize_repo_description() {
  local raw cleaned
  raw="${1:-}"
  cleaned="$(printf '%s' "$raw" \
    | sed -E $'s/[\\x00-\\x1F\\x7F]/ /g; s/[[:space:]]+/ /g; s/^ //; s/ $//')"
  cleaned="$(printf '%s' "$cleaned" | cut -c1-"$MAX_REPO_DESC_LEN" | sed -E 's/[[:space:]]+$//')"
  printf '%s' "$cleaned"
}

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
genesis_metric_start "scaffold-project" "$SESSION_ID"
echo "=== $(date -Iseconds) | scaffold-project.sh | session=$SESSION_ID ===" >&2

IS_GREENFIELD="$(echo "$INPUT" | jq -r '.impact.is_greenfield // false')"
DRY_RUN="${GENESIS_DRY_RUN:-$(echo "$INPUT" | jq -r '.dry_run // false')}"

# Non-greenfield: passthrough
if [[ "$IS_GREENFIELD" != "true" ]]; then
  echo "Not greenfield — skipping scaffold" >&2
  echo "$INPUT" | jq '. + {scaffold: {created: false}}'
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry-run enabled — skipping scaffold and repo lifecycle actions" >&2
  echo "$INPUT" | jq '. + {scaffold: {created: false, reason: "dry_run"}}'
  exit 0
fi

echo "Greenfield project detected — running scaffold" >&2

GH_OWNER="${GENESIS_GH_OWNER:-${GENESIS_GH_ORG:-${GENESIS_GITHUB_ORG:-${GITHUB_OWNER:-${GITHUB_ORG:-}}}}}"

SPEC="$(echo "$INPUT" | jq '.spec // {}')"
TITLE="$(echo "$SPEC" | jq -r '.title // empty')"
DELIVERY_TARGET_RAW="$(echo "$INPUT" | jq -r '.spec.delivery_target // .classification.delivery_target // .metadata.delivery_target // empty')"
if [[ -z "$DELIVERY_TARGET_RAW" || "$DELIVERY_TARGET_RAW" == "null" ]]; then
  DELIVERY_TARGET="$(genesis_detect_delivery_target_from_text "${GENESIS_IDEA:-$TITLE}")"
else
  DELIVERY_TARGET_NORMALIZED="$(genesis_normalize_delivery_target "$DELIVERY_TARGET_RAW")"
  DELIVERY_TARGET="$(genesis_cross_validate_delivery_target "$DELIVERY_TARGET_NORMALIZED" "${GENESIS_IDEA:-$TITLE}")"
fi
INPUT_REPO_URL="$(echo "$INPUT" | jq -r '.metadata.repo_url // .repo_url // .repo // .scaffold.repo_url // empty')"
INPUT_PROJECT_NAME="$(echo "$INPUT" | jq -r '.metadata.project_name // .project_name // .name // .repo_name // empty')"
EXPLICIT_OWNER_REPO="$(genesis_parse_owner_repo "$INPUT_REPO_URL" || true)"

if [[ -n "$INPUT_REPO_URL" ]] && [[ -z "$EXPLICIT_OWNER_REPO" ]]; then
  if [[ "$INPUT_REPO_URL" == *"/"* ]] || [[ "$INPUT_REPO_URL" == http* ]] || [[ "$INPUT_REPO_URL" == git@* ]] || [[ "$INPUT_REPO_URL" == ssh://* ]]; then
    echo "ERROR: Invalid explicit repository hint '$INPUT_REPO_URL'. Use owner/repo or a valid GitHub URL." >&2
    exit 1
  fi
fi

# Fallback: use idea text from env when spec is not available (branch B has no spec)
if [[ -z "$TITLE" ]]; then
  TITLE="${GENESIS_IDEA:-untitled}"
fi

# --- Stack detection (3-tier): env > keyword > default ---
# Uses shared stack-detection-lib.sh for consistency with generate-qa-contract.sh
STACK="${GENESIS_STACK:-}"

# Normalize: "python" is not a valid stack. Clear unknown hints for auto-detect.
STACK="$(genesis_normalize_stack_hint "$STACK")"
[[ -n "${GENESIS_STACK:-}" && -z "$STACK" ]] && echo "Normalized unknown stack '${GENESIS_STACK}' → auto-detect" >&2

if [[ -z "$STACK" ]]; then
  # Build SPEC_TEXT from all available sources: spec fields + raw idea.
  # Always include GENESIS_IDEA to preserve user keywords the LLM may have
  # "translated away" (e.g., user says "python" but LLM spec says "aplicação").
  SPEC_TITLE="$(echo "$SPEC" | jq -r '.title // empty')"
  IDEA_LOWER="$(echo "${GENESIS_IDEA:-}" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$SPEC_TITLE" ]]; then
    SPEC_TEXT="$IDEA_LOWER"
  else
    SPEC_FIELDS="$(echo "$SPEC" | jq -r '[.title, .objective, (.scope_v1 // [] | .[]), (.acceptance_criteria // [] | .[])] | map(select(. != null)) | join(" ")' | tr '[:upper:]' '[:lower:]')"
    SPEC_TEXT="$IDEA_LOWER $SPEC_FIELDS"
  fi

  STACK="$(genesis_detect_stack_from_text "$SPEC_TEXT")"

  if [[ -z "$STACK" ]]; then
    STACK="$(genesis_detect_stack_from_delivery_target "$DELIVERY_TARGET")"
  fi

  echo "Auto-detected stack: $STACK (delivery_target=$DELIVERY_TARGET)" >&2
else
  echo "Stack from env: $STACK" >&2
fi

# --- Resolve repo target from explicit input first; fallback to slugified title ---
REPO_NAME_SOURCE="$TITLE"
if [[ -n "$INPUT_PROJECT_NAME" ]]; then
  REPO_NAME_SOURCE="$INPUT_PROJECT_NAME"
fi
if [[ -n "$EXPLICIT_OWNER_REPO" ]]; then
  GH_OWNER="${EXPLICIT_OWNER_REPO%%/*}"
  REPO_NAME_SOURCE="${EXPLICIT_OWNER_REPO##*/}"
  echo "Using explicit repo target from metadata.repo_url: $GH_OWNER/$REPO_NAME_SOURCE" >&2
elif [[ -n "$INPUT_REPO_URL" ]]; then
  REPO_NAME_SOURCE="$INPUT_REPO_URL"
  echo "Using explicit repo name hint: $INPUT_REPO_URL" >&2
elif [[ -n "$INPUT_PROJECT_NAME" ]]; then
  echo "Using explicit repo name from metadata.project_name: $INPUT_PROJECT_NAME" >&2
fi

if [[ -z "$GH_OWNER" ]]; then
  GH_OWNER="$(gh api user -q '.login' 2>/dev/null || true)"
fi
if [[ -z "$GH_OWNER" ]]; then
  echo "ERROR: Could not resolve GitHub owner/org. Set GENESIS_GH_OWNER or GENESIS_GH_ORG." >&2
  exit 1
fi
if [[ ! "$GH_OWNER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: Invalid GitHub owner/org value: '$GH_OWNER'" >&2
  exit 1
fi

REPO_NAME="$(sanitize_repo_name "$REPO_NAME_SOURCE")"
if ! validate_repo_name "$REPO_NAME"; then
  FALLBACK_SOURCE="$(echo "$SPEC" | jq -r '.objective // empty' | head -c 60)"
  [[ -n "$FALLBACK_SOURCE" ]] && REPO_NAME="$(sanitize_repo_name "$FALLBACK_SOURCE")"
  if ! validate_repo_name "$REPO_NAME"; then
    REPO_NAME="genesis-project-$(date +%s)"
    echo "WARNING: Could not derive meaningful name, using fallback: $REPO_NAME" >&2
  fi
fi

REPO_URL="https://github.com/$GH_OWNER/$REPO_NAME"
REPO_LOCAL="$HOME/git/$REPO_NAME"

echo "Repo: $GH_OWNER/$REPO_NAME, Stack: $STACK" >&2

# --- Create GitHub repo (idempotent) ---
REPO_CREATED_NOW=false
if gh repo view "$GH_OWNER/$REPO_NAME" &>/dev/null; then
  echo "Repo $GH_OWNER/$REPO_NAME already exists — reusing" >&2
else
  echo "Creating repo $GH_OWNER/$REPO_NAME..." >&2
  REPO_DESC_RAW="$(echo "$SPEC" | jq -r '.objective // empty')"
  if [[ -z "$REPO_DESC_RAW" ]]; then
    REPO_DESC_RAW="${GENESIS_IDEA:-Auto-scaffolded project}"
  fi
  REPO_DESC="$(sanitize_repo_description "$REPO_DESC_RAW")"
  if [[ -z "$REPO_DESC" ]]; then
    REPO_DESC="Auto-scaffolded project"
  fi

  if ! gh repo create "$GH_OWNER/$REPO_NAME" --private --description "$REPO_DESC" >&2; then
    if gh repo view "$GH_OWNER/$REPO_NAME" &>/dev/null; then
      echo "Repo $GH_OWNER/$REPO_NAME already exists after failed create call — continuing" >&2
    else
      echo "Repo creation with description failed — retrying without description" >&2
      gh repo create "$GH_OWNER/$REPO_NAME" --private >&2 || {
        echo "ERROR: Failed to create repo" >&2
        exit 1
      }
    fi
  fi
  REPO_CREATED_NOW=true
  sleep 2  # wait for GitHub to fully initialize
fi

# --- Clone ---
if [[ -d "$REPO_LOCAL" ]]; then
  echo "Local clone exists at $REPO_LOCAL — pulling" >&2
  cd "$REPO_LOCAL" && git pull origin main >&2 2>/dev/null || true
else
  echo "Cloning to $REPO_LOCAL..." >&2
  mkdir -p "$HOME/git"
  gh repo clone "$GH_OWNER/$REPO_NAME" "$REPO_LOCAL" >&2 || {
    if [[ "$REPO_CREATED_NOW" == "true" && ! -e "$REPO_LOCAL" ]]; then
      # Fresh repos can fail to clone before the default branch exists; seed locally.
      mkdir -p "$REPO_LOCAL"
      cd "$REPO_LOCAL"
      git init >&2
      git remote add origin "https://github.com/$GH_OWNER/$REPO_NAME.git" >&2
    else
      echo "ERROR: Failed to clone $GH_OWNER/$REPO_NAME" >&2
      exit 1
    fi
  }
fi

cd "$REPO_LOCAL"

FILES_CREATED=()

# ===================================================================
# Scaffold functions per stack
# ===================================================================

scaffold_gitignore_node() {
  cat > .gitignore <<'GITEOF'
node_modules/
dist/
build/
.next/
.env
.env.local
*.log
coverage/
.coverage
.DS_Store
GITEOF
  FILES_CREATED+=(".gitignore")
}

scaffold_gitignore_python() {
  cat > .gitignore <<'GITEOF'
__pycache__/
*.pyc
.env
.venv/
venv/
dist/
build/
*.egg-info/
.mypy_cache/
.ruff_cache/
.pytest_cache/
coverage/
htmlcov/
.coverage
.coverage.*
*.log
.DS_Store
GITEOF
  FILES_CREATED+=(".gitignore")
}

scaffold_env_example() {
  local stack="$1"
  case "$stack" in
    nextjs|express)
      cat > .env.example <<'EOF'
# Application
NODE_ENV=development
PORT=3000

# Database (if applicable)
# DATABASE_URL=postgresql://user:pass@localhost:5432/dbname

# Auth (if applicable)
# JWT_SECRET=change-me
# SESSION_SECRET=change-me
EOF
      ;;
    fastapi|flask|django)
      cat > .env.example <<'EOF'
# Application
DEBUG=true
SECRET_KEY=change-me

# Database (if applicable)
# DATABASE_URL=postgresql://user:pass@localhost:5432/dbname

# Server
HOST=0.0.0.0
PORT=8000
EOF
      ;;
    python-cli)
      cat > .env.example <<'EOF'
# Application
# LOG_LEVEL=info
EOF
      ;;
  esac
  FILES_CREATED+=(".env.example")
}

scaffold_readme() {
  local name="$1" stack="$2" objective="$3"
  cat > README.md <<EOF
# $name

$objective

## Stack

- **Framework**: $stack

## Setup

\`\`\`bash
$(case "$stack" in
  nextjs|express) echo "npm install" ;;
  fastapi|flask|django) echo "python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" ;;
  python-cli) echo "python -m venv .venv && source .venv/bin/activate && pip install -e '.[dev]'" ;;
esac)
\`\`\`

## Run

\`\`\`bash
$(case "$stack" in
  nextjs) echo "npm run dev" ;;
  express) echo "npm run dev" ;;
  fastapi) echo "uvicorn app.main:app --reload" ;;
  flask) echo "flask run --debug" ;;
  django) echo "python manage.py runserver" ;;
  python-cli) echo "$name --help" ;;
esac)
\`\`\`

## QA

\`\`\`bash
bash scripts/qa.sh
\`\`\`

---
_Scaffolded by Genesis Flow_
EOF
  FILES_CREATED+=("README.md")
}

scaffold_ci_workflow() {
  mkdir -p .github/workflows
  cat > .github/workflows/qa.yml <<'EOF'
name: QA

on:
  push:
    branches:
      - main
  pull_request:

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node (cached)
        if: ${{ hashFiles('package.json') != '' && hashFiles('package-lock.json') != '' }}
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - name: Setup Node (no cache)
        if: ${{ hashFiles('package.json') != '' && hashFiles('package-lock.json') == '' }}
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup Python
        if: ${{ hashFiles('requirements.txt') != '' || hashFiles('pyproject.toml') != '' }}
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install Node deps
        if: ${{ hashFiles('package.json') != '' }}
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi

      - name: Install Python deps
        if: ${{ hashFiles('requirements.txt') != '' || hashFiles('pyproject.toml') != '' }}
        run: |
          python -m pip install --upgrade pip
          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
          if [ -f pyproject.toml ]; then pip install -e '.[dev]'; fi

      - name: Run QA
        run: bash scripts/qa.sh
EOF
  FILES_CREATED+=(".github/workflows/qa.yml")
}

generate_node_lockfile() {
  if command -v npm >/dev/null 2>&1; then
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || true
  fi
  if [[ -f package-lock.json ]]; then
    FILES_CREATED+=("package-lock.json")
  fi
}

# --- Node.js CLI ---
scaffold_node_cli() {
  scaffold_gitignore_node
  scaffold_env_example "node-cli"

  cat > package.json <<'EOF'
{
  "name": "REPO_NAME_PLACEHOLDER",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "REPO_NAME_PLACEHOLDER": "dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src/",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "commander": "^14.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.7.0",
    "tsx": "^4.0.0",
    "vitest": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0"
  }
}
EOF
  jq --arg name "$REPO_NAME" '.name = $name | .bin = {($name): "dist/index.js"}' package.json > package.json.tmp && mv package.json.tmp package.json
  FILES_CREATED+=("package.json")
  generate_node_lockfile

  cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
  FILES_CREATED+=("tsconfig.json")

  mkdir -p src
  cat > src/index.ts <<'EOF'
#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name(process.env.npm_package_name ?? 'cli')
  .version(process.env.npm_package_version ?? '0.1.0')
  .description('CLI tool')
  .argument('[args...]', 'arguments')
  .action((args: string[]) => {
    console.log('Hello from CLI', args.length ? args.join(' ') : '');
  });

program.parse();
EOF
  FILES_CREATED+=("src/index.ts")

  mkdir -p tests
  cat > tests/main.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve(__dirname, '../src/index.ts');

function run(...args: string[]): string {
  return execFileSync('npx', ['tsx', cli, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  }).trim();
}

describe('CLI', () => {
  it('should print hello message', () => {
    const output = run();
    expect(output).toContain('Hello from CLI');
  });

  it('should show version with --version', () => {
    const output = run('--version');
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });
});
EOF
  FILES_CREATED+=("tests/main.test.ts")

  mkdir -p scripts
  cat > scripts/qa.sh <<'QAEOF'
#!/usr/bin/env bash
set -euo pipefail
echo "=== QA Gate ==="
FAIL=0

echo "--- Lint ---"
npx eslint src/ 2>&1 || { echo "LINT FAILED"; FAIL=1; }

echo "--- TypeScript ---"
npx tsc --noEmit 2>&1 || { echo "TSC FAILED"; FAIL=1; }

echo "--- Tests ---"
npx vitest run 2>&1 || { echo "TESTS FAILED"; FAIL=1; }

echo "--- Coverage (>=80%) ---"
npx vitest run --coverage --coverage.thresholds.lines=80 2>&1 || { echo "COVERAGE FAILED"; FAIL=1; }

echo "--- Secrets scan ---"
if grep -rn 'password\s*=\s*"[^"]\+"\|api_key\s*=\s*"[^"]\+"\|secret\s*=\s*"[^"]\+"' --include="*.ts" --include="*.js" src/ 2>/dev/null; then
  echo "SECRETS FOUND — FAIL"; FAIL=1
else
  echo "No hardcoded secrets found"
fi

exit $FAIL
QAEOF
  chmod +x scripts/qa.sh
  FILES_CREATED+=("scripts/qa.sh")
}

# --- Next.js ---
scaffold_nextjs() {
  scaffold_gitignore_node
  scaffold_env_example "nextjs"

  cat > package.json <<'EOF'
{
  "name": "REPO_NAME_PLACEHOLDER",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "eslint": "^9.0.0",
    "eslint-config-next": "^15.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "@vitejs/plugin-react": "^4.0.0"
  }
}
EOF
  jq --arg name "$REPO_NAME" '.name = $name' package.json > package.json.tmp && mv package.json.tmp package.json
  FILES_CREATED+=("package.json")
  generate_node_lockfile

  cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
EOF
  FILES_CREATED+=("tsconfig.json")

  mkdir -p src/app
  cat > src/app/layout.tsx <<'EOF'
export const metadata = {
  title: 'App',
  description: 'Auto-scaffolded project',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
EOF
  FILES_CREATED+=("src/app/layout.tsx")

  cat > src/app/page.tsx <<'EOF'
export default function Home() {
  return (
    <main>
      <h1>Welcome</h1>
      <p>Project scaffolded by Genesis Flow.</p>
    </main>
  );
}
EOF
  FILES_CREATED+=("src/app/page.tsx")

  mkdir -p src/app/api/health
  cat > src/app/api/health/route.ts <<'EOF'
import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() });
}
EOF
  FILES_CREATED+=("src/app/api/health/route.ts")

  mkdir -p tests
  cat > tests/health.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';

describe('Health check', () => {
  it('should return ok status', async () => {
    const { GET } = await import('../src/app/api/health/route');
    const response = GET();
    const data = await response.json();
    expect(data.status).toBe('ok');
  });
});
EOF
  FILES_CREATED+=("tests/health.test.ts")

  mkdir -p scripts
  cat > scripts/qa.sh <<'QAEOF'
#!/usr/bin/env bash
set -euo pipefail
echo "=== QA Gate ==="
FAIL=0

echo "--- Lint ---"
npx next lint . 2>&1 || { echo "LINT FAILED"; FAIL=1; }

echo "--- TypeScript ---"
npx tsc --noEmit 2>&1 || { echo "TSC FAILED"; FAIL=1; }

echo "--- Tests ---"
npx vitest run 2>&1 || { echo "TESTS FAILED"; FAIL=1; }

echo "--- Coverage (>=80%) ---"
npx vitest run --coverage --coverage.thresholds.lines=80 2>&1 || { echo "COVERAGE FAILED"; FAIL=1; }

echo "--- Secrets scan ---"
if grep -rn 'password\s*=\s*"[^"]\+"\|api_key\s*=\s*"[^"]\+"\|secret\s*=\s*"[^"]\+"' --include="*.ts" --include="*.tsx" --include="*.js" src/ 2>/dev/null; then
  echo "SECRETS FOUND — FAIL"; FAIL=1
else
  echo "No hardcoded secrets found"
fi

exit $FAIL
QAEOF
  chmod +x scripts/qa.sh
  FILES_CREATED+=("scripts/qa.sh")
}

# --- Express ---
scaffold_express() {
  scaffold_gitignore_node
  scaffold_env_example "express"

  cat > package.json <<'EOF'
{
  "name": "REPO_NAME_PLACEHOLDER",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src/",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^5.0.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.7.0",
    "tsx": "^4.0.0",
    "vitest": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.0"
  }
}
EOF
  jq --arg name "$REPO_NAME" '.name = $name' package.json > package.json.tmp && mv package.json.tmp package.json
  FILES_CREATED+=("package.json")
  generate_node_lockfile

  cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
  FILES_CREATED+=("tsconfig.json")

  mkdir -p src
  cat > src/index.ts <<'EOF'
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
EOF
  FILES_CREATED+=("src/index.ts")

  mkdir -p tests
  cat > tests/health.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/index.js';

describe('GET /health', () => {
  it('should return ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
EOF
  FILES_CREATED+=("tests/health.test.ts")

  mkdir -p scripts
  cat > scripts/qa.sh <<'QAEOF'
#!/usr/bin/env bash
set -euo pipefail
echo "=== QA Gate ==="
FAIL=0

echo "--- Lint ---"
npx eslint src/ 2>&1 || { echo "LINT FAILED"; FAIL=1; }

echo "--- TypeScript ---"
npx tsc --noEmit 2>&1 || { echo "TSC FAILED"; FAIL=1; }

echo "--- Tests ---"
npx vitest run 2>&1 || { echo "TESTS FAILED"; FAIL=1; }

echo "--- Coverage (>=80%) ---"
npx vitest run --coverage --coverage.thresholds.lines=80 2>&1 || { echo "COVERAGE FAILED"; FAIL=1; }

echo "--- Secrets scan ---"
if grep -rn 'password\s*=\s*"[^"]\+"\|api_key\s*=\s*"[^"]\+"\|secret\s*=\s*"[^"]\+"' --include="*.ts" --include="*.js" src/ 2>/dev/null; then
  echo "SECRETS FOUND — FAIL"; FAIL=1
else
  echo "No hardcoded secrets found"
fi

exit $FAIL
QAEOF
  chmod +x scripts/qa.sh
  FILES_CREATED+=("scripts/qa.sh")
}

# --- FastAPI ---
scaffold_fastapi() {
  scaffold_gitignore_python
  scaffold_env_example "fastapi"

  cat > pyproject.toml <<EOF
[build-system]
requires = ["setuptools>=75.0.0"]
build-backend = "setuptools.build_meta"

[project]
name = "$REPO_NAME"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "pydantic>=2.0.0",
    "pydantic-settings>=2.0.0",
    "python-dotenv>=1.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "pytest-cov>=5.0.0",
    "httpx>=0.27.0",
    "ruff>=0.8.0",
    "mypy>=1.13.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
target-version = "py311"
line-length = 120

[tool.mypy]
python_version = "3.11"
warn_return_any = true
warn_unused_configs = true
EOF
  FILES_CREATED+=("pyproject.toml")

  cat > requirements.txt <<'EOF'
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
pydantic>=2.0.0
pydantic-settings>=2.0.0
python-dotenv>=1.0.0
EOF
  FILES_CREATED+=("requirements.txt")

  mkdir -p app
  cat > app/__init__.py <<'EOF'
EOF
  cat > app/main.py <<'EOF'
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import os
from datetime import datetime, timezone

app = FastAPI(title=os.getenv("APP_NAME", "App"))


@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": "Internal server error"})
EOF
  FILES_CREATED+=("app/__init__.py" "app/main.py")

  mkdir -p tests
  cat > tests/__init__.py <<'EOF'
EOF
  cat > tests/test_health.py <<'EOF'
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "timestamp" in data
EOF
  FILES_CREATED+=("tests/__init__.py" "tests/test_health.py")

  mkdir -p scripts
  cat > scripts/qa.sh <<'QAEOF'
#!/usr/bin/env bash
set -euo pipefail

# --- Shared QA toolchain ---
TOOLCHAIN="$HOME/.openclaw/toolchains/python"
if [[ -d "$TOOLCHAIN/bin" ]]; then
  export PATH="$TOOLCHAIN/bin:$PATH"
elif command -v ruff &>/dev/null; then
  : # ruff available globally, proceed
else
  echo "[qa] WARNING: No QA toolchain found at $TOOLCHAIN" >&2
fi

echo "=== QA Gate ==="
FAIL=0

echo "--- Ruff lint ---"
ruff check app/ tests/ 2>&1 || { echo "RUFF FAILED"; FAIL=1; }

echo "--- Mypy ---"
mypy app/ 2>&1 || { echo "MYPY FAILED"; FAIL=1; }

echo "--- Tests ---"
python -m pytest tests/ -v 2>&1 || { echo "TESTS FAILED"; FAIL=1; }

echo "--- Coverage (>=80%) ---"
python -m pytest tests/ -q --cov=app --cov-report=term-missing --cov-fail-under=80 2>&1 || { echo "COVERAGE FAILED"; FAIL=1; }

echo "--- Secrets scan ---"
if grep -rn 'password\s*=\s*"[^"]\+"\|api_key\s*=\s*"[^"]\+"\|secret\s*=\s*"[^"]\+"' --include="*.py" app/ 2>/dev/null; then
  echo "SECRETS FOUND — FAIL"; FAIL=1
else
  echo "No hardcoded secrets found"
fi

exit $FAIL
QAEOF
  chmod +x scripts/qa.sh
  FILES_CREATED+=("scripts/qa.sh")
}

# --- Flask ---
scaffold_flask() {
  scaffold_gitignore_python
  scaffold_env_example "flask"

  cat > pyproject.toml <<EOF
[build-system]
requires = ["setuptools>=75.0.0"]
build-backend = "setuptools.build_meta"

[project]
name = "$REPO_NAME"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "flask>=3.1.0",
    "python-dotenv>=1.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-cov>=5.0.0",
    "ruff>=0.8.0",
    "mypy>=1.13.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
target-version = "py311"
line-length = 120

[tool.mypy]
python_version = "3.11"
warn_return_any = true
warn_unused_configs = true
EOF
  FILES_CREATED+=("pyproject.toml")

  cat > requirements.txt <<'EOF'
flask>=3.1.0
python-dotenv>=1.0.0
EOF
  FILES_CREATED+=("requirements.txt")

  mkdir -p app
  cat > app/__init__.py <<'EOF'
from flask import Flask, jsonify
import os


def create_app():
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-me")

    @app.route("/health")
    def health():
        from datetime import datetime, timezone
        return jsonify(status="ok", timestamp=datetime.now(timezone.utc).isoformat())

    @app.errorhandler(Exception)
    def handle_exception(e):
        return jsonify(error="Internal server error"), 500

    return app
EOF
  FILES_CREATED+=("app/__init__.py")

  mkdir -p tests
  cat > tests/__init__.py <<'EOF'
EOF
  cat > tests/test_health.py <<'EOF'
from app import create_app


def test_health():
    app = create_app()
    client = app.test_client()
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "ok"
EOF
  FILES_CREATED+=("tests/__init__.py" "tests/test_health.py")

  mkdir -p scripts
  cat > scripts/qa.sh <<'QAEOF'
#!/usr/bin/env bash
set -euo pipefail

# --- Shared QA toolchain ---
TOOLCHAIN="$HOME/.openclaw/toolchains/python"
if [[ -d "$TOOLCHAIN/bin" ]]; then
  export PATH="$TOOLCHAIN/bin:$PATH"
elif command -v ruff &>/dev/null; then
  : # ruff available globally, proceed
else
  echo "[qa] WARNING: No QA toolchain found at $TOOLCHAIN" >&2
fi

echo "=== QA Gate ==="
FAIL=0

echo "--- Ruff lint ---"
ruff check app/ tests/ 2>&1 || { echo "RUFF FAILED"; FAIL=1; }

echo "--- Mypy ---"
mypy app/ 2>&1 || { echo "MYPY FAILED"; FAIL=1; }

echo "--- Tests ---"
python -m pytest tests/ -v 2>&1 || { echo "TESTS FAILED"; FAIL=1; }

echo "--- Coverage (>=80%) ---"
python -m pytest tests/ -q --cov=app --cov-report=term-missing --cov-fail-under=80 2>&1 || { echo "COVERAGE FAILED"; FAIL=1; }

echo "--- Secrets scan ---"
if grep -rn 'password\s*=\s*"[^"]\+"\|api_key\s*=\s*"[^"]\+"\|secret\s*=\s*"[^"]\+"' --include="*.py" app/ 2>/dev/null; then
  echo "SECRETS FOUND — FAIL"; FAIL=1
else
  echo "No hardcoded secrets found"
fi

exit $FAIL
QAEOF
  chmod +x scripts/qa.sh
  FILES_CREATED+=("scripts/qa.sh")
}

# --- Django ---
scaffold_django() {
  scaffold_gitignore_python
  scaffold_env_example "django"

  cat > pyproject.toml <<EOF
[build-system]
requires = ["setuptools>=75.0.0"]
build-backend = "setuptools.build_meta"

[project]
name = "$REPO_NAME"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "django>=5.1.0",
    "django-environ>=0.11.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-django>=4.9.0",
    "pytest-cov>=5.0.0",
    "ruff>=0.8.0",
    "mypy>=1.13.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
DJANGO_SETTINGS_MODULE = "app.settings"

[tool.ruff]
target-version = "py311"
line-length = 120

[tool.mypy]
python_version = "3.11"
warn_return_any = true
warn_unused_configs = true
EOF
  FILES_CREATED+=("pyproject.toml")

  cat > requirements.txt <<'EOF'
django>=5.1.0
django-environ>=0.11.0
EOF
  FILES_CREATED+=("requirements.txt")

  # Use django-admin to create the project structure
  mkdir -p app
  cat > app/__init__.py <<'EOF'
EOF
  cat > app/settings.py <<'EOF'
import os
import environ

env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

SECRET_KEY = env("SECRET_KEY", default="change-me")
DEBUG = env("DEBUG")
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
]
ROOT_URLCONF = "app.urls"
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.path.join(os.path.dirname(os.path.dirname(__file__)), "db.sqlite3"),
    }
}
EOF
  FILES_CREATED+=("app/__init__.py" "app/settings.py")

  cat > app/urls.py <<'EOF'
from django.urls import path
from app.views import health

urlpatterns = [
    path("health", health),
]
EOF
  FILES_CREATED+=("app/urls.py")

  cat > app/views.py <<'EOF'
from django.http import JsonResponse
from datetime import datetime, timezone


def health(request):
    return JsonResponse({"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()})
EOF
  FILES_CREATED+=("app/views.py")

  cat > app/wsgi.py <<'EOF'
import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "app.settings")
application = get_wsgi_application()
EOF
  FILES_CREATED+=("app/wsgi.py")

  cat > manage.py <<'EOF'
#!/usr/bin/env python
import os
import sys

def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "app.settings")
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)

if __name__ == "__main__":
    main()
EOF
  chmod +x manage.py
  FILES_CREATED+=("manage.py")

  cat > pytest.ini <<'EOF'
[pytest]
DJANGO_SETTINGS_MODULE = app.settings
EOF
  FILES_CREATED+=("pytest.ini")

  mkdir -p tests
  cat > tests/__init__.py <<'EOF'
EOF
  cat > tests/test_health.py <<'EOF'
import pytest
from django.test import Client


@pytest.mark.django_db
def test_health():
    client = Client()
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
EOF
  FILES_CREATED+=("tests/__init__.py" "tests/test_health.py")

  mkdir -p scripts
  cat > scripts/qa.sh <<'QAEOF'
#!/usr/bin/env bash
set -euo pipefail

# --- Shared QA toolchain ---
TOOLCHAIN="$HOME/.openclaw/toolchains/python"
if [[ -d "$TOOLCHAIN/bin" ]]; then
  export PATH="$TOOLCHAIN/bin:$PATH"
elif command -v ruff &>/dev/null; then
  : # ruff available globally, proceed
else
  echo "[qa] WARNING: No QA toolchain found at $TOOLCHAIN" >&2
fi

echo "=== QA Gate ==="
FAIL=0

echo "--- Ruff lint ---"
ruff check app/ tests/ 2>&1 || { echo "RUFF FAILED"; FAIL=1; }

echo "--- Mypy ---"
mypy app/ 2>&1 || { echo "MYPY FAILED"; FAIL=1; }

echo "--- Tests ---"
python -m pytest tests/ -v 2>&1 || { echo "TESTS FAILED"; FAIL=1; }

echo "--- Coverage (>=80%) ---"
python -m pytest tests/ -q --cov=app --cov-report=term-missing --cov-fail-under=80 2>&1 || { echo "COVERAGE FAILED"; FAIL=1; }

echo "--- Secrets scan ---"
if grep -rn 'password\s*=\s*"[^"]\+"\|api_key\s*=\s*"[^"]\+"\|secret\s*=\s*"[^"]\+"' --include="*.py" app/ 2>/dev/null; then
  echo "SECRETS FOUND — FAIL"; FAIL=1
else
  echo "No hardcoded secrets found"
fi

exit $FAIL
QAEOF
  chmod +x scripts/qa.sh
  FILES_CREATED+=("scripts/qa.sh")
}

# --- Python CLI ---
scaffold_python_cli() {
  scaffold_gitignore_python
  scaffold_env_example "python-cli"

  local pkg_name
  pkg_name="$(echo "$REPO_NAME" | tr '-' '_')"

  cat > pyproject.toml <<EOF
[build-system]
requires = ["setuptools>=75.0.0"]
build-backend = "setuptools.build_meta"

[project]
name = "$REPO_NAME"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-cov>=5.0.0",
    "ruff>=0.8.0",
    "mypy>=1.13.0",
]

[project.scripts]
$REPO_NAME = "${pkg_name}.main:main"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
target-version = "py311"
line-length = 120

[tool.mypy]
python_version = "3.11"
warn_return_any = true
warn_unused_configs = true
EOF
  FILES_CREATED+=("pyproject.toml")

  mkdir -p "src/${pkg_name}"
  cat > "src/${pkg_name}/__init__.py" <<'EOF'
EOF
  cat > "src/${pkg_name}/main.py" <<'PYEOF'
import argparse


def main() -> None:
    parser = argparse.ArgumentParser(description="CLI tool")
    parser.add_argument("--version", action="version", version="%(prog)s 0.1.0")
    parser.parse_args()

    # TODO: implement CLI logic
    print("Hello from CLI")


if __name__ == "__main__":
    main()
PYEOF
  FILES_CREATED+=("src/${pkg_name}/__init__.py" "src/${pkg_name}/main.py")

  mkdir -p tests
  cat > tests/__init__.py <<'EOF'
EOF
  cat > "tests/test_main.py" <<PYEOF
from unittest.mock import patch

from src.${pkg_name}.main import main


def test_cli_runs(capsys):
    with patch("sys.argv", ["prog"]):
        main()
    captured = capsys.readouterr()
    assert "Hello from CLI" in captured.out


def test_cli_help(capsys):
    with patch("sys.argv", ["prog", "--help"]):
        try:
            main()
        except SystemExit as e:
            assert e.code == 0
    captured = capsys.readouterr()
    assert "usage" in captured.out.lower() or "help" in captured.out.lower()
PYEOF
  FILES_CREATED+=("tests/__init__.py" "tests/test_main.py")

  mkdir -p scripts
  cat > scripts/qa.sh <<'QAEOF'
#!/usr/bin/env bash
set -euo pipefail

# --- Shared QA toolchain ---
TOOLCHAIN="$HOME/.openclaw/toolchains/python"
if [[ -d "$TOOLCHAIN/bin" ]]; then
  export PATH="$TOOLCHAIN/bin:$PATH"
elif command -v ruff &>/dev/null; then
  : # ruff available globally, proceed
else
  echo "[qa] WARNING: No QA toolchain found at $TOOLCHAIN" >&2
fi

echo "=== QA Gate ==="
FAIL=0

echo "--- Ruff lint ---"
ruff check src/ tests/ 2>&1 || { echo "RUFF FAILED"; FAIL=1; }

echo "--- Mypy ---"
mypy src/ 2>&1 || { echo "MYPY FAILED"; FAIL=1; }

echo "--- Tests ---"
python -m pytest tests/ -v 2>&1 || { echo "TESTS FAILED"; FAIL=1; }

echo "--- Coverage (>=80%) ---"
python -m pytest tests/ -q --cov=src --cov-report=term-missing --cov-fail-under=80 2>&1 || { echo "COVERAGE FAILED"; FAIL=1; }

echo "--- Secrets scan ---"
if grep -rn 'password\s*=\s*"[^"]\+"\|api_key\s*=\s*"[^"]\+"\|secret\s*=\s*"[^"]\+"' --include="*.py" src/ 2>/dev/null; then
  echo "SECRETS FOUND — FAIL"; FAIL=1
else
  echo "No hardcoded secrets found"
fi

exit $FAIL
QAEOF
  chmod +x scripts/qa.sh
  FILES_CREATED+=("scripts/qa.sh")
}

# ===================================================================
# Run scaffold for detected stack
# ===================================================================

OBJECTIVE="$(echo "$SPEC" | jq -r '.objective // empty')"
if [[ -z "$OBJECTIVE" ]]; then
  OBJECTIVE="${GENESIS_IDEA:-Auto-scaffolded project}"
fi

case "$STACK" in
  nextjs)    scaffold_nextjs ;;
  node-cli)  scaffold_node_cli ;;
  express)   scaffold_express ;;
  fastapi)  scaffold_fastapi ;;
  flask)    scaffold_flask ;;
  django)      scaffold_django ;;
  python-cli)  scaffold_python_cli ;;
  *)
    echo "ERROR: Unknown stack '$STACK'" >&2
    exit 1
    ;;
esac

# Common files
scaffold_readme "$REPO_NAME" "$STACK" "$OBJECTIVE"
scaffold_ci_workflow

# --- Commit and push ---
echo "Committing initial scaffold..." >&2
git add -A >&2
git commit -m "chore: initial scaffold ($STACK) — Genesis Flow" --allow-empty >&2 || true

# Ensure main branch
git branch -M main 2>/dev/null || true

echo "Pushing to origin..." >&2
if ! git push -u origin main >&2; then
  echo "ERROR: Push failed — remote repository is not ready for registration" >&2
  exit 1
fi

# --- Write sideband file ---
SCAFFOLD_PAYLOAD="$(jq -n \
  --arg stack "$STACK" \
  --arg repo_url "$REPO_URL" \
  --arg repo_local "$REPO_LOCAL" \
  --arg slug "$REPO_NAME" \
  --argjson files "$(printf '%s\n' "${FILES_CREATED[@]}" | jq -R . | jq -s .)" \
  '{
    scaffold: {
      created: true,
      stack: $stack,
      repo_url: $repo_url,
      repo_local: $repo_local,
      project_slug: $slug,
      files_created: $files
    }
  }')"
SIDEBAND="$(genesis_sideband_write "scaffold" "$SESSION_ID" "$SCAFFOLD_PAYLOAD")"

echo "Sideband written to $SIDEBAND" >&2
echo "Scaffold complete: $STACK project at $REPO_LOCAL" >&2

# --- Output ---
echo "$INPUT" | jq \
  --arg stack "$STACK" \
  --arg repo_url "$REPO_URL" \
  --arg repo_local "$REPO_LOCAL" \
  --arg slug "$REPO_NAME" \
  --argjson files "$(printf '%s\n' "${FILES_CREATED[@]}" | jq -R . | jq -s .)" \
  '. + {
    scaffold: {
      created: true,
      stack: $stack,
      repo_url: $repo_url,
      repo_local: $repo_local,
      project_slug: $slug,
      files_created: $files
    }
  }'

genesis_metric_end "ok"
