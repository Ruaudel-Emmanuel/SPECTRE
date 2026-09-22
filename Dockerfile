FROM node:22-alpine
RUN apk add --no-cache poppler-utils
WORKDIR /app
COPY app/ /app/
EXPOSE 8087
CMD ["node", "/app/server.js"]