FROM node:20-alpine

# Run as a non-root user to limit blast radius of a container escape.
# The Docker socket is still mounted from docker-compose — see SECURITY note there.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /data && chown appuser:appgroup /data

USER appuser

EXPOSE 3000

CMD ["node", "src/server.js"]
