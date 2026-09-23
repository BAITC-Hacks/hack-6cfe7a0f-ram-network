FROM node:24-alpine
WORKDIR /app
COPY . .
USER node
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "assistant/server.mjs"]
