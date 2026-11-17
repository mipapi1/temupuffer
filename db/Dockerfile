# One image for both temupuffer processes. The command picks the role:
#   query node: python -m server.main    (default)
#   indexer:    python -m indexer.main
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    CACHE_DIR=/cache

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY temupuffer ./temupuffer
COPY server ./server
COPY indexer ./indexer

# Run as an unprivileged user. /cache is the node cache (an emptyDir in K8s,
# standing in for turbopuffer's NVMe tier).
RUN useradd --uid 10001 --no-create-home app && mkdir -p /cache && chown app /cache
USER 10001

EXPOSE 8080 8081
CMD ["python", "-m", "server.main"]
