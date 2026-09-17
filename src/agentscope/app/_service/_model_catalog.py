# -*- coding: utf-8 -*-
"""Remote model catalogue helpers for OpenAI-compatible credentials."""
import copy
import re
from typing import Any, Type

import httpx
from pydantic import BaseModel

from ...embedding import EmbeddingModelCard, EmbeddingModelBase
from ...model import ChatModelBase, ModelCard
from ...tts import TTSModelBase, TTSModelCard


_TTS_ENDPOINT_TYPES = {
    "audio-speech",
    "speech",
    "text-to-speech",
    "tts",
}
_EMBEDDING_ENDPOINT_TYPES = {"embedding", "embeddings"}
_TTS_NAME_PATTERN = re.compile(
    r"(^|[-_/.])(tts|text-to-speech|cosyvoice)([-_/.]|$)",
)
_EMBEDDING_NAME_PATTERN = re.compile(
    r"(^|[-_/.])(embedding|embeddings|embed|bge|e5|gte)([-_/.]|$)",
)
_DIMENSION_KEYS = (
    "dimensions",
    "dimension",
    "embedding_dimensions",
    "output_dimensions",
)
_CONTEXT_SIZE_KEYS = (
    "context_size",
    "context_length",
    "context_window",
    "max_context_length",
    "max_model_len",
    "input_token_limit",
    "max_input_tokens",
)
_OUTPUT_SIZE_KEYS = (
    "output_size",
    "max_output_tokens",
    "max_completion_tokens",
    "output_token_limit",
    "max_output_length",
)
_MODEL_METADATA_KEYS = (
    "capabilities",
    "limits",
    "metadata",
    "model_info",
    "top_provider",
)
_DEFAULT_CONTEXT_SIZE = 128_000
_DEFAULT_OUTPUT_SIZE = 16_384


def _secret_value(value: Any) -> str | None:
    """Extract a stored secret without assuming one serialization shape."""
    if value is None:
        return None
    if hasattr(value, "get_secret_value"):
        return str(value.get_secret_value())
    if isinstance(value, dict):
        value = value.get("value") or value.get("_secret_value")
    return str(value) if value else None


async def _fetch_remote_models(
    credential_data: dict[str, Any],
) -> list[dict[str, Any]] | None:
    """Fetch ``/models``; ``None`` means unavailable, while ``[]`` is valid."""
    if credential_data.get("type") != "openai_credential":
        return None
    base_url = credential_data.get("base_url")
    api_key = _secret_value(credential_data.get("api_key"))
    if not base_url or not api_key:
        return None

    url = str(base_url).rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
            response = await client.get(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Accept": "application/json",
                },
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return None

    data = payload.get("data", []) if isinstance(payload, dict) else []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def _model_id(item: dict[str, Any]) -> str | None:
    value = item.get("id")
    return str(value) if value else None


def _endpoint_types(item: dict[str, Any]) -> set[str]:
    values = item.get("supported_endpoint_types")
    if not isinstance(values, list):
        values = item.get("endpoint_types")
    if not isinstance(values, list):
        return set()
    return {str(value).lower() for value in values}


def _supports_tts(item: dict[str, Any]) -> bool:
    endpoint_types = _endpoint_types(item)
    if endpoint_types & _TTS_ENDPOINT_TYPES:
        return True
    model_id = _model_id(item)
    return bool(model_id and _TTS_NAME_PATTERN.search(model_id.lower()))


def _supports_embedding(item: dict[str, Any]) -> bool:
    endpoint_types = _endpoint_types(item)
    if endpoint_types & _EMBEDDING_ENDPOINT_TYPES:
        return True
    model_id = _model_id(item)
    return bool(
        model_id and _EMBEDDING_NAME_PATTERN.search(model_id.lower()),
    )


def _parameter_schema(parameters: Type[BaseModel]) -> dict[str, Any]:
    schema = parameters.model_json_schema()
    return {
        "type": "object",
        "properties": schema.get("properties", {}),
        "required": schema.get("required", []),
    }


