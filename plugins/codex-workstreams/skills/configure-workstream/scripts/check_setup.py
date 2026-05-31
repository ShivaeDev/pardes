#!/usr/bin/env python3
"""Report whether Codex workstream artifacts have a configured writable root."""

from __future__ import annotations

import argparse
import json
import os
import tomllib
from pathlib import Path
from typing import Any


ARTIFACT_SUBDIRECTORIES = ("workstreams", "pr-bodies", "reports")


def normalized(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def configured_root(value: object, artifact_root: Path) -> bool:
    return isinstance(value, str) and normalized(value) == artifact_root


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return tomllib.loads(path.read_text())


def diagnose(config_path: Path, artifact_root: Path) -> dict[str, Any]:
    config_path = normalized(config_path)
    artifact_root = normalized(artifact_root)
    config = load_config(config_path)
    legacy = config.get("sandbox_workspace_write")
    legacy_roots = legacy.get("writable_roots", []) if isinstance(legacy, dict) else []
    if not isinstance(legacy_roots, list):
        legacy_roots = []

    profiles = config.get("permissions")
    profiles = profiles if isinstance(profiles, dict) else {}
    active_profile = config.get("default_permissions")
    active_profile = active_profile if isinstance(active_profile, str) else None
    profile = profiles.get(active_profile) if active_profile else None
    profile_roots = profile.get("workspace_roots", {}) if isinstance(profile, dict) else {}
    if not isinstance(profile_roots, dict):
        profile_roots = {}

    if profiles or active_profile:
        style = "permission_profiles"
        root_is_configured = any(
            enabled is True and configured_root(path, artifact_root)
            for path, enabled in profile_roots.items()
        )
        fragment = (
            f"[permissions.{active_profile or '<profile>'}.workspace_roots]\n"
            f'"{artifact_root}" = true'
        )
    elif isinstance(legacy, dict):
        style = "legacy"
        root_is_configured = any(configured_root(value, artifact_root) for value in legacy_roots)
        fragment = (
            "[sandbox_workspace_write]\n"
            f'writable_roots = ["{artifact_root}"]'
        )
    else:
        style = "unconfigured"
        root_is_configured = False
        fragment = (
            "[sandbox_workspace_write]\n"
            f'writable_roots = ["{artifact_root}"]'
        )

    directories = {
        name: str(artifact_root / name)
        for name in ARTIFACT_SUBDIRECTORIES
    }
    missing_directories = [
        path
        for path in directories.values()
        if not Path(path).is_dir()
    ]
    return {
        "active_permission_profile": active_profile,
        "artifact_root": str(artifact_root),
        "config_path": str(config_path),
        "configuration_style": style,
        "configured": root_is_configured,
        "directories": directories,
        "missing_directories": missing_directories,
        "recommended_fragment": fragment,
        "restart_required_after_change": True,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="override the Codex config.toml path")
    parser.add_argument("--artifacts-dir", help="override the shared artifact directory")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    codex_home = normalized(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    config_path = normalized(args.config) if args.config else codex_home / "config.toml"
    artifact_root = normalized(
        args.artifacts_dir
        or os.environ.get("CODEX_ARTIFACTS_DIR", Path.home() / "codex-artifacts")
    )
    try:
        print(json.dumps(diagnose(config_path, artifact_root), indent=2, sort_keys=True))
        return 0
    except (OSError, tomllib.TOMLDecodeError) as exc:
        print(json.dumps({"config_path": str(config_path), "error": str(exc)}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
