#!/usr/bin/env python3
"""Regression tests for the Codex workstream setup doctor."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check_setup.py")
SPEC = importlib.util.spec_from_file_location("check_setup", SCRIPT)
assert SPEC and SPEC.loader
check_setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_setup)


class CheckSetupTest(unittest.TestCase):
    def test_missing_config_recommends_legacy_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = check_setup.diagnose(root / "config.toml", root / "codex-artifacts")

        self.assertEqual(report["configuration_style"], "unconfigured")
        self.assertFalse(report["configured"])
        self.assertIn("[sandbox_workspace_write]", report["recommended_fragment"])

    def test_legacy_root_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            artifacts = root / "codex-artifacts"
            config = root / "config.toml"
            config.write_text(
                "[sandbox_workspace_write]\n"
                f'writable_roots = ["{artifacts}"]\n'
            )

            report = check_setup.diagnose(config, artifacts)

        self.assertEqual(report["configuration_style"], "legacy")
        self.assertTrue(report["configured"])

    def test_active_permission_profile_root_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            artifacts = root / "codex-artifacts"
            config = root / "config.toml"
            config.write_text(
                'default_permissions = "workstream"\n'
                "[permissions.workstream.workspace_roots]\n"
                f'"{artifacts}" = true\n'
            )

            report = check_setup.diagnose(config, artifacts)

        self.assertEqual(report["configuration_style"], "permission_profiles")
        self.assertEqual(report["active_permission_profile"], "workstream")
        self.assertTrue(report["configured"])


if __name__ == "__main__":
    unittest.main()