def _metadata_sources(item: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the model item and supported nested metadata containers."""
    sources = [item]
    for source in sources:
        for key in _MODEL_METADATA_KEYS:
            nested = source.get(key)
            if isinstance(nested, dict) and nested not in sources:
                sources.append(nested)
    return sources


def _as_positive_int(value: Any) -> int | None:
    """Normalize positive integer JSON values, including numeric strings."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        normalized = value.strip().replace("_", "")
        if normalized.isdecimal():
            parsed = int(normalized)
            return parsed if parsed > 0 else None
    return None


def _positive_int(item: dict[str, Any], keys: tuple[str, ...]) -> int | None:
    for source in _metadata_sources(item):
        for key in keys:
            value = _as_positive_int(source.get(key))
            if value is not None:
                return value
    return None


def _chat_parameter_schema(
    model_cls: Type[ChatModelBase],
    output_size: int,
) -> dict[str, Any]:
    """Build a model-specific schema with the remote output-token limit."""
    schema = copy.deepcopy(model_cls.Parameters.model_json_schema())
    max_tokens = schema.get("properties", {}).get("max_tokens")
    if isinstance(max_tokens, dict):
        max_tokens["maximum"] = output_size
    return schema


async def list_remote_chat_models(
    credential_data: dict[str, Any],
    model_cls: Type[ChatModelBase],
) -> list[ModelCard] | None:
    """Return remote chat cards, or ``None`` when remote lookup failed."""
    items = await _fetch_remote_models(credential_data)
    if items is None:
        return None
    cards = []
    for item in items:
        model_id = _model_id(item)
        if model_id:
            context_size = (
                _positive_int(item, _CONTEXT_SIZE_KEYS)
                or _DEFAULT_CONTEXT_SIZE
            )
            output_size = (
                _positive_int(item, _OUTPUT_SIZE_KEYS)
                or _DEFAULT_OUTPUT_SIZE
            )
            cards.append(
                ModelCard(
                    name=model_id,
                    label=model_id,
                    status="active",
                    context_size=context_size,
                    output_size=output_size,
                    parameter_schema=_chat_parameter_schema(
                        model_cls,
                        output_size,
                    ),
                    parameters_overrides={},
                ),
            )
    return cards


async def list_remote_tts_models(
    credential_data: dict[str, Any],
    tts_classes: list[Type[TTSModelBase]],
) -> list[TTSModelCard] | None:
    """Return remote TTS cards, preserving known local card metadata."""
    items = await _fetch_remote_models(credential_data)
    if items is None:
        return None

    local_cards: dict[str, TTSModelCard] = {}
    card_classes: dict[str, Type[TTSModelBase]] = {}
    for tts_cls in tts_classes:
        for card in tts_cls.list_models():
            local_cards[card.name] = card
            card_classes[card.name] = tts_cls

    fallback_cls = tts_classes[0] if tts_classes else None
    cards: list[TTSModelCard] = []
    for item in items:
        if not _supports_tts(item):
            continue
        model_id = _model_id(item)
        if not model_id:
            continue
        if model_id in local_cards:
            cards.append(local_cards[model_id])
            continue
        tts_cls = card_classes.get(model_id, fallback_cls)
        if tts_cls is None:
            continue
        cards.append(
            TTSModelCard(
                name=model_id,
                label=model_id,
                realtime=tts_cls.realtime,
                parameter_schema=_parameter_schema(tts_cls.Parameters),
                parameters_overrides={},
            ),
        )
    return cards


async def list_remote_embedding_models(
    credential_data: dict[str, Any],
    embedding_cls: Type[EmbeddingModelBase],
) -> list[EmbeddingModelCard] | None:
    """Return remote embedding cards, preserving known dimension metadata."""
    items = await _fetch_remote_models(credential_data)
    if items is None:
        return None

    local_cards = {card.name: card for card in embedding_cls.list_models()}
    cards: list[EmbeddingModelCard] = []
    for item in items:
        if not _supports_embedding(item):
            continue
        model_id = _model_id(item)
        if not model_id:
            continue
        if model_id in local_cards:
            cards.append(local_cards[model_id])
            continue

        dimensions = _positive_int(item, _DIMENSION_KEYS)
        if dimensions is None:
            # The embedding contract requires an exact vector dimension.
            # Do not publish a card that would create an invalid collection.
            continue
        cards.append(
            EmbeddingModelCard(
                name=model_id,
                label=model_id,
                dimensions=dimensions,
                context_size=_positive_int(item, _CONTEXT_SIZE_KEYS),
                parameter_schema=_parameter_schema(
                    embedding_cls.Parameters,
                ),
                parameters_overrides={},
            ),
        )
    return cards
