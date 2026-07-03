#!/bin/bash
set -e

# Worktree Setup Script
# Runs when a Conductor workspace is created:
#   1. Syncs with origin so the worktree starts from the latest changes
#   2. Sets the branch upstream so Conductor can map the workspace to its PR
#   3. Installs dependencies
#
# Flags:
#   --skip-install  Skip `npm install`

SKIP_INSTALL=0
for arg in "$@"; do
    case "$arg" in
        --skip-install) SKIP_INSTALL=1 ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "Usage: worktree-setup.sh [--skip-install]" >&2
            exit 1
            ;;
    esac
done

echo "Setting up notion-x-bookmarks-sync worktree..."

# Sync with remote and fast-forward if possible
echo ""
echo "Syncing with remote..."
git fetch --force --tags origin
CURRENT_BRANCH=$(git branch --show-current)
if [ -n "$CURRENT_BRANCH" ]; then
    # Fast-forward only when we haven't diverged from master
    if git merge-base --is-ancestor HEAD origin/master 2>/dev/null; then
        git merge --ff-only origin/master 2>/dev/null && echo "Fast-forwarded to origin/master" || true
    fi
    # Map the branch to its matching remote branch (never fall back to master for
    # feature branches — that can make Conductor auto-archive the workspace).
    if [ "$CURRENT_BRANCH" = "master" ]; then
        git branch --set-upstream-to=origin/master 2>/dev/null && echo "Set upstream to origin/master" || true
    elif git rev-parse --verify "origin/$CURRENT_BRANCH" >/dev/null 2>&1; then
        git branch --set-upstream-to="origin/$CURRENT_BRANCH" 2>/dev/null && echo "Set upstream to origin/$CURRENT_BRANCH" || true
    fi
fi

# Verify Node 22+
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1 || echo "0")
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "Error: Node 22+ required (found v$NODE_VERSION)"
    echo "Install with: nvm install 22 && nvm use 22"
    exit 1
fi
echo "Node $(node -v)"

# Install dependencies
if [ "$SKIP_INSTALL" -eq 0 ]; then
    echo ""
    echo "Installing dependencies..."
    npm install
fi

echo ""
echo "Worktree ready."
