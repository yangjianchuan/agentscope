# Repository Guidelines

## Project Structure & Module Organization

Python source lives under `src/agentscope/`, grouped by capability such as `agent/`, `app/`, `model/`, `tool/`, `rag/`, and `workspace/`. Unit and integration tests live in `tests/` and generally mirror source areas. Runnable demonstrations are under `examples/`; the React/Vite application is in `examples/web_ui/frontend/`, with its companion backend in `examples/web_ui/backend/`. Documentation, images, automation, and CI configuration are kept in `docs/`, `assets/`, `scripts/`, and `.github/` respectively.

## Build, Test, and Development Commands

- `uv pip install -e ".[dev]"`: install AgentScope and the complete development toolchain (Python 3.11+).
- `pre-commit install`: enable repository formatting, lint, type, and safety checks locally.
- `pre-commit run --all-files`: run Black, Flake8, Pylint, mypy, and repository hygiene checks.
- `pytest tests`: run the Python test suite. Use a focused target while iterating, for example `pytest tests/workspace_local_test.py -q`.
- `cd examples/web_ui && pnpm install`: install Web UI dependencies.
- `pnpm dev`: start the Web UI frontend and backend together.
- `pnpm build`: type-check and build both Web UI packages.
- `pnpm format:check`: verify Prettier and ESLint formatting.

## Coding Style & Naming Conventions

Python uses four-space indentation, Black with a 79-character line limit, type annotations, and Google-style docstrings. Follow existing module naming: lowercase `snake_case` files and functions, `PascalCase` classes, and private modules prefixed with `_` where appropriate. Keep optional dependencies lazily imported. TypeScript and TSX are formatted by Prettier and checked by ESLint; preserve the existing tab-based formatting and use `PascalCase` for React components and `useCamelCase` for hooks.

## Testing Guidelines

Use `pytest`; test files follow `*_test.py`, classes commonly use `Test...`, and test functions use `test_...`. Add focused regression coverage beside every behavior change. CI runs tests with coverage across Linux, Windows, and macOS; no fixed coverage percentage is documented, so prioritize meaningful branch and failure-path coverage.

## Commit & Pull Request Guidelines

Use Conventional Commits: `<type>(<lowercase-scope>): <lowercase description>`, for example `fix(formatter): preserve history marker`. Common types include `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, and `chore`. Keep commits narrowly scoped. PRs should link an existing issue, explain background and behavior changes, describe verification steps, update related documentation, and include screenshots for visible UI changes. Ensure pre-commit, type checks, builds, and relevant tests pass before requesting review.
