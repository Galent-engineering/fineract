# Base pinned by digest (python:3.12-slim); dependencies come from uv.lock, so one commit builds one image.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
RUN pip install uv==0.8.11
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY harness_traffic ./harness_traffic
RUN uv sync --frozen --no-dev && chmod -R a+rX /app
ENV PATH="/app/.venv/bin:$PATH"
USER nobody
# Traffic generator by default; the seed task overrides the command (python -m harness_traffic.seed).
CMD ["python", "-m", "harness_traffic.run"]
