# -*- coding: utf-8 -*-
"""The embedding model router."""

from fastapi import APIRouter, Depends, HTTPException, status

from ._schema import ListEmbeddingModelsResponse, ListEmbeddingModelsRequest
from .._service import ResourceAccessService
from .._service._model_catalog import list_remote_embedding_models
from ..deps import get_current_user_id, get_resource_access_service
from ...credential import CredentialFactory

embedding_model_router = APIRouter(
    prefix="/embedding-model",
    tags=["embedding-model"],
    responses={404: {"description": "Not found"}},
)


@embedding_model_router.get(
    "/",
    response_model=ListEmbeddingModelsResponse,
    summary=(
        "List all candidate embedding models under the given credential type"
    ),
)
async def list_embedding_models(
    body: ListEmbeddingModelsRequest = Depends(),
    user_id: str = Depends(get_current_user_id),
    access: ResourceAccessService = Depends(get_resource_access_service),
) -> ListEmbeddingModelsResponse:
    """Return all candidate embedding models under the credential type.

    Unlike ``/knowledge_bases/embedding_models``, which narrows the
    list to what the knowledge base's dimension policy accepts, this
    endpoint reports the provider's full catalogue — it answers "what
    can this credential do", not "what can I build a KB with".

    Args:
        body (ListEmbeddingModelsRequest): The request body.

    Returns:
        `ListEmbeddingModelsResponse`: The response body.
    """
    credential_cls = CredentialFactory.get_credential_class(body.provider)
    if credential_cls is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Provider '{body.provider}' not found.",
        )

    embedding_cls = credential_cls.get_embedding_model_class()
    # Providers without embedding support report an empty catalogue
    # rather than 404 — "none available" is a valid answer here.
    if embedding_cls is None:
        return ListEmbeddingModelsResponse(models=[], total=0)

    if body.credential_id:
        record = await access.resolve_credential(user_id, body.credential_id)
        remote = await list_remote_embedding_models(
            record.data or {},
            embedding_cls,
        )
        if remote is not None:
            return ListEmbeddingModelsResponse(
                models=remote,
                total=len(remote),
            )

    models = embedding_cls.list_models()
    return ListEmbeddingModelsResponse(models=models, total=len(models))
