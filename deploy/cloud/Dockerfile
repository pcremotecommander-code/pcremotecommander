# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS build
ARG TARGETARCH
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements-linux.lock pyproject.toml ./
COPY src ./src
COPY deploy/cloud/download_tunnel.py /build/download_tunnel.py
RUN python -m venv /opt/venv \
 && /opt/venv/bin/python -m pip install 'pip==26.2.1' 'setuptools==84.1.0' 'wheel==0.48.0' \
 && /opt/venv/bin/python -m pip install --require-hashes -r requirements-linux.lock \
 && /opt/venv/bin/python -m pip install --no-deps --no-build-isolation . \
 && python download_tunnel.py "$TARGETARCH" /opt/tunnel

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
RUN python -m pip install --no-cache-dir 'pip==26.2.1'
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin jan \
 && mkdir -p /workspace /state /opt/jan \
 && chown 10001:10001 /workspace /state \
 && chmod 0700 /state \
 && touch /state/.initialized && chown 10001:10001 /state/.initialized
COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/tunnel /opt/tunnel
COPY deploy/cloud/entrypoint.py deploy/cloud/healthcheck.py /opt/jan/
ENV PATH=/opt/venv/bin:/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    JAN_MCP_WORKSPACE=/workspace JAN_MCP_STATE_DIR=/state JAN_MCP_ALLOW_WRITES=0 HOME=/tmp/jan-home
USER 10001:10001
WORKDIR /workspace
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD ["/opt/venv/bin/python", "/opt/jan/healthcheck.py"]
ENTRYPOINT ["/opt/venv/bin/python", "/opt/jan/entrypoint.py"]
