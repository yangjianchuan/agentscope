# -*- coding: utf-8 -*-
"""Tests for custom OpenAI-compatible model catalogue discovery."""
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from agentscope.app._service._model_catalog import (
    list_remote_chat_models,
    list_remote_embedding_models,
    list_remote_tts_models,
)
from agentscope.embedding import OpenAIEmbeddingModel
from agentscope.model import OpenAIChatModel
from agentscope.tts import OpenAITTSModel


_CREDENTIAL = {
    "type": "openai_credential",
    "api_key": "test-key",
    "base_url": "https://example.test/v1",
}


class RemoteModelCatalogTest(IsolatedAsyncioTestCase):
    """Verify capability filtering and model-card projection."""

    @patch(
        "agentscope.app._service._model_catalog._fetch_remote_models",
        new_callable=AsyncMock,
    )
    async def test_chat_limits_use_remote_metadata_with_fallbacks(
        self,
        fetch: AsyncMock,
    ) -> None:
        """Remote limits win independently; missing values use defaults."""
        fetch.return_value = [
            {
                "id": "vendor-top-level",
                "context_length": 200_000,
                "max_output_tokens": 32_000,
            },
            {
                "id": "vendor-nested",
                "capabilities": {"context_window": "65_536"},
                "limits": {"max_completion_tokens": "8192"},
            },
            {
                "id": "vendor-partial",
                "output_size": 4096,
            },
            {
                "id": "vendor-invalid",
                "context_size": True,
                "max_output_tokens": 0,
            },
        ]

        models = await list_remote_chat_models(
            _CREDENTIAL,
            OpenAIChatModel,
        )

        self.assertIsNotNone(models)
        assert models is not None
        self.assertEqual(
            [
                (card.name, card.context_size, card.output_size)
                for card in models
            ],
            [
                ("vendor-top-level", 200_000, 32_000),
                ("vendor-nested", 65_536, 8192),
                ("vendor-partial", 128_000, 4096),
                ("vendor-invalid", 128_000, 16_384),
            ],
        )
        self.assertEqual(
            models[0].parameter_schema["properties"]["max_tokens"]["maximum"],
            32_000,
        )
        self.assertEqual(
            models[2].parameter_schema["properties"]["max_tokens"]["maximum"],
            4096,
        )

    @patch(
        "agentscope.app._service._model_catalog._fetch_remote_models",
        new_callable=AsyncMock,
    )
    async def test_llm_only_catalog_does_not_fall_back_to_defaults(
        self,
        fetch: AsyncMock,
    ) -> None:
        """A successful remote lookup with no TTS/embedding returns empty."""
        fetch.return_value = [
            {
                "id": "gpt-custom",
                "supported_endpoint_types": ["openai"],
            },
        ]

        tts = await list_remote_tts_models(
            _CREDENTIAL,
            [OpenAITTSModel],
        )
        embeddings = await list_remote_embedding_models(
            _CREDENTIAL,
            OpenAIEmbeddingModel,
        )

        self.assertEqual(tts, [])
        self.assertEqual(embeddings, [])

    @patch(
        "agentscope.app._service._model_catalog._fetch_remote_models",
        new_callable=AsyncMock,
    )
    async def test_known_remote_models_reuse_local_cards(
        self,
        fetch: AsyncMock,
    ) -> None:
        """Known remote IDs retain voices and dimension metadata."""
        fetch.return_value = [
            {"id": "gpt-4o-mini-tts"},
            {
                "id": "text-embedding-3-small",
                "supported_endpoint_types": ["embeddings"],
            },
        ]

        tts = await list_remote_tts_models(
            _CREDENTIAL,
            [OpenAITTSModel],
        )
        embeddings = await list_remote_embedding_models(
            _CREDENTIAL,
            OpenAIEmbeddingModel,
        )

        self.assertEqual(
            [card.name for card in tts],
            ["gpt-4o-mini-tts"],
        )
        self.assertEqual(
            tts[0].parameter_schema["properties"]["voice"]["default"],
            "alloy",
        )
        self.assertEqual(
            [card.name for card in embeddings],
            ["text-embedding-3-small"],
        )
        self.assertEqual(embeddings[0].dimensions, 1536)

    @patch(
        "agentscope.app._service._model_catalog._fetch_remote_models",
        new_callable=AsyncMock,
    )
    async def test_unknown_embedding_requires_remote_dimension(
        self,
        fetch: AsyncMock,
    ) -> None:
        """Unknown embedding models are published only with dimensions."""
        fetch.return_value = [
            {
                "id": "vendor-embedding-v1",
                "supported_endpoint_types": ["embeddings"],
                "dimensions": 1024,
                "context_length": 8192,
            },
            {
                "id": "vendor-embedding-without-dimension",
                "supported_endpoint_types": ["embeddings"],
            },
        ]

        embeddings = await list_remote_embedding_models(
            _CREDENTIAL,
            OpenAIEmbeddingModel,
        )

        self.assertEqual(
            [card.name for card in embeddings],
            ["vendor-embedding-v1"],
        )
        self.assertEqual(embeddings[0].dimensions, 1024)
        self.assertEqual(embeddings[0].context_size, 8192)

    @patch(
        "agentscope.app._service._model_catalog._fetch_remote_models",
        new_callable=AsyncMock,
    )
    async def test_remote_failure_keeps_fallback_available(
        self,
        fetch: AsyncMock,
    ) -> None:
        """``None`` distinguishes transport failure from an empty catalog."""
        fetch.return_value = None

        self.assertIsNone(
            await list_remote_tts_models(
                _CREDENTIAL,
                [OpenAITTSModel],
            ),
        )
        self.assertIsNone(
            await list_remote_embedding_models(
                _CREDENTIAL,
                OpenAIEmbeddingModel,
            ),
        )
