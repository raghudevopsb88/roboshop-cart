FROM docker.io/library/node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js .

FROM docker.io/redhat/ubi9:latest
RUN curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - \
    && dnf install -y nodejs \
    && dnf clean all
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js .
COPY run.sh /run.sh
RUN chmod +x /run.sh
EXPOSE 8080
ENTRYPOINT ["bash", "/run.sh"]
