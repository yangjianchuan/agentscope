# -*- coding: utf-8 -*-
"""Local skill discovery helpers for the example agent service."""

import asyncio
import io
import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator
import zipfile

import frontmatter
from agentscope.app.hub import (
    SkillArchive,
    SkillCard,
    SkillHubBase,
    SkillHubPage,
)
from agentscope.app.storage import AsyncSQLAlchemyStorage, SkillRecord
from agentscope.app.workspace_manager import LocalWorkspaceManager
from agentscope.workspace import LocalWorkspace

logger = logging.getLogger(__name__)


def discover_codex_skill_paths(
    skills_root: str | os.PathLike[str] | None = None,
) -> list[str]:
    """Return Codex skill directories under the current user's home.

    Codex stores user-level skills below ``~/.codex/skills``. Both regular
    skills and bundled skills below directories such as ``.system`` are
    discovered by locating their ``SKILL.md`` files recursively.

    Args:
        skills_root (`str | os.PathLike[str] | None`, optional):
            Override the Codex skills root. Primarily useful for tests.

    Returns:
        `list[str]`: Absolute skill directory paths in stable order.
    """
    root = (
        Path(skills_root)
        if skills_root is not None
        else Path.home() / ".codex" / "skills"
    )
    root = root.expanduser().resolve()
    if not root.is_dir():
        return []

    skill_paths: list[str] = []
    for current_root, _, filenames in os.walk(root):
        if "SKILL.md" in filenames:
            skill_paths.append(os.path.abspath(current_root))

    return sorted(skill_paths, key=os.path.normcase)


class CodexSkillHub(SkillHubBase):
    """Expose the current user's Codex skills as a local Skill Hub."""

    def __init__(
        self,
        skill_paths: list[str],
        skills_root: str | os.PathLike[str] | None = None,
    ) -> None:
        """Load valid skill metadata from the discovered directories."""
        super().__init__(
            hub_id="codex-local",
            display_name="Codex Local",
            description="Skills from the current user's ~/.codex/skills.",
        )
        self.skill_paths = list(skill_paths)
        self.skills_root = (
            Path(skills_root)
            if skills_root is not None
            else Path.home() / ".codex" / "skills"
        ).expanduser().resolve()
        self._cards: dict[str, SkillCard] = {}
        self._paths: dict[str, str] = {}
        for skill_path in self.skill_paths:
            card = self._load_card(skill_path)
            if card is None:
                continue
            self._cards[card.id] = card
            self._paths[card.id] = skill_path

    def _load_card(self, skill_path: str) -> SkillCard | None:
        """Parse one local ``SKILL.md`` into a hub card."""
        skill_md = Path(skill_path) / "SKILL.md"
        try:
            raw = skill_md.read_text(encoding="utf-8")
            parsed = frontmatter.loads(raw)
            name = str(parsed.get("name") or "").strip()
            description = str(parsed.get("description") or "").strip()
            if not name or not description:
                return None
            try:
                card_id = Path(skill_path).resolve().relative_to(
                    self.skills_root,
                ).as_posix()
            except ValueError:
                card_id = Path(skill_path).name
            return SkillCard(
                hub_id=self.hub_id,
                id=card_id,
                name=name,
                display_name=name,
                description=description,
                tags=["codex", "local"],
                updated_at=skill_md.stat().st_mtime,
                author="Codex",
                markdown=parsed.content,
            )
        except (OSError, UnicodeError, ValueError) as error:
            logger.warning(
                "Failed to read Codex skill %s: %s",
                skill_path,
                error,
            )
            return None

    @property
    def cards(self) -> list[SkillCard]:
        """Return all local cards in deterministic order."""
        return sorted(self._cards.values(), key=lambda card: card.name.lower())

    async def list_skills(
        self,
        user_id: str,
        q: str | None = None,
        cursor: str | None = None,
        limit: int = 20,
    ) -> SkillHubPage:
        """List local Codex skills with cursor-based pagination."""
        del user_id
        cards = self.cards
        if q:
            needle = q.lower()
            cards = [
                card
                for card in cards
                if needle in card.name.lower()
                or needle in card.description.lower()
            ]
        try:
            start = max(0, int(cursor or 0))
        except ValueError:
            start = 0
        end = start + limit
        return SkillHubPage(
            cards=[
                card.model_copy(update={"markdown": None})
                for card in cards[start:end]
            ],
            next_cursor=str(end) if end < len(cards) else None,
        )

    async def get_skill(self, user_id: str, card_id: str) -> SkillCard:
        """Return one local Codex skill including its Markdown body."""
        del user_id
        card = self._cards.get(card_id)
        if card is None:
            raise KeyError(card_id)
        return card.model_copy(deep=True)

    def get_local_directory(self, card_id: str) -> str | None:
        """Return the trusted local directory for a Codex skill card."""
        return self._paths.get(card_id)

    def can_delete_library_record(self, card_id: str) -> bool:
        """Keep mirrored Codex skills read-only in the user library."""
        del card_id
        return False

    async def download(
        self,
        user_id: str,
        card_id: str,
        version: str | None = None,
    ) -> SkillArchive:
        """Package one local skill as a ZIP archive for workspace install."""
        del user_id, version
        skill_path = self._paths.get(card_id)
        if skill_path is None:
            raise KeyError(card_id)

        def _build_zip() -> bytes:
            buffer = io.BytesIO()
            root = Path(skill_path)
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                for current_root, dirnames, filenames in os.walk(root):
                    dirnames[:] = [
                        name for name in dirnames if name != "__pycache__"
                    ]
                    for filename in filenames:
                        if filename.endswith(".pyc"):
                            continue
                        path = Path(current_root) / filename
                        archive.write(path, path.relative_to(root).as_posix())
            return buffer.getvalue()

        payload = await asyncio.to_thread(_build_zip)

        async def _stream() -> AsyncIterator[bytes]:
            yield payload

        return SkillArchive(format="zip", stream=_stream())


