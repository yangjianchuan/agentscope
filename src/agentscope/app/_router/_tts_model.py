# -*- coding: utf-8 -*-
"""The TTS model router."""

from fastapi import APIRouter, Depends, HTTPException, status

from ._schema import ListTTSModelsResponse, ListTTSModelsRequest
from .._service import ResourceAccessService
from .._service._model_catalog import list_remote_tts_models
from ..deps import get_current_user_id, get_resource_access_service
from ...credential import CredentialFactory

tts_model_router = APIRouter(
    prefix="/tts-model",
    tags=["tts-model"],
    responses={404: {"description": "Not found"}},
)


@tts_model_router.get(
    "/",
    response_model=ListTTSModelsResponse,
    summary="List all candidate TTS models under the given credential type",
)
async def list_tts_models(
    body: ListTTSModelsRequest = Depends(),
    user_id: str = Depends(get_current_user_id),
    access: ResourceAccessService = Depends(get_resource_access_service),
) -> ListTTSModelsResponse:
    """Return all candidate TTS models under the given credential type.

    Args:
        body (ListTTSModelsRequest): The request body.

    Returns:
        `ListTTSModelsResponse`: The response body.
    """
    credential_cls = CredentialFactory.get_credential_class(body.provider)
    if credential_cls is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Provider '{body.provider}' not found.",
        )

    tts_classes = credential_cls.get_tts_model_classes()
    if body.credential_id:
        record = await access.resolve_credential(user_id, body.credential_id)
        remote = await list_remote_tts_models(
            record.data or {},
            tts_classes,
        )
        if remote is not None:
            return ListTTSModelsResponse(models=remote, total=len(remote))

    models = credential_cls.list_tts_models()
    return ListTTSModelsResponse(models=models, total=len(models))
