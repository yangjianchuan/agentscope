# -*- coding: utf-8 -*-
"""Tests for the example service's Codex skill discovery."""

import os
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path
from unittest import TestCase
from unittest.async_case import IsolatedAsyncioTestCase

from agentscope.workspace import LocalWorkspace
from examples.agent_service.skill_discovery import (
    CodexSkillHub,
    CodexSkillLocalWorkspaceManager,
    CodexSkillSQLStorage,
    discover_codex_skill_paths,
)


class TestCodexSkillDiscovery(TestCase):
    """Codex skills are discovered recursively and deterministically."""

    @staticmethod
    def _make_skill(root: Path, relative_path: str) -> Path:
        """Create a minimal skill directory and return it."""
        skill_dir = root / relative_path
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: test\ndescription: test skill\n---\n",
            encoding="utf-8",
        )
        return skill_dir

    def test_missing_codex_skills_root_returns_empty_list(self) -> None:
        """An absent user-level Codex directory is optional."""
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / ".codex" / "skills"
            self.assertListEqual(discover_codex_skill_paths(missing), [])

    def test_discovers_regular_and_system_skills_recursively(self) -> None:
        """Regular and nested bundled Codex skills are both included."""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / ".codex" / "skills"
            regular = self._make_skill(root, "regular-skill")
            system = self._make_skill(root, ".system/system-skill")
            (root / "README.md").write_text("not a skill", encoding="utf-8")

            paths = discover_codex_skill_paths(root)

            self.assertListEqual(
                paths,
                sorted(
                    [str(regular.resolve()), str(system.resolve())],
                    key=os.path.normcase,
                ),
            )


class TestCodexSkillWorkspaceManager(IsolatedAsyncioTestCase):
    """Codex skills also reach agent partitions that already exist."""

    async def test_syncs_codex_skills_into_existing_partition(self) -> None:
        """An agent created before the feature receives Codex skills."""
        with (
            tempfile.TemporaryDirectory() as basedir,
            tempfile.TemporaryDirectory() as source_dir,
        ):
            agent_id = "existing-agent"
            workdir = os.path.join(basedir, agent_id)
            old_workspace = LocalWorkspace(workdir=workdir)
            await old_workspace.initialize()
            await old_workspace.list_skills(agent_id=agent_id)
            await old_workspace.close()

            skill_dir = Path(source_dir) / "codex-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\nname: codex-skill\ndescription: imported\n---\n",
                encoding="utf-8",
            )

            manager = CodexSkillLocalWorkspaceManager(
                basedir,
                codex_skill_paths=[str(skill_dir)],
            )
            workspace = await manager.get_workspace(
                user_id="user",
                agent_id=agent_id,
                session_id="session",
                workspace_id="workspace",
            )
            skills = await workspace.list_skills(agent_id=agent_id)

            self.assertListEqual(
                [skill.name for skill in skills],
                ["codex-skill"],
            )
            await manager.close_all()


class TestCodexSkillLibrary(IsolatedAsyncioTestCase):
    """Codex skills are mirrored into the installed-skill library."""

    async def test_syncs_library_metadata_and_downloads_archive(self) -> None:
        """Library records retain a working local Hub provenance."""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / ".codex" / "skills"
            skill_dir = root / ".system" / "sample"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: sample\ndescription: Sample skill\n---\n\nBody\n",
                encoding="utf-8",
            )
            (skill_dir / "tool.py").write_text("pass\n", encoding="utf-8")

            hub = CodexSkillHub([str(skill_dir)], skills_root=root)
            database = Path(temp_dir) / "skills.db"
            storage = CodexSkillSQLStorage(
                url=f"sqlite+aiosqlite:///{database}",
                codex_hub=hub,
            )
            async with storage:
                records = await storage.list_skills("alice")
                detail = await storage.get_skill("alice", records[0].id)

            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].hub_id, "codex-local")
            self.assertEqual(records[0].card_id, ".system/sample")
            self.assertEqual(detail.markdown.strip(), "Body")
            self.assertEqual(
                hub.get_local_directory(".system/sample"),
                str(skill_dir),
            )
            self.assertFalse(
                hub.can_delete_library_record(".system/sample"),
            )

            archive = await hub.download("alice", ".system/sample")
            payload = b"".join([chunk async for chunk in archive.stream])
            with zipfile.ZipFile(BytesIO(payload)) as zipped:
                self.assertEqual(
                    sorted(zipped.namelist()),
                    ["SKILL.md", "tool.py"],
                )
