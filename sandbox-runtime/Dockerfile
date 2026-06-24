FROM docker.io/cloudflare/sandbox:0.12.1

LABEL org.opencontainers.image.source="https://github.com/anishthite/board" \
      org.opencontainers.image.description="Board Cloudflare Sandbox runtime with baked pi dependencies"

WORKDIR /workspace/board-sandbox-runtime

COPY VERSION.txt package.json pi-runner.js ./

RUN npm install --silent --ignore-scripts \
 && mkdir -p /root/.pi/agent /root/.pi/sessions
