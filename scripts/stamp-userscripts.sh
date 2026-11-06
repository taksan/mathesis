#!/usr/bin/env bash
# Sets @version of the userscripts changed by a commit to "<commit count>.<short sha>" of that commit.
# Usage: scripts/stamp-userscripts.sh [commit]   (default HEAD), then commit the result.
# The count grows with every commit, so extension update checks always see a newer version;
# the sha says exactly which commit it is. A commit cannot contain its own sha, so stamp after committing.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
commit="$(git rev-parse --verify "${1:-HEAD}^{commit}")"
version="$(git rev-list --count "$commit").$(git rev-parse --short "$commit")"
for file in $(git diff-tree --no-commit-id --name-only -r "$commit" -- 'userscript/*.user.js'); do
  [ -f "$file" ] || continue
  sed -i "s|^// @version .*|// @version      $version|" "$file"
  echo "$file -> $version"
done
