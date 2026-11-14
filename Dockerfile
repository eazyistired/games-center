FROM python:3.12-slim

# set by CI: shown in Admin -> Dashboard and /api/health
ARG BUILD_SHA=dev
ARG BUILD_DATE=

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data \
    PORT=8080 \
    BUILD_SHA=${BUILD_SHA} \
    BUILD_DATE=${BUILD_DATE}

WORKDIR /app

# TrueNAS SCALE runs apps as the built-in "apps" user (568:568)
RUN groupadd --gid 568 apps && useradd --uid 568 --gid 568 --no-create-home --shell /usr/sbin/nologin apps

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY web ./web
COPY games ./games

RUN mkdir -p /data && chown 568:568 /data
VOLUME ["/data"]
USER 568:568
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/health', timeout=4)" || exit 1

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
