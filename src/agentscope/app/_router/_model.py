# -*- coding: utf-8 -*-
"""Model list router."""
from fastapi import APIRouter, Depends, HTTPException, status
from ._schema import ListModelsResponse, ListModelsRequest
from ..deps import get_current_user_id, get_resource_access_service
from .._service import ResourceAccessService
from .._service._model_catalog import list_remote_chat_models
from ...credential import CredentialFactory

model_router = APIRouter(
    prefix="/model",
    tags=["model"],
    responses={404: {"description": "Not found"}},
)


@model_router.get(
    "/",
    response_model=ListModelsResponse,
    summary="List candidate models",
)
async def list_models(
    body: ListModelsRequest = Depends(),
    user_id: str = Depends(get_current_user_id),
    access: ResourceAccessService = Depends(get_resource_access_service),
) -> ListModelsResponse:
    cls = CredentialFactory.get_credential_class(body.provider)
    if cls is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Provider '{body.provider}' not found.",
        )
    model_cls = cls.get_chat_model_class()
    if body.credential_id:
        record = await access.resolve_credential(user_id, body.credential_id)
        remote = await list_remote_chat_models(record.data or {}, model_cls)
        if remote is not None:
            return ListModelsResponse(models=remote, total=len(remote))
    models = model_cls.list_models()
    return ListModelsResponse(models=models, total=len(models))

