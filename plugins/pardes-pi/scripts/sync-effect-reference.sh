#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$plugin_root/../.." && pwd)"
checkout="$plugin_root/docs/references/effect-smol"
remote="https://github.com/Effect-TS/effect-smol.git"
version="$(cd "$repo_root" && bun -e 'console.log(require("./package.json").dependencies.effect)')"
tag="effect@$version"

if [ ! -d "$checkout/.git" ]; then
  mkdir -p "$(dirname "$checkout")"
  git clone --filter=blob:none --no-checkout "$remote" "$checkout"
fi

git -C "$checkout" fetch --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
git -C "$checkout" checkout --detach "$tag"
printf 'Effect reference checkout: %s at %s\n' "$tag" "$(git -C "$checkout" rev-parse HEAD)"
