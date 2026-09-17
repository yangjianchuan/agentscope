# -*- coding: utf-8 -*-
"""Skill router — the user's own library of installed skills.

The skill counterpart of :mod:`._mcp`: this is the user-level collection
an install lands in, distinct from ``/workspace/skill``, which manages
the skills present in one session's workspace.
"""
import asyncio
import os
from pathlib import Path
import subprocess
import sys

from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import get_current_user_id, get_skill_hubs, get_storage
from ..hub import SkillHubBase
from ..storage import SkillRecord, StorageBase
from ._schema import SkillDetail, SkillView, UpdateSkillRequest

skill_router = APIRouter(prefix="/skill", tags=["skill"])


def _local_skill_directory(
    record: SkillRecord,
    hubs: dict[str, SkillHubBase],
) -> Path | None:
    """Resolve a record through its registered hub to a trusted directory."""
    if record.hub_id is None or record.card_id is None:
        return None
    hub = hubs.get(record.hub_id)
    if hub is None:
        return None
    raw_path = hub.get_local_directory(record.card_id)
    if raw_path is None:
        return None
    path = Path(raw_path).expanduser().resolve()
    return path if path.is_dir() else None


def _can_delete_skill(
    record: SkillRecord,
    hubs: dict[str, SkillHubBase],
) -> bool:
    """Resolve whether the record's source hub allows library deletion."""
    if record.hub_id is None or record.card_id is None:
        return True
    hub = hubs.get(record.hub_id)
    if hub is None:
        return True
    return hub.can_delete_library_record(record.card_id)


def _open_local_directory(path: Path) -> None:
    """Open a directory in the server host's native file manager."""
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
        return

    command = ["open", str(path)] if sys.platform == "darwin" else [
        "xdg-open",
        str(path),
    ]
    subprocess.Popen(  # pylint: disable=consider-using-with
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


@skill_router.get("")
async def list_skills(
    user_id: str = Depends(get_current_user_id),
    storage: StorageBase = Depends(get_storage),
    hubs: dict[str, SkillHubBase] = Depends(get_skill_hubs),
) -> list[SkillView]:
    """Return every skill the user has installed, ordered by name."""
    records = await storage.list_skills(user_id)
    return sorted(
        (
            SkillView.from_record(
                r,
                can_open_folder=_local_skill_directory(r, hubs) is not None,
                can_delete=_can_delete_skill(r, hubs),
            )
            for r in records
        ),
        key=lambda view: view.name,
    )


@skill_router.get("/{skill_id}")
async def get_skill(
    skill_id: str,
    user_id: str = Depends(get_current_user_id),
    storage: StorageBase = Depends(get_storage),
    hubs: dict[str, SkillHubBase] = Depends(get_skill_hubs),
) -> SkillDetail:
    """Return one installed skill, including its ``SKILL.md`` body."""
    record = await storage.get_skill(user_id, skill_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No installed skill with id {skill_id!r}.",
        )
    return SkillDetail.from_record(
        record,
        can_open_folder=_local_skill_directory(record, hubs) is not None,
        can_delete=_can_delete_skill(record, hubs),
    )


@skill_router.patch("/{skill_id}")
async def update_skill(
    skill_id: str,
    body: UpdateSkillRequest,
    user_id: str = Depends(get_current_user_id),
    storage: StorageBase = Depends(get_storage),
    hubs: dict[str, SkillHubBase] = Depends(get_skill_hubs),
) -> SkillView:
    """Enable or disable one installed skill."""
    record = await storage.get_skill(user_id, skill_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No installed skill with id {skill_id!r}.",
        )
    record.enabled = body.enabled
    await storage.upsert_skill(user_id, record)
    return SkillView.from_record(
        record,
        can_open_folder=_local_skill_directory(record, hubs) is not None,
        can_delete=_can_delete_skill(record, hubs),
    )


@skill_router.post(
    "/{skill_id}/open-folder",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def open_skill_folder(
    skill_id: str,
    user_id: str = Depends(get_current_user_id),
    storage: StorageBase = Depends(get_storage),
    hubs: dict[str, SkillHubBase] = Depends(get_skill_hubs),
) -> None:
    """Open an installed skill's trusted local directory on the server."""
    record = await storage.get_skill(user_id, skill_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No installed skill with id {skill_id!r}.",
        )
    directory = _local_skill_directory(record, hubs)
    if directory is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This skill does not have a local folder on the server.",
        )
    try:
        await asyncio.to_thread(_open_local_directory, directory)
    except (OSError, subprocess.SubprocessError) as error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not open the skill folder: {error}",
        ) from error


@skill_router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(
    skill_id: str,
    user_id: str = Depends(get_current_user_id),
    storage: StorageBase = Depends(get_storage),
    hubs: dict[str, SkillHubBase] = Depends(get_skill_hubs),
) -> None:
    """Remove a skill from the user's library.

    Workspaces that already hold this skill keep their copy — the files
    were extracted into the workspace, and this record was only where
    they came from.
    """
    record = await storage.get_skill(user_id, skill_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No installed skill with id {skill_id!r}.",
        )
    if not _can_delete_skill(record, hubs):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This skill is read-only and cannot be deleted.",
        )
    if not await storage.delete_skill(user_id, skill_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No installed skill with id {skill_id!r}.",
        )
