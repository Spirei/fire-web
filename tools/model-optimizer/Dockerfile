FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 libgl1 libgomp1 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /opt/ktx && curl -fL --retry 3 \
  https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.tar.bz2 -o /tmp/ktx.tar.bz2 \
  && echo 'a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245  /tmp/ktx.tar.bz2' | sha256sum -c - \
  && tar -xjf /tmp/ktx.tar.bz2 -C /opt/ktx --strip-components=1 \
  && rm /tmp/ktx.tar.bz2
ENV PATH="/opt/ktx/bin:${PATH}" LD_LIBRARY_PATH=/opt/ktx/lib FIRE_SHOWCASE_DIR=/app/public/uploads/mclaren
USER node
CMD ["node", "online-worker.mjs"]
