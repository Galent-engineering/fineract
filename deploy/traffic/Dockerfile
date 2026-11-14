FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY pyproject.toml ./
COPY harness_traffic ./harness_traffic
RUN pip install .
USER nobody
# Traffic generator by default; the seed task overrides the command (python -m harness_traffic.seed).
CMD ["python", "-m", "harness_traffic.run"]