class CodexSkillSQLStorage(AsyncSQLAlchemyStorage):
    """SQL storage that mirrors local Codex skills into each user library."""

    def __init__(
        self,
        *args: Any,
        codex_hub: CodexSkillHub,
        **kwargs: Any,
    ) -> None:
        """Initialize SQL storage with the local Codex skill source."""
        super().__init__(*args, **kwargs)
        self._codex_hub = codex_hub
        self._codex_synced_users: set[str] = set()
        self._codex_sync_lock = asyncio.Lock()

    async def _sync_codex_skills(self, user_id: str) -> None:
        """Create, update and remove managed Codex library records."""
        if user_id in self._codex_synced_users:
            return
        async with self._codex_sync_lock:
            if user_id in self._codex_synced_users:
                return

            cards = self._codex_hub.cards
            current_ids = {card.id for card in cards}
            existing_records = await super().list_skills(user_id)
            for record in existing_records:
                if (
                    record.hub_id == self._codex_hub.hub_id
                    and record.card_id not in current_ids
                ):
                    await super().delete_skill(user_id, record.id)

            for card in cards:
                existing = await super().get_skill_by_name(user_id, card.name)
                if (
                    existing is not None
                    and existing.hub_id != self._codex_hub.hub_id
                ):
                    continue
                identity: dict[str, Any] = {}
                if existing is not None:
                    identity = {
                        "id": existing.id,
                        "created_at": existing.created_at,
                        "enabled": existing.enabled,
                    }
                record = SkillRecord(
                    user_id=user_id,
                    name=card.name,
                    display_name=card.display_name,
                    description=card.description,
                    tags=card.tags,
                    author=card.author,
                    markdown=card.markdown or "",
                    hub_id=card.hub_id,
                    card_id=card.id,
                    version=card.version,
                    **identity,
                )
                await super().upsert_skill(user_id, record)

            self._codex_synced_users.add(user_id)

    async def list_skills(self, user_id: str) -> list[SkillRecord]:
        """Synchronize Codex skills before returning the user's library."""
        await self._sync_codex_skills(user_id)
        return await super().list_skills(user_id)


class CodexSkillLocalWorkspaceManager(LocalWorkspaceManager):
    """Local workspace manager that also imports user-level Codex skills.

    ``skill_paths`` seeds brand-new agent partitions. The explicit merge in
    :meth:`get_workspace` also covers partitions created before this feature
    was enabled, while the workspace's normal hash-based deduplication keeps
    repeated service calls idempotent.
    """

    def __init__(
        self,
        basedir: str,
        *,
        codex_skill_paths: list[str],
        **kwargs: Any,
    ) -> None:
        """Initialize the manager with discovered Codex skill paths."""
        self._codex_skill_paths = list(codex_skill_paths)
        self._codex_synced_agents: set[tuple[str, str]] = set()
        self._codex_sync_lock = asyncio.Lock()
        super().__init__(
            basedir,
            skill_paths=self._codex_skill_paths,
            **kwargs,
        )

    async def get_workspace(
        self,
        user_id: str,
        agent_id: str,
        session_id: str,
        workspace_id: str | None = None,
    ) -> LocalWorkspace:
        """Return a workspace after importing Codex skills for the agent."""
        workspace = await super().get_workspace(
            user_id=user_id,
            agent_id=agent_id,
            session_id=session_id,
            workspace_id=workspace_id,
        )
        sync_key = (workspace.workspace_id, agent_id)
        if sync_key in self._codex_synced_agents:
            return workspace

        async with self._codex_sync_lock:
            if sync_key in self._codex_synced_agents:
                return workspace
            for skill_path in self._codex_skill_paths:
                try:
                    await workspace.add_skill(skill_path, agent_id=agent_id)
                except (OSError, ValueError) as error:
                    logger.warning(
                        "Failed to import Codex skill from %s: %s",
                        skill_path,
                        error,
                    )
            self._codex_synced_agents.add(sync_key)

        return workspace
