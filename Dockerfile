FROM node:24-bookworm-slim

ARG BUN_VERSION=1.3.12
ARG CODEX_VERSION=0.135.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gh git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "bun@${BUN_VERSION}" "@openai/codex@${CODEX_VERSION}"

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY generated ./generated

RUN useradd --create-home --home-dir /home/tetherbox --shell /usr/sbin/nologin tetherbox \
  && mkdir -p /var/lib/tetherbox /home/tetherbox/.codex /home/tetherbox/.ssh \
  && chown -R tetherbox:tetherbox /app /var/lib/tetherbox /home/tetherbox/.codex /home/tetherbox/.ssh

USER tetherbox

ENV HOME=/home/tetherbox
ENV TETHERBOX_CONFIG=/config/config.json

EXPOSE 8787

CMD ["sh", "-lc", "exec bun run src/index.ts daemon --config \"$TETHERBOX_CONFIG\""]
