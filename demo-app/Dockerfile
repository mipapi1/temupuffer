# One image for the Python side of temupuffer search. The command picks the role:
#   search API:   uvicorn search.api:app --port 8090             (default)
#   embedder:     uvicorn search.embedder_service:app --port 8091
#   ingest jobs:  python -m search.ingest embed|load|cleanup
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    FASTEMBED_CACHE_PATH=/models \
    HOME=/tmp

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Bake the model (~90 MB) into the image: pods start without downloading it,
# and nothing at runtime needs Hugging Face for the model.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('sentence-transformers/all-MiniLM-L6-v2')" \
    && chmod -R a+rX /models
ENV HF_HUB_OFFLINE=1

COPY search ./search

RUN useradd --uid 10001 --no-create-home app
USER 10001
EXPOSE 8090 8091
CMD ["uvicorn", "search.api:app", "--host", "0.0.0.0", "--port", "8090"]
